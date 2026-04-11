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
import { getAdapterForMailbox, getAdapterForDomain, getAdapterForCampaign } from '../adapters/platformRegistry';
import * as executionGateService from './executionGateService';
import * as notificationService from './notificationService';
import { updateDomainLastSent } from './inactivityService';
import { SlackAlertService } from './SlackAlertService';
import * as entityStateService from './entityStateService';
import * as campaignHealthService from './campaignHealthService';
import * as rotationService from './rotationService';
import { logger } from './observabilityService';
import {
    EventType,
    MailboxState,
    DomainState,
    RecoveryPhase,
    SystemMode,
    TriggerType,
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
 * @deprecated Use bounceProcessingService.processBounce() instead.
 * All platforms now use the unified bounceProcessingService for bounce
 * processing. This function is retained for backward compatibility.
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

    // ── Create BounceEvent record for analytics ──
    try {
        await prisma.bounceEvent.create({
            data: {
                organization_id: orgId,
                mailbox_id: mailboxId,
                campaign_id: campaignId || null,
                bounce_type: classification.degradesHealth ? 'hard_bounce' : 'soft_bounce',
                bounce_reason: smtpResponse || classification.rawReason || '',
                email_address: recipientEmail || '',
                bounced_at: new Date(),
            }
        });
    } catch (bounceEventErr) {
        // Non-fatal — counter increment below is the critical path
        logger.warn('[MONITOR] Failed to create BounceEvent record', { error: String(bounceEventErr) });
    }

    // ── Health-degrading bounce: update counters ATOMICALLY ──
    // Using atomic increment prevents race conditions when multiple bounces arrive simultaneously
    const updatedMailbox = await prisma.mailbox.update({
        where: { id: mailboxId },
        data: {
            window_bounce_count: { increment: 1 },  // Atomic increment
            hard_bounce_count: { increment: 1 },    // Atomic increment
            last_activity_at: new Date()
        }
    });

    // Use the atomically updated counts (guaranteed accurate even with concurrent bounces)
    const newBounceCount = updatedMailbox.window_bounce_count;
    const totalBounces = updatedMailbox.hard_bounce_count;
    const sentCount = updatedMailbox.window_sent_count;

    await auditLogService.logAction({
        organizationId: orgId,
        entity: 'mailbox',
        entityId: mailboxId,
        trigger: 'monitor_bounce',
        action: 'stat_update',
        details: `${classification.failureType} from ${classification.provider}. Window: ${newBounceCount}/${sentCount}`
    });

    // ── Relapse detection: if entity is in recovery phases, handle relapse ──
    const recoveryPhases = [
        RecoveryPhase.QUARANTINE,
        RecoveryPhase.RESTRICTED_SEND,
        RecoveryPhase.WARM_RECOVERY,
    ];
    const currentPhase = updatedMailbox.recovery_phase as RecoveryPhase;

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
    // PAUSE CHECK: 5 bounces within window
    if (newBounceCount >= MAILBOX_PAUSE_BOUNCES) {
        if (updatedMailbox.status !== 'paused') {
            await pauseMailbox(
                mailboxId,
                `Exceeded ${MAILBOX_PAUSE_BOUNCES} bounces (${newBounceCount}/${sentCount}${sentCount > 0 ? `, ${((newBounceCount / sentCount) * 100).toFixed(1)}%` : ''}). Cause: ${classification.failureType}, Provider: ${classification.provider}`
            );
        }
    }
    // WARNING CHECK: 3 bounces within 60 sends
    else if (newBounceCount >= MAILBOX_WARNING_BOUNCES && sentCount <= MAILBOX_WARNING_WINDOW) {
        if (updatedMailbox.status === 'healthy') {
            await warnMailbox(
                mailboxId,
                `Early warning: ${newBounceCount}/${sentCount} (${sentCount > 0 ? ((newBounceCount / sentCount) * 100).toFixed(1) : '0.0'}%). Cause: ${classification.failureType}`
            );
        }
    }
};

/**
 * Record a sent email event for a mailbox.
 * May trigger window reset if threshold reached.
 *
 * @deprecated Use processSentEvent() in eventQueue.ts instead.
 * All platforms now use the unified event queue for sent event processing.
 * This function is retained for backward compatibility but is no longer
 * called from the main event processing path.
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

    // Update domain last_sent_at for inactivity tracking
    if (mailbox.domain_id) {
        updateDomainLastSent(mailbox.domain_id);
    }

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

    // Legacy RECOVERING check removed — recovery is now handled by the
    // 5-phase healing pipeline (QUARANTINE → RESTRICTED_SEND → WARM_RECOVERY → HEALTHY)
    // managed by the warmupTrackingWorker. Any mailboxes still in RECOVERING
    // are auto-migrated to QUARANTINE by the metricsWorker.
};

/**
 * WARN a mailbox - early warning state before pause.
 * This gives operators time to react before damage occurs.
 * Respects system mode (ENFORCE only).
 */
export const warnMailbox = async (mailboxId: string, reason: string): Promise<void> => {
    const mailbox = await prisma.mailbox.findUnique({ where: { id: mailboxId } });
    if (!mailbox) return;

    const orgId = mailbox.organization_id;

    // ── CHECK SYSTEM MODE ──
    const systemMode = await executionGateService.getSystemMode(orgId);

    if (systemMode === SystemMode.OBSERVE) {
        // OBSERVE mode: Log only, don't change state
        await auditLogService.logAction({
            organizationId: orgId,
            entity: 'mailbox',
            entityId: mailboxId,
            trigger: 'monitor_warning',
            action: 'would_warn_observe',
            details: `⚠️ OBSERVE: Would warn mailbox - ${reason} (not enforcing in observe mode)`
        });
        logger.info(`[MONITOR] [OBSERVE] Would warn mailbox ${mailboxId}: ${reason}`);
        return;
    }

    if (systemMode === SystemMode.SUGGEST) {
        // SUGGEST mode: Create notification, don't change state
        await notificationService.createNotification(orgId, {
            type: 'WARNING',
            title: 'Mailbox Warning Recommended',
            message: `Mailbox ${mailbox.email || mailboxId} is showing early warning signs. Reason: ${reason}. Consider investigating.`
        });
        await auditLogService.logAction({
            organizationId: orgId,
            entity: 'mailbox',
            entityId: mailboxId,
            trigger: 'monitor_warning',
            action: 'suggested_warn',
            details: `⚠️ SUGGEST: Warning recommended - ${reason} (not enforcing in suggest mode)`
        });
        logger.info(`[MONITOR] [SUGGEST] Warning suggested for mailbox ${mailboxId}: ${reason}`);

        // ── SLACK ALERT: Send suggestion to Slack ──
        SlackAlertService.sendAlert({
            organizationId: orgId,
            eventType: 'suggested_warn_mailbox',
            entityId: mailboxId,
            severity: 'warning',
            title: '⚠️ Mailbox Warning Recommended',
            message: `Mailbox \`${mailbox.email || mailboxId}\` is showing early warning signs.\n*Reason:* ${reason}\n_No action taken — review recommended._`
        }).catch(err => logger.warn('[MONITOR] Non-fatal alert error', { error: String(err) }));

        return;
    }

    // ── ENFORCE MODE: Actually warn ──
    // Store warning event
    await eventService.storeEvent({
        organizationId: orgId,
        eventType: EventType.MAILBOX_PAUSED, // We'll use same event, different state
        entityType: 'mailbox',
        entityId: mailboxId,
        payload: { reason, state: 'warning' }
    });

    // Transition mailbox to WARNING via centralized state machine
    await entityStateService.transitionMailbox(
        orgId, mailboxId, MailboxState.WARNING,
        `[ENFORCE] WARNING: ${reason}`, TriggerType.THRESHOLD_BREACH
    );

    logger.info(`[MONITOR] [ENFORCE] ⚠️ Mailbox ${mailboxId} entered WARNING state: ${reason}`);
};

/**
 * Pause a mailbox due to threshold breach.
 * Implements cooldown calculation based on consecutive pauses.
 * Respects system mode (ENFORCE only).
 */
export const pauseMailbox = async (mailboxId: string, reason: string): Promise<void> => {
    const mailbox = await prisma.mailbox.findUnique({ where: { id: mailboxId } });
    if (!mailbox) return;

    const orgId = mailbox.organization_id;

    // ── CHECK SYSTEM MODE ──
    const systemMode = await executionGateService.getSystemMode(orgId);

    if (systemMode === SystemMode.OBSERVE) {
        // OBSERVE mode: Log only, don't pause
        await auditLogService.logAction({
            organizationId: orgId,
            entity: 'mailbox',
            entityId: mailboxId,
            trigger: 'monitor_threshold',
            action: 'would_pause_observe',
            details: `🛑 OBSERVE: Would pause mailbox - ${reason} (not enforcing in observe mode)`
        });
        logger.info(`[MONITOR] [OBSERVE] Would pause mailbox ${mailboxId}: ${reason}`);
        return;
    }

    if (systemMode === SystemMode.SUGGEST) {
        // SUGGEST mode: Create high-priority notification, don't pause
        await notificationService.createNotification(orgId, {
            type: 'ERROR',
            title: 'Mailbox Pause Recommended',
            message: `Mailbox ${mailbox.email || mailboxId} has exceeded bounce threshold and should be paused immediately. Reason: ${reason}. Manual intervention recommended.`
        });
        await auditLogService.logAction({
            organizationId: orgId,
            entity: 'mailbox',
            entityId: mailboxId,
            trigger: 'monitor_threshold',
            action: 'suggested_pause',
            details: `🛑 SUGGEST: Pause recommended - ${reason} (not enforcing in suggest mode)`
        });
        logger.warn(`[MONITOR] [SUGGEST] Pause recommended for mailbox ${mailboxId}: ${reason}`);

        // ── SLACK ALERT: Send suggestion to Slack ──
        SlackAlertService.sendAlert({
            organizationId: orgId,
            eventType: 'suggested_pause_mailbox',
            entityId: mailboxId,
            severity: 'critical',
            title: '🛑 Mailbox Pause Recommended',
            message: `Mailbox \`${mailbox.email || mailboxId}\` has exceeded bounce threshold and should be paused.\n*Reason:* ${reason}\n_No action taken — manual intervention recommended._`
        }).catch(err => logger.warn('[MONITOR] Non-fatal alert error', { error: String(err) }));

        return;
    }

    // ── ENFORCE MODE: Actually pause ──
    logger.info(`[MONITOR] [ENFORCE] Pausing mailbox ${mailboxId}: ${reason}`);

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
    // Adjust resilience score on pause
    const newResilience = Math.max(0, (mailbox.resilience_score || 50) - 15);

    // Store event
    await eventService.storeEvent({
        organizationId: orgId,
        eventType: EventType.MAILBOX_PAUSED,
        entityType: 'mailbox',
        entityId: mailboxId,
        payload: { reason, correlation: correlation.message }
    });

    // Transition via centralized state machine (handles status, cooldown, consecutive_pauses, audit, state history)
    const transitionResult = await entityStateService.transitionMailbox(
        orgId, mailboxId, MailboxState.PAUSED,
        `[${action.action}] ${reason}. Correlation: ${correlation.message}`,
        TriggerType.THRESHOLD_BREACH
    );

    if (transitionResult.success) {
        // Set operational fields not managed by state machine
        await prisma.mailbox.update({
            where: { id: mailboxId },
            data: {
                recovery_phase: 'paused',
                resilience_score: newResilience,
                clean_sends_since_phase: 0,
                phase_entered_at: new Date(),
            }
        });
    }

    // ── SLACK ALERT: Notify customer of mailbox pause ──
    SlackAlertService.sendAlert({
        organizationId: orgId,
        eventType: 'mailbox_paused',
        entityId: mailboxId,
        severity: 'critical',
        title: '🛑 Mailbox Paused',
        message: `Mailbox \`${mailbox.email || mailboxId}\` has been auto-paused.\n*Reason:* ${reason}`
    }).catch(err => logger.warn('[MONITOR] Non-fatal alert error', { error: String(err) }));

    // ── PLATFORM INTEGRATION: Remove mailbox from all assigned campaigns ──
    try {
        const adapter = await getAdapterForMailbox(mailboxId);
        const mailboxEntity = await prisma.mailbox.findUnique({
            where: { id: mailboxId },
            select: { external_email_account_id: true }
        });
        const campaigns = await prisma.campaign.findMany({
            where: {
                mailboxes: {
                    some: { id: mailboxId }
                }
            },
            select: { id: true, external_id: true, name: true }
        });

        for (const campaign of campaigns) {
            const externalCampaignId = campaign.external_id || campaign.id;
            const externalMailboxId = mailboxEntity?.external_email_account_id || mailboxId;
            await adapter.removeMailboxFromCampaign(
                orgId,
                externalCampaignId,
                externalMailboxId
            );
        }

        logger.info(`[MONITOR] Removed mailbox ${mailboxId} from ${campaigns.length} platform campaigns`, {
            organizationId: orgId,
            mailboxId,
            campaignCount: campaigns.length,
            platform: adapter.platform
        });

        // ── ROTATION: Attempt to rotate in a standby mailbox for affected campaigns ──
        try {
            const rotationResult = await rotationService.rotateForPausedMailbox(
                orgId,
                mailboxId,
                campaigns
            );
            logger.info(`[MONITOR] Rotation result for paused mailbox ${mailboxId}`, {
                organizationId: orgId,
                mailboxId,
                rotationsSucceeded: rotationResult.rotationsSucceeded,
                rotationsFailed: rotationResult.rotationsFailed,
                noStandbyAvailable: rotationResult.noStandbyAvailable
            });
        } catch (rotationError: any) {
            logger.error(`[MONITOR] Rotation failed for paused mailbox ${mailboxId}`, rotationError, {
                organizationId: orgId,
                mailboxId
            });
        }
    } catch (platformError: any) {
        // Platform removal failure doesn't block the pause — mailbox is already paused in Superkabe
        logger.error(`[MONITOR] Failed to remove mailbox ${mailboxId} from platform campaigns`, platformError, {
            organizationId: orgId,
            mailboxId
        });
    }

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
        // ── RE-QUERY MAILBOXES FOR FRESH DATA ──
        // Prevents stale data race condition: mailboxes may have changed status
        // since initial query at start of function
        const freshDomain = await prisma.domain.findUnique({
            where: { id: domainId },
            include: { mailboxes: true }
        });

        if (!freshDomain) return;

        const freshUnhealthyCount = freshDomain.mailboxes.filter(
            m => m.status !== 'active' && m.status !== 'healthy' && m.status !== 'warming'
        ).length;
        const freshUnhealthyRatio = freshUnhealthyCount / freshDomain.mailboxes.length;

        // Re-check threshold with fresh data
        const stillShouldWarn = freshDomain.mailboxes.length >= DOMAIN_MINIMUM_MAILBOXES
            ? freshUnhealthyRatio >= DOMAIN_WARNING_RATIO
            : (freshUnhealthyCount >= 1 && freshDomain.mailboxes.length <= 2);

        if (!stillShouldWarn) {
            logger.info(`[MONITOR] Domain ${domain.domain} warning threshold no longer met with fresh data (${freshUnhealthyCount}/${freshDomain.mailboxes.length})`);
            return;
        }

        logger.info(`[MONITOR] Domain ${domain.domain} warning confirmed with fresh data: ${freshUnhealthyCount}/${freshDomain.mailboxes.length} unhealthy`);

        // ── CHECK SYSTEM MODE ──
        const systemMode = await executionGateService.getSystemMode(orgId);

        if (systemMode === SystemMode.OBSERVE) {
            // OBSERVE mode: Log only, don't warn
            await auditLogService.logAction({
                organizationId: orgId,
                entity: 'domain',
                entityId: domainId,
                trigger: 'monitor_aggregation',
                action: 'would_warn_observe',
                details: `⚠️ OBSERVE: Would warn domain - ${reason} (not enforcing in observe mode)`
            });
            logger.info(`[MONITOR] [OBSERVE] Would warn domain ${domain.domain}: ${reason}`);
            return;
        }

        if (systemMode === SystemMode.SUGGEST) {
            // SUGGEST mode: Create notification, don't change state
            await notificationService.createNotification(orgId, {
                type: 'WARNING',
                title: 'Domain Warning Recommended',
                message: `Domain ${domain.domain} is showing warning signs. ${reason}. Consider monitoring closely.`
            });
            await auditLogService.logAction({
                organizationId: orgId,
                entity: 'domain',
                entityId: domainId,
                trigger: 'monitor_aggregation',
                action: 'suggested_warn',
                details: `⚠️ SUGGEST: Warning recommended - ${reason} (not enforcing in suggest mode)`
            });
            logger.info(`[MONITOR] [SUGGEST] Warning suggested for domain ${domain.domain}: ${reason}`);

            // ── SLACK ALERT: Send suggestion to Slack ──
            SlackAlertService.sendAlert({
                organizationId: orgId,
                eventType: 'suggested_warn_domain',
                entityId: domainId,
                severity: 'warning',
                title: '⚠️ Domain Warning Recommended',
                message: `Domain \`${domain.domain}\` is showing warning signs.\n*Reason:* ${reason}\n_No action taken — review recommended._`
            }).catch(err => logger.warn('[MONITOR] Non-fatal alert error', { error: String(err) }));

            return;
        }

        // ── ENFORCE MODE: Actually warn ──
        await entityStateService.transitionDomain(
            orgId, domainId, DomainState.WARNING,
            `[ENFORCE] ${reason}`, TriggerType.THRESHOLD_BREACH
        );

        await auditLogService.logAction({
            organizationId: orgId,
            entity: 'domain',
            entityId: domainId,
            trigger: 'monitor_aggregation',
            action: 'warning',
            details: `⚠️ [ENFORCE] WARNING: ${reason}`
        });

        logger.info(`[MONITOR] [ENFORCE] ⚠️ Domain ${domain.domain} entered WARNING state: ${reason}`);
    }

    // Handle PAUSE state
    if (shouldPause && domain.status !== 'paused') {
        // ── RE-QUERY MAILBOXES FOR FRESH DATA ──
        // Prevents stale data race condition: mailboxes may have changed status
        // since initial query at start of function
        const freshDomain = await prisma.domain.findUnique({
            where: { id: domainId },
            include: { mailboxes: true }
        });

        if (!freshDomain) return;

        const freshUnhealthyCount = freshDomain.mailboxes.filter(
            m => m.status !== 'active' && m.status !== 'healthy' && m.status !== 'warming'
        ).length;
        const freshTotalMailboxes = freshDomain.mailboxes.length;
        const freshUnhealthyRatio = freshUnhealthyCount / freshTotalMailboxes;

        // Re-check threshold with fresh data
        const stillShouldPause = freshTotalMailboxes >= DOMAIN_MINIMUM_MAILBOXES
            ? freshUnhealthyRatio >= DOMAIN_PAUSE_RATIO
            : freshUnhealthyCount >= 2;

        if (!stillShouldPause) {
            logger.info(`[MONITOR] Domain ${domain.domain} pause threshold no longer met with fresh data (${freshUnhealthyCount}/${freshTotalMailboxes})`);
            return;
        }

        logger.info(`[MONITOR] Domain ${domain.domain} pause confirmed with fresh data: ${freshUnhealthyCount}/${freshTotalMailboxes} unhealthy (${(freshUnhealthyRatio * 100).toFixed(1)}%)`);

        // Update reason with fresh counts for accurate logging
        reason = freshTotalMailboxes >= DOMAIN_MINIMUM_MAILBOXES
            ? `${(freshUnhealthyRatio * 100).toFixed(0)}% mailboxes unhealthy (${freshUnhealthyCount}/${freshTotalMailboxes}) - exceeds ${(DOMAIN_PAUSE_RATIO * 100).toFixed(0)}% threshold`
            : `${freshUnhealthyCount}/${freshTotalMailboxes} mailboxes unhealthy (small domain, absolute threshold)`;

        // ── CHECK SYSTEM MODE ──
        const systemMode = await executionGateService.getSystemMode(orgId);

        if (systemMode === SystemMode.OBSERVE) {
            // OBSERVE mode: Log only, don't pause
            await auditLogService.logAction({
                organizationId: orgId,
                entity: 'domain',
                entityId: domainId,
                trigger: 'monitor_aggregation',
                action: 'would_pause_observe',
                details: `🛑 OBSERVE: Would pause domain - ${reason} (not enforcing in observe mode)`
            });
            logger.info(`[MONITOR] [OBSERVE] Would pause domain ${domain.domain}: ${reason}`);
            return;
        }

        if (systemMode === SystemMode.SUGGEST) {
            // SUGGEST mode: Create notification, don't pause
            await notificationService.createNotification(orgId, {
                type: 'ERROR',
                title: 'Domain Pause Recommended',
                message: `Domain ${domain.domain} has ${freshUnhealthyCount}/${freshTotalMailboxes} unhealthy mailboxes and should be paused. Reason: ${reason}`
            });
            await auditLogService.logAction({
                organizationId: orgId,
                entity: 'domain',
                entityId: domainId,
                trigger: 'monitor_aggregation',
                action: 'suggested_pause',
                details: `🛑 SUGGEST: Pause recommended - ${reason} (not enforcing in suggest mode)`
            });
            logger.warn(`[MONITOR] [SUGGEST] Pause recommended for domain ${domain.domain}: ${reason}`);

            // ── SLACK ALERT: Send suggestion to Slack ──
            SlackAlertService.sendAlert({
                organizationId: orgId,
                eventType: 'suggested_pause_domain',
                entityId: domainId,
                severity: 'critical',
                title: '🛑 Domain Pause Recommended',
                message: `Domain \`${domain.domain}\` has ${freshUnhealthyCount}/${freshTotalMailboxes} unhealthy mailboxes and should be paused.\n*Reason:* ${reason}\n_No action taken — manual intervention recommended._`
            }).catch(err => logger.warn('[MONITOR] Non-fatal alert error', { error: String(err) }));

            return;
        }

        // ── ENFORCE MODE: Actually pause ──
        logger.info(`[MONITOR] [ENFORCE] Pausing domain ${domain.domain}: ${reason}`);

        await eventService.storeEvent({
            organizationId: orgId,
            eventType: EventType.DOMAIN_PAUSED,
            entityType: 'domain',
            entityId: domainId,
            payload: { unhealthyCount: freshUnhealthyCount, unhealthyRatio: freshUnhealthyRatio, reason }
        });

        // Transition via centralized state machine (handles status, cooldown, consecutive_pauses, audit, state history)
        const domainTransition = await entityStateService.transitionDomain(
            orgId, domainId, DomainState.PAUSED,
            `[ENFORCE] ${reason}`, TriggerType.THRESHOLD_BREACH
        );

        if (domainTransition.success) {
            // Set operational fields not managed by state machine
            await prisma.domain.update({
                where: { id: domainId },
                data: {
                    paused_reason: reason,
                    paused_by: 'system',
                    warning_count: { increment: 1 },
                }
            });

            // Cascade pause to remaining healthy/warning mailboxes via state machine
            const activeMailboxes = domain.mailboxes.filter(m => m.status === 'healthy' || m.status === 'warning');
            for (const mb of activeMailboxes) {
                await entityStateService.transitionMailbox(
                    orgId, mb.id, MailboxState.PAUSED,
                    `Cascaded from domain pause: ${reason}`, TriggerType.THRESHOLD_BREACH
                );
            }
        }

        logger.info(`[MONITOR] [ENFORCE] 🛑 Domain ${domain.domain} PAUSED: ${reason}`);

        // ── SLACK ALERT: Notify customer of domain pause ──
        SlackAlertService.sendAlert({
            organizationId: orgId,
            eventType: 'domain_paused',
            entityId: domainId,
            severity: 'critical',
            title: '🛑 Domain Paused',
            message: `Domain \`${domain.domain}\` has been auto-paused.\n*Reason:* ${reason}\n*Unhealthy mailboxes:* ${freshUnhealthyCount}/${freshTotalMailboxes}`
        }).catch(err => logger.warn('[MONITOR] Non-fatal alert error', { error: String(err) }));
    }
};

// ============================================================================
// CORRELATION-AWARE HELPERS
// ============================================================================

/**
 * Pause a domain directly (called when correlation escalates mailbox pause to domain).
 * Respects system mode (ENFORCE only).
 */
const pauseDomain = async (domainId: string, reason: string): Promise<void> => {
    const domain = await prisma.domain.findUnique({
        where: { id: domainId },
        include: { mailboxes: true },
    });
    if (!domain || domain.status === 'paused') return;

    const orgId = domain.organization_id;

    // ── CHECK SYSTEM MODE ──
    const systemMode = await executionGateService.getSystemMode(orgId);

    if (systemMode === SystemMode.OBSERVE) {
        // OBSERVE mode: Log only, don't pause
        await auditLogService.logAction({
            organizationId: orgId,
            entity: 'domain',
            entityId: domainId,
            trigger: 'correlation_escalation',
            action: 'would_pause_observe',
            details: `🛑 OBSERVE: Would pause domain - ${reason} (not enforcing in observe mode)`
        });
        logger.info(`[MONITOR] [OBSERVE] Would pause domain ${domainId}: ${reason}`);
        return;
    }

    if (systemMode === SystemMode.SUGGEST) {
        // SUGGEST mode: Create critical notification, don't pause
        await notificationService.createNotification(orgId, {
            type: 'ERROR',
            title: 'Domain Pause Recommended',
            message: `Domain ${domain.domain} has critical health issues and should be paused. Reason: ${reason}. Immediate action required.`
        });
        await auditLogService.logAction({
            organizationId: orgId,
            entity: 'domain',
            entityId: domainId,
            trigger: 'correlation_escalation',
            action: 'suggested_pause',
            details: `🛑 SUGGEST: Pause recommended - ${reason} (not enforcing in suggest mode)`
        });
        logger.warn(`[MONITOR] [SUGGEST] Pause recommended for domain ${domainId}: ${reason}`);

        // ── SLACK ALERT: Send suggestion to Slack ──
        SlackAlertService.sendAlert({
            organizationId: orgId,
            eventType: 'suggested_pause_domain_correlation',
            entityId: domainId,
            severity: 'critical',
            title: '🛑 Domain Pause Recommended',
            message: `Domain \`${domain.domain}\` has critical health issues and should be paused.\n*Reason:* ${reason}\n_No action taken — immediate review recommended._`
        }).catch(err => logger.warn('[MONITOR] Non-fatal alert error', { error: String(err) }));

        return;
    }

    // ── ENFORCE MODE: Actually pause ──
    logger.info(`[MONITOR] [ENFORCE] Pausing domain ${domainId}: ${reason}`);
    const newResilience = Math.max(0, (domain.resilience_score || 50) - 15);

    // Transition via centralized state machine (handles status, cooldown, consecutive_pauses, audit, state history)
    const domainTransition = await entityStateService.transitionDomain(
        orgId, domainId, DomainState.PAUSED,
        `[correlation_escalation] ${reason}`, TriggerType.THRESHOLD_BREACH
    );

    if (domainTransition.success) {
        // Set operational fields not managed by state machine
        await prisma.domain.update({
            where: { id: domainId },
            data: {
                recovery_phase: 'paused',
                paused_reason: reason,
                resilience_score: newResilience,
                clean_sends_since_phase: 0,
                phase_entered_at: new Date(),
            },
        });

        // Cascade pause to healthy/warning mailboxes via state machine
        const cascadeMailboxes = domain.mailboxes.filter(m => m.status === 'healthy' || m.status === 'warning');
        for (const mb of cascadeMailboxes) {
            const mbResult = await entityStateService.transitionMailbox(
                orgId, mb.id, MailboxState.PAUSED,
                `Cascaded from domain pause: ${reason}`, TriggerType.THRESHOLD_BREACH
            );
            if (mbResult.success) {
                await prisma.mailbox.update({
                    where: { id: mb.id },
                    data: { recovery_phase: 'paused' }
                });
            }
        }
    }

    // ── PLATFORM INTEGRATION: Remove all domain mailboxes from campaigns ──
    try {
        const adapter = await getAdapterForDomain(domainId);
        const result = await adapter.removeAllDomainMailboxes(orgId, domainId);
        logger.info(`[MONITOR] Removed domain ${domainId} mailboxes from platform`, {
            organizationId: orgId,
            domainId,
            successCount: result.success,
            failedCount: result.failed,
            platform: adapter.platform
        });
    } catch (platformError: any) {
        // Platform removal failure doesn't block the pause — domain is already paused in Superkabe
        logger.error(`[MONITOR] Failed to remove domain ${domainId} mailboxes from platform`, platformError, {
            organizationId: orgId,
            domainId
        });
    }
};

/**
 * Pause a campaign (called when correlation redirects mailbox pause to campaign).
 * Respects system mode (ENFORCE only).
 */
const pauseCampaign = async (campaignId: string, organizationId: string, reason: string): Promise<void> => {
    const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
    if (!campaign || campaign.status === 'paused') return;

    // ── CHECK SYSTEM MODE ──
    const systemMode = await executionGateService.getSystemMode(organizationId);

    if (systemMode === SystemMode.OBSERVE) {
        // OBSERVE mode: Log only, don't pause
        await auditLogService.logAction({
            organizationId,
            entity: 'campaign',
            entityId: campaignId,
            trigger: 'correlation_redirect',
            action: 'would_pause_observe',
            details: `🛑 OBSERVE: Would pause campaign - ${reason} (not enforcing in observe mode)`
        });
        logger.info(`[MONITOR] [OBSERVE] Would pause campaign ${campaignId}: ${reason}`);
        return;
    }

    if (systemMode === SystemMode.SUGGEST) {
        // SUGGEST mode: Create notification, don't pause
        await notificationService.createNotification(organizationId, {
            type: 'ERROR',
            title: 'Campaign Pause Recommended',
            message: `Campaign ${campaign.name || campaignId} should be paused due to health correlation. Reason: ${reason}. Review recommended.`
        });
        await auditLogService.logAction({
            organizationId,
            entity: 'campaign',
            entityId: campaignId,
            trigger: 'correlation_redirect',
            action: 'suggested_pause',
            details: `🛑 SUGGEST: Pause recommended - ${reason} (not enforcing in suggest mode)`
        });
        logger.warn(`[MONITOR] [SUGGEST] Pause recommended for campaign ${campaignId}: ${reason}`);

        // ── SLACK ALERT: Send suggestion to Slack ──
        SlackAlertService.sendAlert({
            organizationId,
            eventType: 'suggested_pause_campaign',
            entityId: campaignId,
            severity: 'critical',
            title: '🛑 Campaign Pause Recommended',
            message: `Campaign \`${campaign.name || campaignId}\` should be paused due to health correlation.\n*Reason:* ${reason}\n_No action taken — review recommended._`
        }).catch(err => logger.warn('[MONITOR] Non-fatal alert error', { error: String(err) }));

        return;
    }

    // ── ENFORCE MODE: Pause via campaignHealthService (central authority for campaign status + platform sync) ──
    logger.info(`[MONITOR] [ENFORCE] Pausing campaign ${campaignId}: ${reason}`);
    await campaignHealthService.pauseCampaign(organizationId, campaignId, `[correlation_redirect] ${reason}`);
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
