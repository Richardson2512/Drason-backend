/**
 * Monitoring Service
 * 
 * Tracks mailbox and domain health through event monitoring.
 * Section 7 of Audit: Monitoring Engine Design.
 * Section 8 of Audit: State Machine Architecture.
 * Section 11 of Audit: Recovery & Cooldown Modeling.
 * 
 * Key features:
 * - Window-based metrics (1h, 24h, 7d)
 * - Threshold-based pause escalation
 * - Cooldown enforcement for recovery
 * - Domain aggregation from mailbox health
 */

import { prisma } from '../index';
import * as auditLogService from './auditLogService';
import * as eventService from './eventService';
import { classifyBounce } from './bounceClassifier';
import * as healingService from './healingService';
import * as correlationService from './correlationService';
import { logger } from './observabilityService';
import {
    EventType,
    MailboxState,
    DomainState,
    RecoveryPhase,
    MONITORING_THRESHOLDS,
    STATE_TRANSITIONS
} from '../types';

const {
    // Tiered mailbox thresholds
    MAILBOX_WARNING_BOUNCES,
    MAILBOX_WARNING_WINDOW,
    MAILBOX_PAUSE_BOUNCES,
    MAILBOX_PAUSE_WINDOW,
    // Domain ratio thresholds
    DOMAIN_WARNING_RATIO,
    DOMAIN_PAUSE_RATIO,
    DOMAIN_MINIMUM_MAILBOXES,
    // Cooldown
    COOLDOWN_MINIMUM_MS,
    COOLDOWN_MULTIPLIER,
    COOLDOWN_MAX_MS,
    // Rolling window
    ROLLING_WINDOW_SIZE
} = MONITORING_THRESHOLDS;

/**
 * Get organization ID from a mailbox.
 */
async function getMailboxOrgId(mailboxId: string): Promise<string | null> {
    const mailbox = await prisma.mailbox.findUnique({
        where: { id: mailboxId },
        select: { organization_id: true }
    });
    return mailbox?.organization_id || null;
}

/**
 * Record a bounce event for a mailbox.
 * 
 * Enhanced with:
 *   - Cause-based classification (BounceFailureType)
 *   - Provider fingerprinting (EmailProvider)
 *   - Only health-degrading failures count toward thresholds
 *   - Transient failures logged but don't affect health
 *   - Recovery phase relapse detection
 */
export const recordBounce = async (
    mailboxId: string,
    campaignId: string,
    smtpResponse?: string,
    recipientEmail?: string
): Promise<void> => {
    const mailbox = await prisma.mailbox.findUnique({
        where: { id: mailboxId },
        include: { domain: true }
    });
    if (!mailbox) return;

    const orgId = mailbox.organization_id;

    // ── Classify the bounce by cause and provider ──
    const classification = classifyBounce(
        smtpResponse || 'unknown',
        recipientEmail
    );

    // Store raw event with classification metadata
    await eventService.storeEvent({
        organizationId: orgId,
        eventType: EventType.HARD_BOUNCE,
        entityType: 'mailbox',
        entityId: mailboxId,
        payload: {
            mailboxId,
            campaignId,
            failureType: classification.failureType,
            provider: classification.provider,
            severity: classification.severity,
            degradesHealth: classification.degradesHealth,
            rawReason: classification.rawReason,
        }
    });

    // ── Transient failures: log only, don't degrade health ──
    if (!classification.degradesHealth) {
        await auditLogService.logAction({
            organizationId: orgId,
            entity: 'mailbox',
            entityId: mailboxId,
            trigger: 'monitor_bounce',
            action: 'transient_bounce',
            details: `${classification.failureType} from ${classification.provider} — not degrading health. Reason: ${classification.rawReason}`
        });
        return; // Skip threshold checks entirely
    }

    // ── Health-degrading bounce: update counters ──
    const newBounceCount = mailbox.window_bounce_count + 1;
    const totalBounces = mailbox.hard_bounce_count + 1;

    await prisma.mailbox.update({
        where: { id: mailboxId },
        data: {
            window_bounce_count: newBounceCount,
            hard_bounce_count: totalBounces,
            last_activity_at: new Date()
        }
    });

    await auditLogService.logAction({
        organizationId: orgId,
        entity: 'mailbox',
        entityId: mailboxId,
        trigger: 'monitor_bounce',
        action: 'stat_update',
        details: `${classification.failureType} from ${classification.provider}. Window: ${newBounceCount}/${mailbox.window_sent_count}`
    });

    // ── Relapse detection: if entity is in recovery phases, handle relapse ──
    const recoveryPhases = [
        RecoveryPhase.QUARANTINE,
        RecoveryPhase.RESTRICTED_SEND,
        RecoveryPhase.WARM_RECOVERY,
    ];
    const currentPhase = mailbox.recovery_phase as RecoveryPhase;

    if (recoveryPhases.includes(currentPhase)) {
        await healingService.resetCleanSends('mailbox', mailboxId);
        await healingService.handleRelapse(
            'mailbox',
            mailboxId,
            orgId,
            currentPhase,
            `Health-degrading bounce during ${currentPhase}: ${classification.failureType} (${classification.provider})`
        );
        return; // Relapse handler manages state transitions
    }

    // ── Standard threshold logic for healthy/warning mailboxes ──
    const sentCount = mailbox.window_sent_count;

    // PAUSE CHECK: 5 bounces within window
    if (newBounceCount >= MAILBOX_PAUSE_BOUNCES) {
        if (mailbox.status !== 'paused') {
            await pauseMailbox(
                mailboxId,
                `Exceeded ${MAILBOX_PAUSE_BOUNCES} bounces (${newBounceCount}/${sentCount}). Cause: ${classification.failureType}, Provider: ${classification.provider}`
            );
        }
    }
    // WARNING CHECK: 3 bounces within 60 sends
    else if (newBounceCount >= MAILBOX_WARNING_BOUNCES && sentCount <= MAILBOX_WARNING_WINDOW) {
        if (mailbox.status === 'healthy') {
            await warnMailbox(
                mailboxId,
                `Early warning: ${newBounceCount}/${sentCount} (${((newBounceCount / sentCount) * 100).toFixed(1)}%). Cause: ${classification.failureType}`
            );
        }
    }
};

/**
 * Record a sent email event for a mailbox.
 * May trigger window reset if threshold reached.
 */
export const recordSent = async (mailboxId: string, campaignId: string): Promise<void> => {
    const mailbox = await prisma.mailbox.findUnique({ where: { id: mailboxId } });
    if (!mailbox) return;

    const orgId = mailbox.organization_id;

    // Store raw event
    await eventService.storeEvent({
        organizationId: orgId,
        eventType: EventType.EMAIL_SENT,
        entityType: 'mailbox',
        entityId: mailboxId,
        payload: { mailboxId, campaignId }
    });

    const newSentCount = mailbox.window_sent_count + 1;
    const totalSent = mailbox.total_sent_count + 1;

    // Update stats
    await prisma.mailbox.update({
        where: { id: mailboxId },
        data: {
            window_sent_count: newSentCount,
            total_sent_count: totalSent,
            last_activity_at: new Date(),
            // Track clean sends for healing graduation
            clean_sends_since_phase: mailbox.clean_sends_since_phase + 1,
        }
    });

    // Rolling window: After ROLLING_WINDOW_SIZE sends, we shift the window
    // This is NOT a hard reset - we keep tracking but with sliding perspective
    if (newSentCount >= ROLLING_WINDOW_SIZE) {
        await slideWindow(mailboxId);
    }
};

/**
 * Sliding window for monitoring (NOT hard reset).
 * Keeps 50% of current window stats to preserve volatility visibility.
 * This prevents the "99 clean sends hiding a burst" problem.
 */
const slideWindow = async (mailboxId: string): Promise<void> => {
    const mailbox = await prisma.mailbox.findUnique({ where: { id: mailboxId } });
    if (!mailbox) return;

    const orgId = mailbox.organization_id;

    // SLIDING WINDOW: Keep half the stats, don't wipe clean
    // This preserves volatility patterns while still allowing healing
    const newSentCount = Math.floor(mailbox.window_sent_count / 2);
    const newBounceCount = Math.floor(mailbox.window_bounce_count / 2);

    await prisma.mailbox.update({
        where: { id: mailboxId },
        data: {
            window_sent_count: newSentCount,
            window_bounce_count: newBounceCount,
            window_start_at: new Date()
        }
    });

    await auditLogService.logAction({
        organizationId: orgId,
        entity: 'mailbox',
        entityId: mailboxId,
        trigger: 'monitor_window',
        action: 'window_slide',
        details: `Window slid: kept ${newBounceCount}/${newSentCount} (50% of previous). Sliding heal.`
    });

    // If recovering AND bounce rate is now acceptable, consider healthy
    const currentRate = newSentCount > 0 ? (newBounceCount / newSentCount) : 0;
    if (mailbox.status === 'recovering' && currentRate < 0.03) { // Under 3%
        await transitionMailboxState(mailboxId, 'recovering', 'healthy', `Clean sliding window (${(currentRate * 100).toFixed(1)}% bounce rate)`);
    }
};

/**
 * WARN a mailbox - early warning state before pause.
 * This gives operators time to react before damage occurs.
 */
const warnMailbox = async (mailboxId: string, reason: string): Promise<void> => {
    const mailbox = await prisma.mailbox.findUnique({ where: { id: mailboxId } });
    if (!mailbox) return;

    const orgId = mailbox.organization_id;

    // Store warning event
    await eventService.storeEvent({
        organizationId: orgId,
        eventType: EventType.MAILBOX_PAUSED, // We'll use same event, different state
        entityType: 'mailbox',
        entityId: mailboxId,
        payload: { reason, state: 'warning' }
    });

    // Update mailbox to warning state
    await prisma.mailbox.update({
        where: { id: mailboxId },
        data: {
            status: 'warning'
        }
    });

    // Record state transition
    await prisma.stateTransition.create({
        data: {
            organization_id: orgId,
            entity_type: 'mailbox',
            entity_id: mailboxId,
            from_state: mailbox.status,
            to_state: 'warning',
            reason,
            triggered_by: 'threshold_warning'
        }
    });

    await auditLogService.logAction({
        organizationId: orgId,
        entity: 'mailbox',
        entityId: mailboxId,
        trigger: 'monitor_warning',
        action: 'warning',
        details: `⚠️ WARNING: ${reason}`
    });

    logger.info(`[MONITOR] ⚠️ Mailbox ${mailboxId} entered WARNING state: ${reason}`);
};

/**
 * Pause a mailbox due to threshold breach.
 * Implements cooldown calculation based on consecutive pauses.
 */
const pauseMailbox = async (mailboxId: string, reason: string): Promise<void> => {
    const mailbox = await prisma.mailbox.findUnique({ where: { id: mailboxId } });
    if (!mailbox) return;

    const orgId = mailbox.organization_id;

    // ── PRE-PAUSE CORRELATION CHECK ──
    // Before pausing, check if the root cause is at a different entity level
    const correlation = await correlationService.correlateBeforePause(mailboxId, orgId);
    const action = correlation.recommendedAction;

    if (action.action === 'pause_domain') {
        // Escalate to domain-level pause — skip individual mailbox pause
        logger.info(`[MONITOR] ↑ Escalating to domain pause: ${correlation.message}`);
        await pauseDomain(action.entityId, `Cross-entity correlation: ${action.reason}`);
        return;
    }

    if (action.action === 'pause_campaign') {
        // Redirect to campaign pause — mailbox stays active
        logger.info(`[MONITOR] → Redirecting to campaign pause: ${correlation.message}`);
        await pauseCampaign(action.entityId, orgId, `Cross-entity correlation: ${action.reason}`);
        return;
    }

    if (action.action === 'restrict_provider') {
        // Apply provider restriction instead of full mailbox pause
        logger.info(`[MONITOR] ⊘ Applying provider restriction: ${correlation.message}`);
        await applyProviderRestriction(mailboxId, orgId, action.provider, action.reason);
        return;
    }

    // ── Standard mailbox pause (no correlation redirected) ──
    const consecutivePauses = mailbox.consecutive_pauses + 1;

    // Calculate cooldown with exponential backoff
    const cooldownMs = COOLDOWN_MINIMUM_MS * Math.pow(COOLDOWN_MULTIPLIER, Math.min(consecutivePauses - 1, 5));
    const cooldownUntil = new Date(Date.now() + cooldownMs);

    // Adjust resilience score on pause
    const newResilience = Math.max(0, (mailbox.resilience_score || 50) - 15);

    // Store event
    await eventService.storeEvent({
        organizationId: orgId,
        eventType: EventType.MAILBOX_PAUSED,
        entityType: 'mailbox',
        entityId: mailboxId,
        payload: { reason, cooldownUntil, consecutivePauses, correlation: correlation.message }
    });

    // Update mailbox
    await prisma.mailbox.update({
        where: { id: mailboxId },
        data: {
            status: 'paused',
            recovery_phase: 'paused',
            last_pause_at: new Date(),
            cooldown_until: cooldownUntil,
            consecutive_pauses: consecutivePauses,
            resilience_score: newResilience,
            clean_sends_since_phase: 0,
            phase_entered_at: new Date(),
        }
    });

    // Record state transition
    await prisma.stateTransition.create({
        data: {
            organization_id: orgId,
            entity_type: 'mailbox',
            entity_id: mailboxId,
            from_state: mailbox.status,
            to_state: 'paused',
            reason: `[${action.action}] ${reason}`,
            triggered_by: 'threshold_breach'
        }
    });

    await auditLogService.logAction({
        organizationId: orgId,
        entity: 'mailbox',
        entityId: mailboxId,
        trigger: 'monitor_threshold',
        action: 'pause',
        details: `${reason}. Cooldown until ${cooldownUntil.toISOString()}. Resilience: ${newResilience}. Correlation: ${correlation.message}`
    });

    // Trigger Domain Check
    await checkDomainHealth(mailbox.domain_id);
};

/**
 * Transition mailbox state with validation.
 */
const transitionMailboxState = async (
    mailboxId: string,
    fromState: string,
    toState: string,
    reason: string
): Promise<boolean> => {
    const mailbox = await prisma.mailbox.findUnique({ where: { id: mailboxId } });
    if (!mailbox) return false;

    const orgId = mailbox.organization_id;

    // Validate transition
    const fromStateKey = fromState as keyof typeof STATE_TRANSITIONS.mailbox;
    const validTransitions = STATE_TRANSITIONS.mailbox[fromStateKey] as readonly string[];
    if (!validTransitions || !validTransitions.includes(toState)) {
        logger.info(`[MONITOR] Invalid transition: ${fromState} -> ${toState}`);
        return false;
    }

    // Update state
    await prisma.mailbox.update({
        where: { id: mailboxId },
        data: {
            status: toState,
            // Reset consecutive pauses if transitioning to healthy
            ...(toState === 'healthy' && { consecutive_pauses: 0 })
        }
    });

    // Record transition
    await prisma.stateTransition.create({
        data: {
            organization_id: orgId,
            entity_type: 'mailbox',
            entity_id: mailboxId,
            from_state: fromState,
            to_state: toState,
            reason,
            triggered_by: 'system'
        }
    });

    await auditLogService.logAction({
        organizationId: orgId,
        entity: 'mailbox',
        entityId: mailboxId,
        trigger: 'state_machine',
        action: 'state_transition',
        details: `${fromState} -> ${toState}: ${reason}`
    });

    return true;
};

/**
 * Check domain health based on mailbox aggregation.
 * PRODUCTION-HARDENED: Uses ratio-based thresholds, not absolute counts.
 * - 30% unhealthy → WARNING
 * - 50% unhealthy → PAUSE
 * For small domains (<3 mailboxes), uses hybrid logic.
 */
const checkDomainHealth = async (domainId: string): Promise<void> => {
    const domain = await prisma.domain.findUnique({
        where: { id: domainId },
        include: { mailboxes: true }
    });
    if (!domain) return;

    const orgId = domain.organization_id;
    const totalMailboxes = domain.mailboxes.length;

    if (totalMailboxes === 0) return;

    // Count unhealthy mailboxes (anything not healthy/active/warming)
    const unhealthyMailboxes = domain.mailboxes.filter(
        m => m.status !== 'active' && m.status !== 'healthy' && m.status !== 'warming'
    );
    const unhealthyCount = unhealthyMailboxes.length;
    const unhealthyRatio = unhealthyCount / totalMailboxes;

    logger.info(`[MONITOR] Domain ${domain.domain}: ${unhealthyCount}/${totalMailboxes} unhealthy (${(unhealthyRatio * 100).toFixed(1)}%)`);

    // =========================================================================
    // RATIO-BASED DOMAIN LOGIC (Production-Hardened)
    // For large domains: use ratios
    // For small domains: use hybrid (absolute + ratio)
    // =========================================================================

    let shouldPause = false;
    let shouldWarn = false;
    let reason = '';

    if (totalMailboxes >= DOMAIN_MINIMUM_MAILBOXES) {
        // Large domain: ratio-based
        if (unhealthyRatio >= DOMAIN_PAUSE_RATIO) {
            shouldPause = true;
            reason = `${(unhealthyRatio * 100).toFixed(0)}% mailboxes unhealthy (${unhealthyCount}/${totalMailboxes}) - exceeds ${(DOMAIN_PAUSE_RATIO * 100).toFixed(0)}% threshold`;
        } else if (unhealthyRatio >= DOMAIN_WARNING_RATIO) {
            shouldWarn = true;
            reason = `${(unhealthyRatio * 100).toFixed(0)}% mailboxes unhealthy (${unhealthyCount}/${totalMailboxes}) - exceeds ${(DOMAIN_WARNING_RATIO * 100).toFixed(0)}% warning`;
        }
    } else {
        // Small domain (<3 mailboxes): hybrid logic
        // Pause if 2+ unhealthy (matches old behavior for tiny domains)
        if (unhealthyCount >= 2) {
            shouldPause = true;
            reason = `${unhealthyCount}/${totalMailboxes} mailboxes unhealthy (small domain, absolute threshold)`;
        } else if (unhealthyCount >= 1 && totalMailboxes <= 2) {
            // Very small domain (1-2 mailboxes): warn if 1 is unhealthy
            shouldWarn = true;
            reason = `${unhealthyCount}/${totalMailboxes} mailbox unhealthy (small domain warning)`;
        }
    }

    // Handle WARNING state
    if (shouldWarn && domain.status === 'healthy') {
        await prisma.domain.update({
            where: { id: domainId },
            data: { status: 'warning' }
        });

        await prisma.stateTransition.create({
            data: {
                organization_id: orgId,
                entity_type: 'domain',
                entity_id: domainId,
                from_state: domain.status,
                to_state: 'warning',
                reason,
                triggered_by: 'ratio_warning'
            }
        });

        await auditLogService.logAction({
            organizationId: orgId,
            entity: 'domain',
            entityId: domainId,
            trigger: 'monitor_aggregation',
            action: 'warning',
            details: `⚠️ WARNING: ${reason}`
        });

        logger.info(`[MONITOR] ⚠️ Domain ${domain.domain} entered WARNING state: ${reason}`);
    }

    // Handle PAUSE state
    if (shouldPause && domain.status !== 'paused') {
        const consecutivePauses = domain.consecutive_pauses + 1;
        const cooldownMs = Math.min(
            COOLDOWN_MINIMUM_MS * Math.pow(COOLDOWN_MULTIPLIER, Math.min(consecutivePauses - 1, 5)),
            COOLDOWN_MAX_MS
        );
        const cooldownUntil = new Date(Date.now() + cooldownMs);

        await eventService.storeEvent({
            organizationId: orgId,
            eventType: EventType.DOMAIN_PAUSED,
            entityType: 'domain',
            entityId: domainId,
            payload: { unhealthyCount, unhealthyRatio, reason }
        });

        await prisma.domain.update({
            where: { id: domainId },
            data: {
                status: 'paused',
                paused_reason: reason,
                warning_count: { increment: 1 },
                last_pause_at: new Date(),
                cooldown_until: cooldownUntil,
                consecutive_pauses: consecutivePauses
            }
        });

        await prisma.stateTransition.create({
            data: {
                organization_id: orgId,
                entity_type: 'domain',
                entity_id: domainId,
                from_state: domain.status,
                to_state: 'paused',
                reason,
                triggered_by: 'ratio_threshold_breach'
            }
        });

        await auditLogService.logAction({
            organizationId: orgId,
            entity: 'domain',
            entityId: domainId,
            trigger: 'monitor_aggregation',
            action: 'pause',
            details: `🛑 PAUSED: ${reason} (cooldown: ${Math.round(cooldownMs / 3600000)}h)`
        });

        // Cascade pause to remaining active mailboxes
        const activeMailboxes = domain.mailboxes.filter(m => m.status === 'active' || m.status === 'healthy');
        if (activeMailboxes.length > 0) {
            await prisma.mailbox.updateMany({
                where: { domain_id: domainId, status: { in: ['active', 'healthy'] } },
                data: { status: 'paused' }
            });

            await auditLogService.logAction({
                organizationId: orgId,
                entity: 'domain',
                entityId: domainId,
                trigger: 'monitor_cascade',
                action: 'pause_all',
                details: `Cascaded pause to ${activeMailboxes.length} remaining mailboxes`
            });
        }

        logger.info(`[MONITOR] 🛑 Domain ${domain.domain} PAUSED: ${reason}`);
    }
};

// ============================================================================
// CORRELATION-AWARE HELPERS
// ============================================================================

/**
 * Pause a domain directly (called when correlation escalates mailbox pause to domain).
 */
const pauseDomain = async (domainId: string, reason: string): Promise<void> => {
    const domain = await prisma.domain.findUnique({
        where: { id: domainId },
        include: { mailboxes: true },
    });
    if (!domain || domain.status === 'paused') return;

    const orgId = domain.organization_id;
    const consecutivePauses = domain.consecutive_pauses + 1;
    const cooldownMs = COOLDOWN_MINIMUM_MS * Math.pow(COOLDOWN_MULTIPLIER, Math.min(consecutivePauses - 1, 5));
    const cooldownUntil = new Date(Date.now() + cooldownMs);

    await prisma.domain.update({
        where: { id: domainId },
        data: {
            status: 'paused',
            recovery_phase: 'paused',
            paused_reason: reason,
            last_pause_at: new Date(),
            cooldown_until: cooldownUntil,
            consecutive_pauses: consecutivePauses,
            resilience_score: Math.max(0, (domain.resilience_score || 50) - 15),
            clean_sends_since_phase: 0,
            phase_entered_at: new Date(),
        },
    });

    // Cascade pause to active mailboxes
    await prisma.mailbox.updateMany({
        where: { domain_id: domainId, status: { in: ['active', 'healthy', 'warning'] } },
        data: { status: 'paused', recovery_phase: 'paused' },
    });

    await prisma.stateTransition.create({
        data: {
            organization_id: orgId,
            entity_type: 'domain',
            entity_id: domainId,
            from_state: domain.status,
            to_state: 'paused',
            reason: `[correlation_escalation] ${reason}`,
            triggered_by: 'correlation_check',
        },
    });

    await auditLogService.logAction({
        organizationId: orgId,
        entity: 'domain',
        entityId: domainId,
        trigger: 'correlation_escalation',
        action: 'pause',
        details: `Domain paused via correlation escalation: ${reason}`,
    });
};

/**
 * Pause a campaign (called when correlation redirects mailbox pause to campaign).
 */
const pauseCampaign = async (campaignId: string, organizationId: string, reason: string): Promise<void> => {
    const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
    if (!campaign || campaign.status === 'paused') return;

    await prisma.campaign.update({
        where: { id: campaignId },
        data: { status: 'paused' },
    });

    await prisma.stateTransition.create({
        data: {
            organization_id: organizationId,
            entity_type: 'campaign',
            entity_id: campaignId,
            from_state: campaign.status,
            to_state: 'paused',
            reason: `[correlation_redirect] ${reason}`,
            triggered_by: 'correlation_check',
        },
    });

    await auditLogService.logAction({
        organizationId,
        entity: 'campaign',
        entityId: campaignId,
        trigger: 'correlation_redirect',
        action: 'pause',
        details: `Campaign paused via correlation redirect: ${reason}`,
    });
};

/**
 * Apply provider restriction to a mailbox instead of full pause.
 */
const applyProviderRestriction = async (
    mailboxId: string,
    organizationId: string,
    provider: string,
    reason: string
): Promise<void> => {
    const mailbox = await prisma.mailbox.findUnique({ where: { id: mailboxId } });
    if (!mailbox) return;

    // Merge provider into existing restrictions
    const existing = (mailbox.provider_restrictions as string[] | null) || [];
    if (existing.includes(provider)) return; // Already restricted

    const updated = [...existing, provider];

    await prisma.mailbox.update({
        where: { id: mailboxId },
        data: { provider_restrictions: updated },
    });

    await prisma.stateTransition.create({
        data: {
            organization_id: organizationId,
            entity_type: 'mailbox',
            entity_id: mailboxId,
            from_state: mailbox.status,
            to_state: `provider_restricted:${provider}`,
            reason: `[correlation_provider] ${reason}`,
            triggered_by: 'correlation_check',
        },
    });

    await auditLogService.logAction({
        organizationId,
        entity: 'mailbox',
        entityId: mailboxId,
        trigger: 'correlation_provider',
        action: 'provider_restriction',
        details: `Provider restriction applied: ${provider}. ${reason}`,
    });
};
