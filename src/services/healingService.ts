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
} from '../types';
import * as auditLogService from './auditLogService';
import * as notificationService from './notificationService';
import * as smartleadClient from './smartleadClient';
import logger from '../utils/logger';

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
 */
async function checkQuarantineToRestricted(
    mailbox: any
): Promise<PhaseTransitionResult | null> {
    // Re-check domain DNS health
    const domain = await prisma.domain.findUnique({
        where: { id: mailbox.domain_id },
    });
    if (!domain) return null;

    // DNS must be healthy — no blacklists, SPF/DKIM present
    const dnsHealthy = domain.spf_valid === true
        && domain.dkim_valid === true
        && !isBlacklisted(domain.blacklist_results);

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
 * Restricted Send → Warm Recovery: N clean sends with 0 hard bounces.
 */
async function checkRestrictedToWarm(
    mailbox: any,
    isRehab: boolean
): Promise<PhaseTransitionResult | null> {
    const criteria = GRADUATION_CRITERIA.restricted_to_warm;
    const requiredCleanSends = mailbox.consecutive_pauses > 1
        ? criteria.repeatCleanSends
        : criteria.firstOffenseCleanSends;

    // Apply rehab multiplier
    const adjustedCleanSends = isRehab
        ? Math.ceil(requiredCleanSends * GRADUATION_CRITERIA.rehabMultipliers.sendMultiplier)
        : requiredCleanSends;

    // Apply resilience multiplier
    const healingMultiplier = getHealingMultiplier(mailbox.resilience_score);
    const finalCleanSends = Math.ceil(adjustedCleanSends * healingMultiplier.sendMultiplier);

    if (mailbox.clean_sends_since_phase < finalCleanSends) {
        return null; // Not enough clean sends yet
    }

    const result = await transitionPhase(
        'mailbox',
        mailbox.id,
        mailbox.organization_id,
        RecoveryPhase.RESTRICTED_SEND,
        RecoveryPhase.WARM_RECOVERY,
        `${mailbox.clean_sends_since_phase} clean sends achieved (required: ${finalCleanSends}) — entering warm recovery`,
        mailbox.resilience_score
    );
    return result;
}

/**
 * Warm Recovery → Healthy: M sends over K days below threshold.
 */
async function checkWarmToHealthy(
    mailbox: any,
    isRehab: boolean,
    now: Date
): Promise<PhaseTransitionResult | null> {
    const criteria = GRADUATION_CRITERIA.warm_to_healthy;
    const healingMultiplier = getHealingMultiplier(mailbox.resilience_score);

    // Calculate adjusted requirements
    const requiredSends = isRehab
        ? Math.ceil(criteria.minSends * GRADUATION_CRITERIA.rehabMultipliers.sendMultiplier)
        : criteria.minSends;
    const adjustedSends = Math.ceil(requiredSends * healingMultiplier.sendMultiplier);

    const requiredDaysMs = criteria.minDays * 86400000;
    const adjustedDaysMs = isRehab
        ? requiredDaysMs * GRADUATION_CRITERIA.rehabMultipliers.timeMultiplier
        : requiredDaysMs;

    // Check volume
    if (mailbox.clean_sends_since_phase < adjustedSends) {
        return null;
    }

    // Check time in phase
    if (mailbox.phase_entered_at) {
        const timeInPhaseMs = now.getTime() - new Date(mailbox.phase_entered_at).getTime();
        if (timeInPhaseMs < adjustedDaysMs) {
            return null; // Not enough time in warm recovery
        }
    }

    // Check bounce rate during warm recovery
    const bounceRate = mailbox.total_sent_count > 0
        ? mailbox.hard_bounce_count / mailbox.total_sent_count
        : 0;
    if (bounceRate > criteria.maxBounceRate) {
        return null; // Bounce rate too high
    }

    // Graduate to healthy + resilience bonus
    const resAdj = adjustResilienceScore(
        mailbox.resilience_score,
        RESILIENCE_ADJUSTMENTS.GRADUATION,
        'Graduated to healthy'
    );

    await prisma.mailbox.update({
        where: { id: mailbox.id },
        data: {
            resilience_score: resAdj.newScore,
            healing_origin: null, // Clear healing origin
            relapse_count: 0,     // Reset on full recovery
        },
    });

    const result = await transitionPhase(
        'mailbox',
        mailbox.id,
        mailbox.organization_id,
        RecoveryPhase.WARM_RECOVERY,
        RecoveryPhase.HEALTHY,
        `Recovery complete — ${mailbox.clean_sends_since_phase} clean sends over ${criteria.minDays}+ days, bounce rate ${(bounceRate * 100).toFixed(1)}%`,
        resAdj.newScore
    );
    return result;
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

    // Update entity
    const updateData: any = {
        relapse_count: relapseCount,
        resilience_score: resAdj.newScore,
        recovery_phase: targetPhase,
        phase_entered_at: new Date(),
        clean_sends_since_phase: 0,
        healing_origin: entity.healing_origin || HealingOrigin.RECOVERY,
        cooldown_until: new Date(Date.now() + cooldownMs),
        status: targetPhase === RecoveryPhase.PAUSED ? 'paused' : targetPhase,
    };

    if (entityType === 'mailbox') {
        await prisma.mailbox.update({ where: { id: entityId }, data: updateData });
    } else {
        await prisma.domain.update({ where: { id: entityId }, data: updateData });
    }

    await auditLogService.logAction({
        organizationId,
        entity: entityType,
        entityId,
        trigger: 'healing_relapse',
        action: `relapse_to_${targetPhase}`,
        details: JSON.stringify({
            reason,
            relapseCount,
            resilienceScore: resAdj.newScore,
            cooldownMs,
            previousPhase: currentPhase,
        }),
    });

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
            return Math.floor(25 * (1 / healingMultiplier.sendMultiplier)); // ~25 sends

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
async function transitionPhase(
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

    if (entityType === 'mailbox') {
        await prisma.mailbox.update({ where: { id: entityId }, data: updateData });
    } else {
        await prisma.domain.update({ where: { id: entityId }, data: updateData });
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

        // ── SMARTLEAD INTEGRATION: Re-add mailbox to campaigns when fully recovered ──
        if (entityType === 'mailbox') {
            try {
                // Get all campaigns this mailbox is assigned to in Drason
                const campaigns = await prisma.campaign.findMany({
                    where: {
                        mailboxes: {
                            some: { id: entityId }
                        }
                    }
                });

                // Re-add the mailbox to each campaign in Smartlead
                for (const campaign of campaigns) {
                    await smartleadClient.addMailboxToSmartleadCampaign(
                        organizationId,
                        campaign.id,
                        entityId
                    );
                }

                logger.info(`[HEALING] Re-added mailbox ${entityId} to ${campaigns.length} Smartlead campaigns`, {
                    organizationId,
                    entityId,
                    campaignCount: campaigns.length
                });
            } catch (smartleadError: any) {
                // Smartlead re-add failure doesn't block the recovery — mailbox is already healthy in Drason
                logger.error(`[HEALING] Failed to re-add mailbox ${entityId} to Smartlead campaigns`, smartleadError, {
                    organizationId,
                    entityId
                });
            }
        }

        // ── SMARTLEAD INTEGRATION: Re-add domain mailboxes when domain recovers ──
        if (entityType === 'domain') {
            try {
                // Get all mailboxes for this domain with their campaign assignments
                const mailboxes = await prisma.mailbox.findMany({
                    where: { domain_id: entityId, status: 'healthy' },
                    include: { campaigns: true }
                });

                let addedCount = 0;
                for (const mailbox of mailboxes) {
                    for (const campaign of mailbox.campaigns) {
                        await smartleadClient.addMailboxToSmartleadCampaign(
                            organizationId,
                            campaign.id,
                            mailbox.id
                        );
                        addedCount++;
                    }
                }

                logger.info(`[HEALING] Re-added domain ${entityId} mailboxes to Smartlead campaigns`, {
                    organizationId,
                    domainId: entityId,
                    mailboxCount: mailboxes.length,
                    addedCount
                });
            } catch (smartleadError: any) {
                logger.error(`[HEALING] Failed to re-add domain ${entityId} mailboxes to Smartlead`, smartleadError, {
                    organizationId,
                    domainId: entityId
                });
            }
        }
    }

    logger.info(`[HEALING] ${entityType} ${entityId}: ${fromPhase} → ${toPhase}. Reason: ${reason}`);

    return {
        transitioned: true,
        fromPhase,
        toPhase,
        reason,
        resilienceScore: currentResilienceScore,
    };
}

/**
 * Check if any blacklist result is CONFIRMED (listed).
 */
function isBlacklisted(blacklistResults: any): boolean {
    if (!blacklistResults || typeof blacklistResults !== 'object') return false;
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
 * Get today's total sent count for a domain (across all mailboxes).
 */
export async function getDomainSentToday(domainId: string): Promise<number> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const result = await prisma.mailbox.aggregate({
        where: {
            domain_id: domainId,
            last_activity_at: { gte: today },
        },
        _sum: { window_sent_count: true },
    });

    return result._sum.window_sent_count ?? 0;
}

/**
 * Get today's total sent count for an organization (across all mailboxes).
 */
export async function getOrgSentToday(organizationId: string): Promise<number> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const result = await prisma.mailbox.aggregate({
        where: {
            organization_id: organizationId,
            last_activity_at: { gte: today },
        },
        _sum: { window_sent_count: true },
    });

    return result._sum.window_sent_count ?? 0;
}
