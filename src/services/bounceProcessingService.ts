/**
 * Unified Bounce Processing Service
 *
 * Platform-agnostic bounce processing for ALL platforms (Smartlead, EmailBison, Instantly, Reply.io, etc.)
 * Single path: webhook → storeEvent → enqueueEvent(BullMQ) → processBounce()
 *
 * Steps:
 *  1. Find mailbox
 *  2. Classify bounce (transient vs health-degrading)
 *  3. Create BounceEvent record (always, for analytics)
 *  4. If transient → audit log + return early
 *  5. Atomic increment mailbox stats
 *  6. Find + mark lead as bounced
 *  7. Update campaign bounce stats
 *  8. Recovery phase relapse check
 *  9. 3% percentage threshold (60+ sends) → pause
 * 10. 5-bounce absolute window → pause (safety net)
 * 11. 3-bounce early warning
 * 12. Audit log
 */

import { prisma } from '../index';
import { logger } from './observabilityService';
import { classifyBounce } from './bounceClassifier';
import * as auditLogService from './auditLogService';
import * as entityStateService from './entityStateService';
import * as healingService from './healingService';
import * as monitoringService from './monitoringService';
import {
    RecoveryPhase,
    LeadState,
    TriggerType,
    MONITORING_THRESHOLDS,
} from '../types';

const {
    MAILBOX_WARNING_BOUNCES,
    MAILBOX_WARNING_WINDOW,
    MAILBOX_PAUSE_BOUNCES,
} = MONITORING_THRESHOLDS;

// ============================================================================
// TYPES
// ============================================================================

export interface BounceProcessingParams {
    organizationId: string;
    mailboxId: string;          // Platform-prefixed: eb-123, inst-sender@d.com, or raw Smartlead ID
    campaignId?: string;        // Platform-prefixed
    recipientEmail?: string;    // The bounced lead email
    smtpResponse?: string;      // SMTP code + message (used for classification)
    bounceType?: string;        // 'hard' | 'soft' (from platform, stored for display)
    sentAt?: Date;
    bouncedAt?: Date;
}

// ============================================================================
// MAIN ENTRY POINT
// ============================================================================

/**
 * Process a bounce event — unified path for ALL platforms.
 *
 * Called by the BullMQ event worker (or sync fallback) after the webhook
 * controller has already stored the raw event and enqueued the job.
 */
export async function processBounce(params: BounceProcessingParams): Promise<void> {
    const {
        organizationId,
        mailboxId,
        campaignId,
        recipientEmail,
        smtpResponse,
        bounceType,
        sentAt,
        bouncedAt,
    } = params;

    // ── Step 1: Find mailbox ──
    const mailbox = await prisma.mailbox.findUnique({
        where: { id: mailboxId },
        include: { domain: true },
    });

    if (!mailbox) {
        logger.warn('[BOUNCE] Mailbox not found — webhook arrived before sync', {
            organizationId,
            mailboxId,
        });
        return;
    }

    // ── Step 2: Classify bounce ──
    const classification = classifyBounce(
        smtpResponse || 'unknown',
        recipientEmail,
    );

    logger.info('[BOUNCE] Processing bounce', {
        organizationId,
        mailboxId,
        campaignId,
        recipientEmail,
        failureType: classification.failureType,
        provider: classification.provider,
        degradesHealth: classification.degradesHealth,
        bounceType: bounceType || 'hard',
    });

    // ── Step 3: Create BounceEvent record (ALWAYS — for analytics) ──
    let leadId: string | undefined;
    const normalizedRecipient = recipientEmail?.toLowerCase().trim();
    if (normalizedRecipient) {
        const lead = await prisma.lead.findFirst({
            where: {
                organization_id: organizationId,
                email: { equals: normalizedRecipient, mode: 'insensitive' },
            },
            select: { id: true },
        });
        leadId = lead?.id;
    }

    await prisma.bounceEvent.create({
        data: {
            organization_id: organizationId,
            lead_id: leadId || null,
            mailbox_id: mailboxId,
            campaign_id: campaignId || null,
            bounce_type: bounceType || 'hard',
            bounce_reason: smtpResponse || '',
            email_address: recipientEmail || '',
            sent_at: sentAt || null,
            bounced_at: bouncedAt || new Date(),
        },
    });

    // ── Step 4: If transient → audit log + return early ──
    if (!classification.degradesHealth) {
        await auditLogService.logAction({
            organizationId,
            entity: 'mailbox',
            entityId: mailboxId,
            trigger: 'bounce_processing',
            action: 'transient_bounce',
            details: `${classification.failureType} from ${classification.provider} — not degrading health. Reason: ${classification.rawReason}`,
        });
        logger.info('[BOUNCE] Transient bounce — skipping threshold checks', {
            organizationId,
            mailboxId,
            failureType: classification.failureType,
        });
        return;
    }

    // ── Step 5: Atomic increment mailbox stats ──
    let updatedMailbox;
    try {
        updatedMailbox = await prisma.mailbox.update({
            where: { id: mailboxId },
            data: {
                hard_bounce_count: { increment: 1 },
                window_bounce_count: { increment: 1 },
                last_activity_at: new Date(),
            },
            select: {
                recovery_phase: true,
                email: true,
                status: true,
                resilience_score: true,
                total_sent_count: true,
                hard_bounce_count: true,
                window_bounce_count: true,
                window_sent_count: true,
            },
        });
    } catch (err: any) {
        if (err.code === 'P2025') {
            logger.warn('[BOUNCE] Mailbox not found during stat update (P2025)', { mailboxId, organizationId });
            return;
        }
        throw err;
    }

    await auditLogService.logAction({
        organizationId,
        entity: 'mailbox',
        entityId: mailboxId,
        trigger: 'bounce_processing',
        action: 'stat_update',
        details: `${classification.failureType} from ${classification.provider}. Window: ${updatedMailbox.window_bounce_count}/${updatedMailbox.window_sent_count}. Lifetime: ${updatedMailbox.hard_bounce_count}/${updatedMailbox.total_sent_count}`,
    });

    // ── Step 6: Find and mark lead as bounced ──
    if (leadId) {
        try {
            await entityStateService.transitionLead(
                organizationId,
                leadId,
                LeadState.PAUSED,
                `Email bounced (${bounceType || 'hard'}) on campaign ${campaignId || 'unknown'}`,
                TriggerType.WEBHOOK,
            );

            await prisma.lead.update({
                where: { id: leadId },
                data: {
                    health_state: 'unhealthy',
                    health_classification: 'red',
                    bounced: true,
                },
            });
        } catch (leadErr: any) {
            logger.warn('[BOUNCE] Failed to mark lead as bounced (lead may not exist)', {
                leadId,
                recipientEmail,
                error: leadErr.message,
            });
        }
    }

    // ── Step 7: Update campaign bounce stats ──
    if (campaignId) {
        try {
            const campaign = await prisma.campaign.findUnique({
                where: { id: campaignId },
                select: { id: true, total_bounced: true, total_sent: true },
            });

            if (campaign) {
                const totalBounced = campaign.total_bounced + 1;
                const bounceRate = campaign.total_sent > 0
                    ? (totalBounced / campaign.total_sent) * 100
                    : 0;

                await prisma.campaign.update({
                    where: { id: campaignId },
                    data: {
                        total_bounced: totalBounced,
                        bounce_rate: bounceRate,
                    },
                });

                logger.info('[BOUNCE] Updated campaign bounce stats', {
                    campaignId,
                    totalBounced,
                    totalSent: campaign.total_sent,
                    bounceRate: bounceRate.toFixed(2) + '%',
                });
            }
        } catch (campaignErr: any) {
            logger.warn('[BOUNCE] Failed to update campaign bounce stats', {
                campaignId,
                error: campaignErr.message,
            });
        }
    }

    // ── Step 8: Recovery phase relapse check ──
    const recoveryPhases = [
        RecoveryPhase.QUARANTINE,
        RecoveryPhase.RESTRICTED_SEND,
        RecoveryPhase.WARM_RECOVERY,
    ];
    const currentPhase = updatedMailbox.recovery_phase as RecoveryPhase;

    if (recoveryPhases.includes(currentPhase)) {
        const reason = `Health-degrading bounce during ${currentPhase}: ${classification.failureType} (${classification.provider})`;

        await healingService.resetCleanSends('mailbox', mailboxId);
        await healingService.handleRelapse(
            'mailbox',
            mailboxId,
            organizationId,
            currentPhase,
            reason,
        );

        logger.warn('[BOUNCE] Recovery relapse — mailbox bounced during recovery', {
            organizationId,
            mailboxId,
            fromPhase: currentPhase,
            failureType: classification.failureType,
        });

        return; // Relapse handler manages state transitions
    }

    // ── Step 9: Percentage threshold (PRIMARY) — 3% after 60+ sends ──
    if (updatedMailbox.total_sent_count >= 60) {
        const bounceRate = updatedMailbox.hard_bounce_count / updatedMailbox.total_sent_count;

        if (bounceRate >= 0.03 && updatedMailbox.status !== 'paused') {
            await monitoringService.pauseMailbox(
                mailboxId,
                `Exceeded 3% bounce rate: ${(bounceRate * 100).toFixed(1)}% (${updatedMailbox.hard_bounce_count} bounces in ${updatedMailbox.total_sent_count} sends). Cause: ${classification.failureType}, Provider: ${classification.provider}`,
            );
            return;
        }
    }

    // ── Step 10: Absolute window threshold (SAFETY NET) — 5 bounces in window ──
    if (updatedMailbox.window_bounce_count >= MAILBOX_PAUSE_BOUNCES) {
        if (updatedMailbox.status !== 'paused') {
            await monitoringService.pauseMailbox(
                mailboxId,
                `Exceeded ${MAILBOX_PAUSE_BOUNCES} bounces in window (${updatedMailbox.window_bounce_count}/${updatedMailbox.window_sent_count}). Cause: ${classification.failureType}, Provider: ${classification.provider}`,
            );
            return;
        }
    }

    // ── Step 11: Early warning — 3 bounces within 60 sends ──
    if (
        updatedMailbox.window_bounce_count >= MAILBOX_WARNING_BOUNCES &&
        updatedMailbox.window_sent_count <= MAILBOX_WARNING_WINDOW &&
        updatedMailbox.status === 'healthy'
    ) {
        await monitoringService.warnMailbox(
            mailboxId,
            `Early warning: ${updatedMailbox.window_bounce_count}/${updatedMailbox.window_sent_count} bounces (${((updatedMailbox.window_bounce_count / Math.max(updatedMailbox.window_sent_count, 1)) * 100).toFixed(1)}%). Cause: ${classification.failureType}`,
        );
    }

    // ── Step 12: Audit log ──
    await auditLogService.logAction({
        organizationId,
        entity: 'mailbox',
        entityId: mailboxId,
        trigger: 'bounce_processing',
        action: 'bounce_processed',
        details: `Bounce processed: ${classification.failureType} from ${classification.provider}. Mailbox status: ${updatedMailbox.status}. Window: ${updatedMailbox.window_bounce_count}/${updatedMailbox.window_sent_count}. Lifetime: ${updatedMailbox.hard_bounce_count}/${updatedMailbox.total_sent_count}`,
    });
}
