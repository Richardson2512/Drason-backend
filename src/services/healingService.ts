/**
 * Healing Service
 * 
 * Implements Section 5 (Behavioral Healing) of the Diagnosis & Healing Plan.
 * 
 * Core responsibilities:
 *   1. Graduated recovery through 5 phases (no binary jumps)
 *   2. Graduation criteria enforcement per phase transition
 *   3. Resilience score management (healing speed multipliers)
 *   4. Relapse detection and escalating penalties
 *   5. Rehab vs Recovery origin-aware healing
 *   6. Phase 0→1 Transition Gate
 */

import { prisma } from '../index';
import {
    RecoveryPhase,
    HealingOrigin,
    GRADUATION_CRITERIA,
    TriggerType,
    MONITORING_THRESHOLDS,
} from '../types';
import * as auditLogService from './auditLogService';
import * as notificationService from './notificationService';
import * as entityStateService from './entityStateService';
import * as warmupService from './warmupService';
import { MailboxState, DomainState } from '../types';
import { SlackAlertService } from './SlackAlertService';
import { assessDomainDNS } from './infrastructureAssessmentService';
import logger from '../utils/logger';
import * as webhookBus from './webhookEventBus';

// ============================================================================
// TYPES
// ============================================================================

interface PhaseTransitionResult {
    transitioned: boolean;
    fromPhase: string;
    toPhase: string;
    reason: string;
    resilienceScore: number;
}

interface ResilienceAdjustment {
    adjustment: number;
    reason: string;
    newScore: number;
}

// ============================================================================
// RESILIENCE SCORE MANAGEMENT (Section 5.5)
// ============================================================================

const RESILIENCE_ADJUSTMENTS = {
    PAUSE: -15,
    GRADUATION: +10,
    RELAPSE: -25,
    STABLE_7_DAYS: +5,
    REHAB_STARTING_SCORE: 40,
    DEFAULT_STARTING_SCORE: 50,
    MIN_SCORE: 0,
    MAX_SCORE: 100,
} as const;

// ============================================================================
// HARD FLOOR — TRANSITION GATE SAFETY
// ============================================================================

/**
 * HARD FLOOR: Below this infrastructure score, acknowledgment is IMPOSSIBLE.
 * Infrastructure below 25/100 means critical DNS/blacklist failures.
 * Sending through this would permanently damage the domain.
 */
const TRANSITION_HARD_FLOOR = 25;

// ============================================================================
// AGGREGATE THROTTLE CAPS
// ============================================================================

/** Max total sends per domain per day when any mailbox is recovering */
const DOMAIN_RECOVERY_CAP = 30;

/** Max total sends per org per day when any entity is recovering */
const ORG_RECOVERY_CAP = 100;

/**
 * Get the healing speed multiplier based on resilience score.
 * Lower resilience = slower healing.
 */
export function getHealingMultiplier(resilienceScore: number): { sendMultiplier: number; timeMultiplier: number } {
    if (resilienceScore <= 30) {
        return { sendMultiplier: 2.0, timeMultiplier: 1.5 };  // Slow healing
    } else if (resilienceScore <= 70) {
        return { sendMultiplier: 1.0, timeMultiplier: 1.0 };  // Normal
    } else {
        return { sendMultiplier: 0.75, timeMultiplier: 0.75 }; // Fast healing
    }
}

/**
 * Adjust resilience score and clamp to [0, 100].
 */
function adjustResilienceScore(
    currentScore: number,
    adjustment: number,
    reason: string
): ResilienceAdjustment {
    const newScore = Math.max(
        RESILIENCE_ADJUSTMENTS.MIN_SCORE,
        Math.min(RESILIENCE_ADJUSTMENTS.MAX_SCORE, currentScore + adjustment)
    );
    return { adjustment, reason, newScore };
}

// ============================================================================
// GRADUATION CHECKS (Section 5.3)
// ============================================================================

/**
 * Check if a mailbox should graduate to its next recovery phase.
 * Called periodically by the metrics worker.
 */
export async function checkMailboxGraduation(mailboxId: string): Promise<PhaseTransitionResult | null> {
    const mailbox = await prisma.mailbox.findUnique({
        where: { id: mailboxId },
        include: { domain: true },
    });
    if (!mailbox) return null;

    const currentPhase = mailbox.recovery_phase as RecoveryPhase;
    const isRehab = mailbox.healing_origin === HealingOrigin.REHAB;
    const now = new Date();

    switch (currentPhase) {
        case RecoveryPhase.PAUSED:
            return checkPausedToQuarantine(mailbox, now);

        case RecoveryPhase.QUARANTINE:
            return checkQuarantineToRestricted(mailbox);

        case RecoveryPhase.RESTRICTED_SEND:
            return checkRestrictedToWarm(mailbox, isRehab);

        case RecoveryPhase.WARM_RECOVERY:
            return checkWarmToHealthy(mailbox, isRehab, now);

        default:
            return null; // Already healthy or warning — no graduation path
    }
}

/**
 * Paused → Quarantine: Cooldown timer must expire.
 */
async function checkPausedToQuarantine(
    mailbox: any,
    now: Date
): Promise<PhaseTransitionResult | null> {
    if (!mailbox.cooldown_until || now < mailbox.cooldown_until) {
        return null; // Cooldown has not expired
    }

    const result = await transitionPhase(
        'mailbox',
        mailbox.id,
        mailbox.organization_id,
        RecoveryPhase.PAUSED,
        RecoveryPhase.QUARANTINE,
        'Cooldown expired — entering quarantine (no sending)',
        mailbox.resilience_score
    );
    return result;
}

/**
 * Quarantine → Restricted Send: DNS/blacklist must pass.
 *
 * Manual-intervention gate: blocks graduation when an operator has flagged
 * the mailbox or its parent domain.
 *
 * DNS fail-closed: if the live DNS check throws, the graduation is deferred
 * (not promoted on cached data). After DNS_CHECK_FAILURE_ESCALATE_COUNT
 * consecutive failures, the domain is escalated to manual intervention.
 */
async function checkQuarantineToRestricted(
    mailbox: any
): Promise<PhaseTransitionResult | null> {
    // Manual-intervention gate
    if (mailbox.manual_intervention_required) {
        return null;
    }

    // Re-check domain DNS health
    const domain = await prisma.domain.findUnique({
        where: { id: mailbox.domain_id },
    });
    if (!domain) return null;

    // Domain-level manual-intervention gate
    if (domain.manual_intervention_required) {
        return null;
    }

    // DNS-failure backoff with jitter: if a recent attempt failed, wait at
    // least DNS_CHECK_FAILURE_DEFER_MS (± 20% jitter) before retrying.
    // Jitter is keyed on domain.id so each domain has a stable but distinct
    // backoff window — prevents the thundering-herd retry pattern when many
    // domains queue up against the same DNS service.
    if (domain.dns_check_failure_count > 0 && domain.last_dns_check_attempt_at) {
        const baseDeferMs = MONITORING_THRESHOLDS.DNS_CHECK_FAILURE_DEFER_MS;
        // Stable jitter: derive a value in [-0.2, +0.2] from the domain UUID.
        // hashCode-style: sum char codes, mod into range. Deterministic per domain.
        let h = 0;
        for (let i = 0; i < domain.id.length; i++) h = ((h << 5) - h + domain.id.charCodeAt(i)) | 0;
        const jitterFraction = ((h % 1000) / 1000) * 0.4 - 0.2; // [-0.2, +0.2]
        const deferMs = Math.floor(baseDeferMs * (1 + jitterFraction));
        const elapsed = Date.now() - new Date(domain.last_dns_check_attempt_at).getTime();
        if (elapsed < deferMs) {
            logger.info('[HEALING] DNS check deferred (recent failure backoff)', {
                domainId: domain.id,
                failureCount: domain.dns_check_failure_count,
                elapsedMs: elapsed,
                deferMs,
            });
            return null;
        }
    }

    // Trigger live DNS check before graduation attempt.
    // FAIL-CLOSED: on exception, increment failure counter and defer; do not
    // proceed on cached values. After DNS_CHECK_FAILURE_ESCALATE_COUNT
    // consecutive failures, escalate to manual intervention.
    let dnsCheckSucceeded = false;
    try {
        const dnsResult = await assessDomainDNS(domain.domain, domain.id);
        await prisma.domain.update({
            where: { id: domain.id },
            data: {
                spf_valid: dnsResult.spfValid,
                dkim_valid: dnsResult.dkimValid,
                dmarc_policy: dnsResult.dmarcPolicy,
                mx_records: dnsResult.mxRecords,
                mx_valid: dnsResult.mxValid,
                dns_checked_at: new Date(),
                dns_check_failure_count: 0, // Reset on success
                last_dns_check_attempt_at: new Date(),
            },
        });
        dnsCheckSucceeded = true;
    } catch (err: any) {
        const newFailureCount = (domain.dns_check_failure_count || 0) + 1;
        const escalate = newFailureCount >= MONITORING_THRESHOLDS.DNS_CHECK_FAILURE_ESCALATE_COUNT;

        await prisma.domain.update({
            where: { id: domain.id },
            data: {
                dns_check_failure_count: newFailureCount,
                last_dns_check_attempt_at: new Date(),
                ...(escalate && {
                    manual_intervention_required: true,
                    manual_intervention_reason: `DNS check failed ${newFailureCount} consecutive times — operator review required`,
                    manual_intervention_set_at: new Date(),
                }),
            },
        });

        logger.warn('[HEALING] Live DNS check failed — fail-closed (deferring graduation)', {
            domainId: domain.id,
            domain: domain.domain,
            failureCount: newFailureCount,
            escalated: escalate,
            error: err?.message,
        });

        if (escalate) {
            try {
                await notificationService.createNotification(mailbox.organization_id, {
                    type: 'ERROR',
                    title: 'Domain Escalated — Manual Intervention Required',
                    message: `Domain ${domain.domain} has had ${newFailureCount} consecutive DNS check failures during graduation. Operator review required to proceed.`,
                });
            } catch { /* non-fatal */ }
        }
        return null; // Fail-closed: do not promote
    }

    // Re-read domain with fresh data (only when DNS check succeeded)
    if (!dnsCheckSucceeded) return null;

    const freshDomain = await prisma.domain.findUnique({
        where: { id: domain.id },
    });
    if (!freshDomain) return null;

    // DNS must be healthy — no blacklists, SPF/DKIM present
    const dnsHealthy = freshDomain.spf_valid === true
        && freshDomain.dkim_valid === true
        && !isBlacklisted(freshDomain.blacklist_results);

    if (!dnsHealthy) {
        return null; // Cannot promote until DNS is clean
    }

    const result = await transitionPhase(
        'mailbox',
        mailbox.id,
        mailbox.organization_id,
        RecoveryPhase.QUARANTINE,
        RecoveryPhase.RESTRICTED_SEND,
        'DNS checks passed — entering restricted send mode',
        mailbox.resilience_score
    );
    return result;
}

/**
 * Restricted Send → Warm Recovery.
 * Delegates to warmupService.checkGraduationCriteria as the single source of
 * truth for phase-scoped graduation (SendEvent/BounceEvent counts since
 * phase_entered_at, time-in-phase floor, manual-intervention gate).
 *
 * The legacy isRehab/clean_sends_since_phase logic is no longer used here —
 * warmupService handles those conditions consistently across both phases.
 */
async function checkRestrictedToWarm(
    mailbox: any,
    _isRehab: boolean
): Promise<PhaseTransitionResult | null> {
    const criteria = await warmupService.checkGraduationCriteria(mailbox.id);
    if (!criteria.readyForGraduation) return null;

    return transitionPhase(
        'mailbox',
        mailbox.id,
        mailbox.organization_id,
        RecoveryPhase.RESTRICTED_SEND,
        RecoveryPhase.WARM_RECOVERY,
        `Graduation criteria met: ${criteria.reason}`,
        mailbox.resilience_score
    );
}

/**
 * Warm Recovery → Healthy.
 * Delegates to warmupService.checkGraduationCriteria. Bounce-rate and
 * complaint-rate gates are enforced inside warmupService — see
 * GRADUATION_CRITERIA.warm_to_healthy.
 */
async function checkWarmToHealthy(
    mailbox: any,
    _isRehab: boolean,
    _now: Date
): Promise<PhaseTransitionResult | null> {
    const criteria = await warmupService.checkGraduationCriteria(mailbox.id);
    if (!criteria.readyForGraduation) return null;

    // Graduate to healthy + resilience bonus + reset offense counters
    const resAdj = adjustResilienceScore(
        mailbox.resilience_score,
        RESILIENCE_ADJUSTMENTS.GRADUATION,
        'Graduated to healthy'
    );

    await prisma.mailbox.update({
        where: { id: mailbox.id },
        data: {
            resilience_score: resAdj.newScore,
            healing_origin: null,         // Clear healing origin
            relapse_count: 0,             // Reset on full recovery
            consecutive_pauses: 0,        // Reset offense counter — fix for healing-pipeline leak
            consecutive_pauses_decayed_at: null,
        },
    });

    return transitionPhase(
        'mailbox',
        mailbox.id,
        mailbox.organization_id,
        RecoveryPhase.WARM_RECOVERY,
        RecoveryPhase.HEALTHY,
        `Recovery complete: ${criteria.reason}`,
        resAdj.newScore
    );
}

// ============================================================================
// RELAPSE HANDLING (Section 5.6)
// ============================================================================

/**
 * Handle a relapse — entity was recovering but degraded again.
 * Returns the target phase after relapse penalties are applied.
 */
export async function handleRelapse(
    entityType: 'mailbox' | 'domain',
    entityId: string,
    organizationId: string,
    currentPhase: RecoveryPhase,
    reason: string
): Promise<PhaseTransitionResult> {
    const entity = entityType === 'mailbox'
        ? await prisma.mailbox.findUnique({ where: { id: entityId } })
        : await prisma.domain.findUnique({ where: { id: entityId } });

    if (!entity) {
        return { transitioned: false, fromPhase: currentPhase, toPhase: currentPhase, reason: 'Entity not found', resilienceScore: 0 };
    }

    const relapseCount = (entity.relapse_count || 0) + 1;

    // Apply resilience penalty
    const resAdj = adjustResilienceScore(
        entity.resilience_score || 50,
        RESILIENCE_ADJUSTMENTS.RELAPSE,
        `Relapse #${relapseCount}`
    );

    // Determine relapse target and cooldown
    let targetPhase: RecoveryPhase;
    let cooldownMs: number;
    const baseCooldown = GRADUATION_CRITERIA.paused_to_quarantine;

    const requiresManualIntervention = relapseCount >= 3;

    if (relapseCount >= 3) {
        // Third+ relapse: full pause, longest cooldown, manual intervention required
        targetPhase = RecoveryPhase.PAUSED;
        cooldownMs = baseCooldown.thirdPlusCooldownMs;
        reason = `RELAPSE #${relapseCount}: ${reason}. Manual intervention required.`;
    } else if (relapseCount === 2) {
        // Second relapse: full pause, medium cooldown
        targetPhase = RecoveryPhase.PAUSED;
        cooldownMs = baseCooldown.repeatCooldownMs;
        reason = `RELAPSE #${relapseCount}: ${reason}`;
    } else {
        // First relapse: back to quarantine with doubled cooldown
        targetPhase = RecoveryPhase.QUARANTINE;
        cooldownMs = baseCooldown.firstOffenseCooldownMs * 2;
        reason = `RELAPSE #${relapseCount}: ${reason}`;
    }

    // Determine target status from recovery phase
    const targetStatus = targetPhase === RecoveryPhase.PAUSED ? 'paused' : targetPhase;

    // Update status via state machine (setInitial bypasses validation for healing phase jumps)
    if (entityType === 'mailbox') {
        await entityStateService.setInitialMailboxStatus(
            organizationId, entityId, targetStatus as MailboxState,
            `Relapse #${relapseCount}: ${reason}`, TriggerType.THRESHOLD_BREACH
        );
        // Set operational fields (status already handled above)
        await prisma.mailbox.update({
            where: { id: entityId },
            data: {
                relapse_count: relapseCount,
                resilience_score: resAdj.newScore,
                recovery_phase: targetPhase,
                phase_entered_at: new Date(),
                clean_sends_since_phase: 0,
                healing_origin: entity.healing_origin || HealingOrigin.RECOVERY,
                cooldown_until: new Date(Date.now() + cooldownMs),
                ...(requiresManualIntervention && {
                    manual_intervention_required: true,
                    manual_intervention_reason: `Auto-flagged after ${relapseCount} relapses. Operator review required before further automated graduation.`,
                    manual_intervention_set_at: new Date(),
                }),
            }
        });
    } else {
        await entityStateService.setInitialDomainStatus(
            organizationId, entityId, targetStatus as DomainState,
            `Relapse #${relapseCount}: ${reason}`, TriggerType.THRESHOLD_BREACH
        );
        await prisma.domain.update({
            where: { id: entityId },
            data: {
                relapse_count: relapseCount,
                resilience_score: resAdj.newScore,
                recovery_phase: targetPhase,
                phase_entered_at: new Date(),
                clean_sends_since_phase: 0,
                healing_origin: entity.healing_origin || HealingOrigin.RECOVERY,
                cooldown_until: new Date(Date.now() + cooldownMs),
                ...(requiresManualIntervention && {
                    manual_intervention_required: true,
                    manual_intervention_reason: `Auto-flagged after ${relapseCount} relapses. Operator review required before further automated graduation.`,
                    manual_intervention_set_at: new Date(),
                }),
            }
        });
    }

    logger.warn(`[HEALING] Relapse for ${entityType} ${entityId}: ${reason}. New phase: ${targetPhase}, resilience: ${resAdj.newScore}`);

    // Notify user of relapse
    try {
        const severity = relapseCount >= 3 ? 'ERROR' as const : 'WARNING' as const;
        await notificationService.createNotification(organizationId, {
            type: severity,
            title: `${entityType === 'mailbox' ? 'Mailbox' : 'Domain'} Relapse #${relapseCount}`,
            message: `A ${entityType} relapsed during recovery and was moved to ${targetPhase}. ${relapseCount >= 3 ? 'Manual intervention required.' : 'Healing will restart automatically.'}`,
        });
    } catch (notifError) {
        logger.warn('Failed to create relapse notification', { entityId });
    }

    return {
        transitioned: true,
        fromPhase: currentPhase,
        toPhase: targetPhase,
        reason,
        resilienceScore: resAdj.newScore,
    };
}

// ============================================================================
// TRANSITION GATE (Section 3.5 — Phase 0 → Phase 1)
// ============================================================================

interface TransitionGateResult {
    canTransition: boolean;
    requiresAcknowledgment: boolean;
    overallScore: number;
    message: string;
}

/**
 * Check if the organization is ready to transition from Phase 0 to Phase 1.
 */
export async function checkTransitionGate(organizationId: string): Promise<TransitionGateResult> {
    const latestReport = await prisma.infrastructureReport.findFirst({
        where: { organization_id: organizationId },
        orderBy: { created_at: 'desc' },
    });

    if (!latestReport) {
        return {
            canTransition: false,
            requiresAcknowledgment: false,
            overallScore: 0,
            message: 'No infrastructure assessment has been performed yet.',
        };
    }

    const overallScore = latestReport.overall_score;
    const org = await prisma.organization.findUnique({ where: { id: organizationId } });

    if (overallScore >= 60) {
        // Auto-transition: score is healthy enough
        return {
            canTransition: true,
            requiresAcknowledgment: false,
            overallScore,
            message: `Infrastructure scored ${overallScore}/100. Safe to operate.`,
        };
    }

    // ── HARD FLOOR CHECK ──
    // Below TRANSITION_HARD_FLOOR, operator override is IMPOSSIBLE.
    // Infrastructure is too damaged to operate safely.
    if (overallScore > 0 && overallScore < TRANSITION_HARD_FLOOR) {
        logger.warn('[HEALING] Infrastructure below hard floor — no override possible', {
            organizationId,
            overallScore,
            hardFloor: TRANSITION_HARD_FLOOR,
        });
        return {
            canTransition: false,
            requiresAcknowledgment: false,
            overallScore,
            message: `Infrastructure scored ${overallScore}/100 — below the safety floor of ${TRANSITION_HARD_FLOOR}. Manual infrastructure repair required (fix SPF/DKIM/DMARC, resolve blacklistings). Operator override is not available at this level.`,
        };
    }

    if (overallScore >= TRANSITION_HARD_FLOOR && org?.transition_acknowledged) {
        // Previously acknowledged low score (but above hard floor)
        return {
            canTransition: true,
            requiresAcknowledgment: false,
            overallScore,
            message: `Infrastructure scored ${overallScore}/100. Operator previously acknowledged risks.`,
        };
    }

    if (overallScore >= TRANSITION_HARD_FLOOR) {
        // Low score but above hard floor, needs acknowledgment
        // Count paused entities for the message
        const pausedDomains = await prisma.domain.count({
            where: { organization_id: organizationId, status: 'paused' },
        });
        const totalDomains = await prisma.domain.count({
            where: { organization_id: organizationId },
        });
        const pausedMailboxes = await prisma.mailbox.count({
            where: { organization_id: organizationId, status: 'paused' },
        });
        const totalMailboxes = await prisma.mailbox.count({
            where: { organization_id: organizationId },
        });

        return {
            canTransition: false,
            requiresAcknowledgment: true,
            overallScore,
            message: `Infrastructure scored ${overallScore}/100. ${pausedDomains}/${totalDomains} domains and ${pausedMailboxes}/${totalMailboxes} mailboxes are paused. Operator acknowledgment required to proceed.`,
        };
    }

    // Score is 0 — everything paused
    return {
        canTransition: false,
        requiresAcknowledgment: false,
        overallScore: 0,
        message: 'All infrastructure is paused. Manual healing required before the system can operate.',
    };
}

/**
 * Acknowledge the transition gate for low-scoring assessments.
 */
export async function acknowledgeTransition(organizationId: string): Promise<boolean> {
    const gateResult = await checkTransitionGate(organizationId);

    // Hard floor check — reject below safety threshold
    if (gateResult.overallScore < TRANSITION_HARD_FLOOR) {
        logger.warn('[HEALING] Transition acknowledgment rejected — below hard floor', {
            organizationId,
            score: gateResult.overallScore,
            floor: TRANSITION_HARD_FLOOR,
        });
        return false;
    }

    if (!gateResult.requiresAcknowledgment) {
        return false; // Nothing to acknowledge
    }

    await prisma.organization.update({
        where: { id: organizationId },
        data: { transition_acknowledged: true },
    });

    await auditLogService.logAction({
        organizationId,
        entity: 'organization',
        entityId: organizationId,
        trigger: 'manual',
        action: 'transition_acknowledged',
        details: JSON.stringify({
            overallScore: gateResult.overallScore,
            message: gateResult.message,
        }),
    });

    logger.info(`[HEALING] Transition acknowledged for org ${organizationId} with score ${gateResult.overallScore}`);
    return true;
}

// ============================================================================
// RECORD CLEAN SEND (for graduation tracking)
// ============================================================================

/**
 * Record a clean send (no bounce) for graduation tracking.
 * Called after successful send confirmation.
 */
export async function recordCleanSend(
    entityType: 'mailbox' | 'domain',
    entityId: string
): Promise<void> {
    const recoveryPhases = [
        RecoveryPhase.RESTRICTED_SEND,
        RecoveryPhase.WARM_RECOVERY,
    ];

    if (entityType === 'mailbox') {
        const mailbox = await prisma.mailbox.findUnique({
            where: { id: entityId },
            select: { recovery_phase: true },
        });
        if (mailbox && recoveryPhases.includes(mailbox.recovery_phase as RecoveryPhase)) {
            await prisma.mailbox.update({
                where: { id: entityId },
                data: { clean_sends_since_phase: { increment: 1 } },
            });
        }
    } else {
        const domain = await prisma.domain.findUnique({
            where: { id: entityId },
            select: { recovery_phase: true },
        });
        if (domain && recoveryPhases.includes(domain.recovery_phase as RecoveryPhase)) {
            await prisma.domain.update({
                where: { id: entityId },
                data: { clean_sends_since_phase: { increment: 1 } },
            });
        }
    }
}

/**
 * Reset clean send counter — called when a health-degrading bounce occurs
 * during a recovery phase.
 */
export async function resetCleanSends(
    entityType: 'mailbox' | 'domain',
    entityId: string
): Promise<void> {
    if (entityType === 'mailbox') {
        await prisma.mailbox.update({
            where: { id: entityId },
            data: { clean_sends_since_phase: 0 },
        });
    } else {
        await prisma.domain.update({
            where: { id: entityId },
            data: { clean_sends_since_phase: 0 },
        });
    }
}

// ============================================================================
// SEND LIMITS PER RECOVERY PHASE
// ============================================================================

/**
 * Get the maximum daily send limit for an entity based on its recovery phase.
 * Returns null for healthy entities (no cap).
 */
export function getPhaseVolumeLimit(
    recoveryPhase: RecoveryPhase,
    resilienceScore: number
): number | null {
    const healingMultiplier = getHealingMultiplier(resilienceScore);

    switch (recoveryPhase) {
        case RecoveryPhase.PAUSED:
        case RecoveryPhase.QUARANTINE:
            return 0; // No sending allowed

        case RecoveryPhase.RESTRICTED_SEND:
            return Math.floor(5 * (1 / healingMultiplier.sendMultiplier)); // ~5 sends (fewer if fragile)

        case RecoveryPhase.WARM_RECOVERY:
            // 50/day aligns with SendGrid post-warmup baseline + AWS SES
            // 1k/day-per-provider guidance scaled for recovery (single mailbox).
            return Math.floor(50 * (1 / healingMultiplier.sendMultiplier));

        case RecoveryPhase.HEALTHY:
        case RecoveryPhase.WARNING:
        default:
            return null; // No volume restriction
    }
}

// ============================================================================
// INTERNAL HELPERS
// ============================================================================

/**
 * Execute a recovery phase transition with full audit trail.
 */
export async function transitionPhase(
    entityType: 'mailbox' | 'domain',
    entityId: string,
    organizationId: string,
    fromPhase: RecoveryPhase,
    toPhase: RecoveryPhase,
    reason: string,
    currentResilienceScore: number
): Promise<PhaseTransitionResult> {
    const updateData = {
        recovery_phase: toPhase,
        status: toPhase === RecoveryPhase.HEALTHY ? 'healthy' : toPhase,
        phase_entered_at: new Date(),
        clean_sends_since_phase: 0,
    };

    // === OPTIMISTIC LOCKING ===
    // Only update if recovery_phase is still fromPhase (prevents race conditions)
    // If another process (bounce handler, graduation worker) changed the phase,
    // this update will affect 0 rows and we abort
    let updateResult;
    if (entityType === 'mailbox') {
        updateResult = await prisma.mailbox.updateMany({
            where: {
                id: entityId,
                recovery_phase: fromPhase  // Condition: phase must still be fromPhase
            },
            data: updateData
        });
    } else {
        updateResult = await prisma.domain.updateMany({
            where: {
                id: entityId,
                recovery_phase: fromPhase  // Condition: phase must still be fromPhase
            },
            data: updateData
        });
    }

    // Check if update succeeded (count > 0)
    if (updateResult.count === 0) {
        // Phase changed concurrently - abort transition
        logger.warn(`[HEALING] Phase transition aborted - concurrent modification detected`, {
            entityType,
            entityId,
            expectedPhase: fromPhase,
            targetPhase: toPhase,
            reason: 'Recovery phase changed by another process (race condition prevented)'
        });

        await auditLogService.logAction({
            organizationId,
            entity: entityType,
            entityId,
            trigger: 'healing_graduation',
            action: 'phase_transition_aborted',
            details: `Transition ${fromPhase} → ${toPhase} aborted due to concurrent phase change`
        });

        return {
            transitioned: false,
            fromPhase,
            toPhase,
            reason: 'Concurrent modification detected',
            resilienceScore: currentResilienceScore
        };
    }

    // Record state transition
    await prisma.stateTransition.create({
        data: {
            organization_id: organizationId,
            entity_type: entityType,
            entity_id: entityId,
            from_state: fromPhase,
            to_state: toPhase,
            reason,
            triggered_by: TriggerType.SYSTEM,
        },
    });

    await auditLogService.logAction({
        organizationId,
        entity: entityType,
        entityId,
        trigger: 'healing_graduation',
        action: `phase_${fromPhase}_to_${toPhase}`,
        details: JSON.stringify({
            reason,
            resilienceScore: currentResilienceScore,
        }),
    });

    // ── AUTOMATED WARMUP: Enable/Update warmup based on phase ──
    if (entityType === 'mailbox') {
        const warmupService = require('./warmupService');

        // QUARANTINE → RESTRICTED_SEND: Enable conservative warmup
        if (fromPhase === RecoveryPhase.QUARANTINE && toPhase === RecoveryPhase.RESTRICTED_SEND) {
            try {
                const result = await warmupService.enableWarmupForRecovery(
                    organizationId,
                    entityId,
                    RecoveryPhase.RESTRICTED_SEND
                );

                if (result.success) {
                    logger.info('[HEALING-WARMUP] Enabled warmup for RESTRICTED_SEND phase', {
                        organizationId,
                        mailboxId: entityId
                    });
                } else {
                    logger.warn('[HEALING-WARMUP] Could not enable warmup (mailbox may not be synced from Smartlead yet)', {
                        organizationId,
                        mailboxId: entityId
                    });
                }
            } catch (warmupError: any) {
                logger.error('[HEALING-WARMUP] Failed to enable warmup', warmupError, {
                    organizationId,
                    mailboxId: entityId
                });
            }
        }

        // RESTRICTED_SEND → WARM_RECOVERY: Increase warmup volume
        if (fromPhase === RecoveryPhase.RESTRICTED_SEND && toPhase === RecoveryPhase.WARM_RECOVERY) {
            try {
                const result = await warmupService.updateWarmupForPhaseTransition(
                    organizationId,
                    entityId,
                    RecoveryPhase.WARM_RECOVERY
                );

                if (result.success) {
                    logger.info('[HEALING-WARMUP] Updated warmup for WARM_RECOVERY phase', {
                        organizationId,
                        mailboxId: entityId
                    });
                }
            } catch (warmupError: any) {
                logger.error('[HEALING-WARMUP] Failed to update warmup', warmupError, {
                    organizationId,
                    mailboxId: entityId
                });
            }
        }
    }

    // Notify user of milestone graduations
    if (toPhase === RecoveryPhase.HEALTHY) {
        try {
            await notificationService.createNotification(organizationId, {
                type: 'SUCCESS',
                title: `${entityType === 'mailbox' ? 'Mailbox' : 'Domain'} Fully Recovered`,
                message: `A ${entityType} has completed the healing pipeline and is now fully healthy. Resilience score: ${currentResilienceScore}/100.`,
            });
        } catch (notifError) {
            logger.warn('Failed to create graduation notification', { entityId });
        }

        // ── DISABLE WARMUP & RE-ADD TO PRODUCTION CAMPAIGNS ──
        if (entityType === 'mailbox') {
            // Step 1: Fully clear the warmup volume cap. The dispatcher takes
            //   min(daily_send_limit, warmup_limit) when warmup_limit > 0, so a
            //   non-zero "maintenance" value (the previous 10/day default) caps
            //   a fully-graduated mailbox at 10 sends per day forever — exactly
            //   the bug the integration audit caught. Pass `false` so
            //   warmup_limit is nulled and the dispatcher uses the
            //   ConnectedAccount.daily_send_limit cleanly.
            try {
                const warmupService = require('./warmupService');
                await warmupService.disableWarmup(
                    organizationId,
                    entityId,
                    false,
                );

                logger.info('[HEALING-WARMUP] Warmup cap lifted on graduation', {
                    organizationId,
                    mailboxId: entityId,
                });
            } catch (warmupError: any) {
                logger.error('[HEALING-WARMUP] Failed to disable warmup', warmupError, {
                    organizationId,
                    mailboxId: entityId
                });
            }

            // Step 2: Native sending — send queue reads Mailbox.status directly,
            // so a healed mailbox is automatically eligible for dispatch again.
            // No external platform re-add needed.
            let campaigns: Array<{ id: string; name: string }> = [];
            try {
                campaigns = await prisma.campaign.findMany({
                    where: { mailboxes: { some: { id: entityId } } },
                    select: { id: true, name: true }
                });

                logger.info(`[HEALING] Mailbox ${entityId} graduated to healthy — eligible for dispatch`, {
                    organizationId,
                    entityId,
                });

                // ── AUTO-RESTART: Check if any campaigns were waiting for mailbox recovery ──
                await checkAndRestartWaitingCampaigns(organizationId, campaigns);
            } catch (recoveryError: any) {
                logger.error(`[HEALING] Post-graduation campaign restart check failed for ${entityId}`, recoveryError, {
                    organizationId,
                    entityId
                });
            }
        }

        // ── PLATFORM INTEGRATION: Re-add domain mailboxes when domain recovers ──
        if (entityType === 'domain') {
            // Native sending — once domain mailboxes flip to 'healthy',
            // sendQueueService picks them up automatically. No external
            // platform re-add required.
            const mailboxCount = await prisma.mailbox.count({
                where: { domain_id: entityId, status: 'healthy' }
            });
            logger.info(`[HEALING] Domain ${entityId} graduated — ${mailboxCount} mailboxes eligible for dispatch`, {
                organizationId,
                domainId: entityId,
                mailboxCount
            });
        }
    }

    logger.info(`[HEALING] ${entityType} ${entityId}: ${fromPhase} → ${toPhase}. Reason: ${reason}`);

    // ── SLACK ALERT: Notify customer of successful recovery ──
    if (toPhase === RecoveryPhase.HEALTHY) {
        SlackAlertService.sendAlert({
            organizationId,
            eventType: `${entityType}_recovered`,
            entityId,
            severity: 'info',
            title: `✅ ${entityType === 'mailbox' ? 'Mailbox' : 'Domain'} Recovered`,
            message: `${entityType === 'mailbox' ? 'Mailbox' : 'Domain'} \`${entityId}\` has completed recovery and is back in full production.`
        }).catch(err => logger.warn('[HEALING] Non-fatal alert error', { error: String(err) }));
    }

    // Outbound webhook fan-out — only mailbox phase changes carry their own
    // webhook events (mailbox.entered_quarantine / restricted_send / warm_recovery
    // / mailbox.healed). Domain phase changes ride domain.* events from
    // entityStateService instead.
    if (entityType === 'mailbox') {
        try {
            const mb = await prisma.mailbox.findUnique({
                where: { id: entityId },
                select: { id: true, email: true },
            });
            if (mb) {
                webhookBus.emitMailboxPhaseChange(
                    organizationId,
                    mb,
                    String(fromPhase),
                    String(toPhase),
                    reason,
                );
            }
        } catch (err) {
            logger.error('[HEALING] webhook bus emit failed (phase)', err instanceof Error ? err : new Error(String(err)));
        }
    }

    return {
        transitioned: true,
        fromPhase,
        toPhase,
        reason,
        resilienceScore: currentResilienceScore,
    };
}

/**
 * Check if domain has blocking blacklist listings.
 * Uses the summary cache from dnsblService: checks if any critical or 2+ major lists are CONFIRMED.
 * For backward compatibility, also handles legacy flat { name: status } format.
 */
function isBlacklisted(blacklistResults: any): boolean {
    if (!blacklistResults || typeof blacklistResults !== 'object') return false;

    // New summary format from dnsblService: { critical_listed, major_listed, ... }
    if ('critical_listed' in blacklistResults) {
        return blacklistResults.critical_listed > 0 || blacklistResults.major_listed >= 2;
    }

    // Legacy flat format: { spamhaus: 'CONFIRMED', ... }
    return Object.values(blacklistResults).some((result) => result === 'CONFIRMED');
}

// ============================================================================
// AGGREGATE THROTTLING (Domain + Org level)
// ============================================================================

/**
 * Get the maximum daily send limit for an entire domain during recovery.
 * Returns Infinity if no mailbox is recovering (no cap).
 * Caps at DOMAIN_RECOVERY_CAP when ANY mailbox is in a recovery phase.
 */
export async function getDomainAggregateLimit(domainId: string): Promise<number> {
    const mailboxes = await prisma.mailbox.findMany({
        where: { domain_id: domainId },
        select: {
            recovery_phase: true,
            resilience_score: true,
        },
    });

    if (mailboxes.length === 0) return Infinity;

    // Check if any mailbox is in a recovery phase
    const recoveringMailboxes = mailboxes.filter(
        (m) => m.recovery_phase !== RecoveryPhase.HEALTHY && m.recovery_phase !== RecoveryPhase.WARNING
    );

    if (recoveringMailboxes.length === 0) return Infinity; // No cap needed

    // Sum individual limits, but cap at DOMAIN_RECOVERY_CAP
    const individualSum = mailboxes.reduce((sum, m) => {
        const limit = getPhaseVolumeLimit(
            m.recovery_phase as RecoveryPhase,
            m.resilience_score ?? 50
        );
        return sum + (limit ?? 0);
    }, 0);

    const cap = Math.min(individualSum, DOMAIN_RECOVERY_CAP);

    logger.info(`[THROTTLE] Domain ${domainId} aggregate limit: ${cap}`, {
        domainId,
        recoveringCount: recoveringMailboxes.length,
        totalMailboxes: mailboxes.length,
        individualSum,
        cap,
    });

    return cap;
}

/**
 * Get the maximum daily send limit for an entire organization during recovery.
 * Returns Infinity if no entity is recovering.
 * Caps at ORG_RECOVERY_CAP when ANY domain has recovering mailboxes.
 */
export async function getOrgAggregateLimit(organizationId: string): Promise<number> {
    const domains = await prisma.domain.findMany({
        where: { organization_id: organizationId },
        select: { id: true },
    });

    if (domains.length === 0) return Infinity;

    let totalCap = 0;
    let hasRecovering = false;

    for (const domain of domains) {
        const domainLimit = await getDomainAggregateLimit(domain.id);
        if (domainLimit !== Infinity) {
            hasRecovering = true;
            totalCap += domainLimit;
        }
    }

    if (!hasRecovering) return Infinity; // No cap needed

    const orgCap = Math.min(totalCap, ORG_RECOVERY_CAP);

    logger.info(`[THROTTLE] Org ${organizationId} aggregate limit: ${orgCap}`, {
        organizationId,
        totalDomainsCap: totalCap,
        orgCap,
    });

    return orgCap;
}

/**
 * Decay consecutive_pauses for entities that have been HEALTHY for at least
 * CONSECUTIVE_PAUSES_DECAY_DAYS. Decrements by 1 per decay window (min 0).
 *
 * Called by metricsWorker on a daily tick. The 30-day window is a defensible
 * practitioner choice — no authoritative source publishes a forgiveness curve
 * for past offenses, but Apollo/Smartlead's "60+ days inactive = restart
 * warmup" precedent suggests reputation memory has a multi-week half-life.
 */
export async function decayConsecutivePauses(): Promise<{ mailboxesDecayed: number; domainsDecayed: number }> {
    const decayMs = MONITORING_THRESHOLDS.CONSECUTIVE_PAUSES_DECAY_DAYS * 86400000;
    const cutoff = new Date(Date.now() - decayMs);

    // Mailboxes: must be healthy and either never decayed (use last_pause_at)
    // or last decayed > CONSECUTIVE_PAUSES_DECAY_DAYS ago. consecutive_pauses must be >0.
    const mailboxes = await prisma.mailbox.findMany({
        where: {
            recovery_phase: RecoveryPhase.HEALTHY,
            status: 'healthy',
            consecutive_pauses: { gt: 0 },
            OR: [
                { consecutive_pauses_decayed_at: null, last_pause_at: { lte: cutoff } },
                { consecutive_pauses_decayed_at: { lte: cutoff } },
            ],
        },
        select: { id: true, consecutive_pauses: true },
    });

    for (const mb of mailboxes) {
        await prisma.mailbox.update({
            where: { id: mb.id },
            data: {
                consecutive_pauses: Math.max(0, mb.consecutive_pauses - 1),
                consecutive_pauses_decayed_at: new Date(),
            },
        });
    }

    const domains = await prisma.domain.findMany({
        where: {
            recovery_phase: RecoveryPhase.HEALTHY,
            status: 'healthy',
            consecutive_pauses: { gt: 0 },
            OR: [
                { consecutive_pauses_decayed_at: null, last_pause_at: { lte: cutoff } },
                { consecutive_pauses_decayed_at: { lte: cutoff } },
            ],
        },
        select: { id: true, consecutive_pauses: true },
    });

    for (const d of domains) {
        await prisma.domain.update({
            where: { id: d.id },
            data: {
                consecutive_pauses: Math.max(0, d.consecutive_pauses - 1),
                consecutive_pauses_decayed_at: new Date(),
            },
        });
    }

    if (mailboxes.length > 0 || domains.length > 0) {
        logger.info('[HEALING] consecutive_pauses decay tick', {
            mailboxesDecayed: mailboxes.length,
            domainsDecayed: domains.length,
        });
    }

    return { mailboxesDecayed: mailboxes.length, domainsDecayed: domains.length };
}

/**
 * Clear the manual-intervention flag on a mailbox or domain. Only called
 * from the healingController API endpoint (operator action). Resets the
 * flag and DNS-failure counter so the entity can re-enter the graduation
 * pipeline on the next worker tick.
 */
export async function clearManualIntervention(
    organizationId: string,
    entityType: 'mailbox' | 'domain',
    entityId: string,
    operatorNote: string
): Promise<{ success: boolean; error?: string }> {
    const entity = entityType === 'mailbox'
        ? await prisma.mailbox.findUnique({ where: { id: entityId }, select: { id: true, organization_id: true, manual_intervention_required: true } })
        : await prisma.domain.findUnique({ where: { id: entityId }, select: { id: true, organization_id: true, manual_intervention_required: true } });

    if (!entity) return { success: false, error: 'Entity not found' };
    if (entity.organization_id !== organizationId) return { success: false, error: 'Entity belongs to a different organization' };
    if (!entity.manual_intervention_required) return { success: false, error: 'Manual intervention flag is not set' };

    if (entityType === 'mailbox') {
        await prisma.mailbox.update({
            where: { id: entityId },
            data: {
                manual_intervention_required: false,
                manual_intervention_reason: null,
                manual_intervention_set_at: null,
            },
        });
    } else {
        await prisma.domain.update({
            where: { id: entityId },
            data: {
                manual_intervention_required: false,
                manual_intervention_reason: null,
                manual_intervention_set_at: null,
                dns_check_failure_count: 0,
                last_dns_check_attempt_at: null,
            },
        });
    }

    await auditLogService.logAction({
        organizationId,
        entity: entityType,
        entityId,
        trigger: 'manual',
        action: 'manual_intervention_cleared',
        details: operatorNote,
    });

    logger.info(`[HEALING] Manual intervention cleared for ${entityType} ${entityId}`, { operatorNote });
    return { success: true };
}

/**
 * Get the rolling 24h send count for a domain (across all mailboxes).
 *
 * Uses a 24-hour sliding window over SendEvent (not calendar-day, not the
 * window_sent_count field). The previous calendar-day approach allowed
 * volume bursts around midnight; window_sent_count is a rolling 100-send
 * counter that decays via slideWindow and is not a daily figure.
 *
 * Aligns with AWS SES "rolling 24-hour period" guidance.
 */
export async function getDomainSentToday(domainId: string): Promise<number> {
    const since = new Date(Date.now() - 86400000); // 24h sliding window
    const mailboxes = await prisma.mailbox.findMany({
        where: { domain_id: domainId },
        select: { id: true },
    });
    if (mailboxes.length === 0) return 0;
    return prisma.sendEvent.count({
        where: {
            mailbox_id: { in: mailboxes.map(m => m.id) },
            sent_at: { gte: since },
        },
    });
}

/**
 * Get the rolling 24h send count for an organization (across all mailboxes).
 * See getDomainSentToday for sliding-window rationale.
 */
export async function getOrgSentToday(organizationId: string): Promise<number> {
    const since = new Date(Date.now() - 86400000); // 24h sliding window
    return prisma.sendEvent.count({
        where: {
            organization_id: organizationId,
            sent_at: { gte: since },
        },
    });
}

/**
 * Check and auto-restart campaigns that were waiting for mailbox recovery
 * Called when a mailbox graduates to healthy status
 */
async function checkAndRestartWaitingCampaigns(
    organizationId: string,
    recoveredCampaigns: Array<{ id: string; name?: string }>
): Promise<void> {
    try {
        // Find campaigns that are paused and waiting for recovery
        for (const campaign of recoveredCampaigns) {
            const campaignData = await prisma.campaign.findUnique({
                where: { id: campaign.id },
                include: {
                    mailboxes: {
                        where: {
                            status: { in: ['healthy', 'active'] }
                        }
                    }
                }
            });

            if (!campaignData) continue;

            // Check if campaign is paused due to infrastructure health
            const isPausedForHealth = campaignData.status === 'paused' &&
                (campaignData.paused_reason?.includes('Infrastructure health') ||
                    campaignData.paused_reason?.includes('No healthy mailboxes') ||
                    campaignData.paused_reason?.includes('mailbox'));

            // If campaign has healthy mailboxes now and was paused for health, restart it
            if (isPausedForHealth && campaignData.mailboxes.length > 0) {
                logger.info(`[HEALING-AUTORESTART] Campaign ${campaign.id} now has ${campaignData.mailboxes.length} healthy mailboxes, auto-restarting`, {
                    organizationId,
                    campaignId: campaign.id,
                    healthyMailboxCount: campaignData.mailboxes.length
                });

                // Native sending — resume by flipping Campaign.status. The
                // sequencer dispatcher reads this on its next 60s tick.
                try {
                    await prisma.campaign.update({
                        where: { id: campaign.id },
                        data: {
                            status: 'active',
                            paused_reason: null,
                            paused_at: null
                        }
                    });

                    // Record state transition for traceability
                    await prisma.stateTransition.create({
                        data: {
                            organization_id: organizationId,
                            entity_type: 'campaign',
                            entity_id: campaign.id,
                            from_state: 'paused',
                            to_state: 'active',
                            reason: `Auto-restarted after mailbox recovery. ${campaignData.mailboxes.length} healthy mailboxes available.`,
                            triggered_by: 'cooldown_complete',
                        }
                    });

                    await auditLogService.logAction({
                        organizationId,
                        entity: 'campaign',
                        entityId: campaign.id,
                        trigger: 'infrastructure_recovery',
                        action: 'auto_restarted',
                        details: `Campaign auto-restarted after mailbox recovery. ${campaignData.mailboxes.length} healthy mailboxes available.`
                    });

                    // Create notification for user
                    await notificationService.createNotification(organizationId, {
                        type: 'SUCCESS',
                        title: 'Campaign Auto-Restarted',
                        message: `Campaign "${campaignData.name || campaign.id}" has been automatically restarted after mailbox recovery.`
                    });

                    logger.info(`[HEALING-AUTORESTART] Successfully restarted campaign ${campaign.id}`, {
                        organizationId,
                        campaignId: campaign.id
                    });

                } catch (restartError: any) {
                    // Unexpected error during DB update or notification
                    logger.error(`[HEALING-AUTORESTART] Unexpected error during campaign restart ${campaign.id}`, restartError, {
                        organizationId,
                        campaignId: campaign.id
                    });

                    // Don't throw - log and continue with other campaigns
                    await notificationService.createNotification(organizationId, {
                        type: 'WARNING',
                        title: 'Auto-Restart Error',
                        message: `Unexpected error during auto-restart of campaign "${campaignData.name || campaign.id}". Please check manually.`
                    });
                }
            }
        }
    } catch (error: any) {
        logger.error('[HEALING-AUTORESTART] Error checking for waiting campaigns', error, {
            organizationId
        });
        // Don't throw - this is a background task
    }
}
