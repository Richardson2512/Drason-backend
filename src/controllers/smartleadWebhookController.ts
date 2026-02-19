/**
 * Smartlead Webhook Controller
 *
 * Handles real-time events from Smartlead including bounces, deliveries, opens, clicks, and replies.
 * Critical for tracking deliverability health and bounce rates.
 */

import { Request, Response } from 'express';
import { prisma } from '../index';
import { logger } from '../services/observabilityService';
import * as auditLogService from '../services/auditLogService';
import { getOrgId } from '../middleware/orgContext';
import { RecoveryPhase } from '../types';

/**
 * Handle Smartlead webhook events.
 *
 * Supported event types:
 * - email_sent: Email sent successfully
 * - email_opened: Recipient opened email
 * - email_clicked: Recipient clicked link
 * - email_replied: Recipient replied
 * - email_bounced: Email bounced (hard or soft)
 * - email_unsubscribed: Recipient unsubscribed
 * - email_spam_reported: Email marked as spam
 */
export const handleSmartleadWebhook = async (req: Request, res: Response) => {
    try {
        const orgId = getOrgId(req);
        const event = req.body;

        logger.info('[SMARTLEAD-WEBHOOK] Received event', {
            organizationId: orgId,
            eventType: event.event_type || event.type,
            eventId: event.id,
            email: event.email || event.lead_email,
            campaignId: event.campaign_id,
            mailboxId: event.email_account_id || event.mailbox_id
        });

        // Validate required fields
        if (!event.event_type && !event.type) {
            return res.status(400).json({
                success: false,
                error: 'Missing event_type field'
            });
        }

        const eventType = event.event_type || event.type;

        // Route event to appropriate handler
        switch (eventType) {
            case 'email_bounced':
            case 'bounce':
            case 'hard_bounce':
            case 'soft_bounce':
                await handleBounceEvent(orgId, event);
                break;

            case 'email_sent':
            case 'sent':
                await handleSentEvent(orgId, event);
                break;

            case 'email_opened':
            case 'opened':
                await handleOpenEvent(orgId, event);
                break;

            case 'email_clicked':
            case 'clicked':
                await handleClickEvent(orgId, event);
                break;

            case 'email_replied':
            case 'replied':
                await handleReplyEvent(orgId, event);
                break;

            case 'email_unsubscribed':
            case 'unsubscribed':
                await handleUnsubscribeEvent(orgId, event);
                break;

            case 'email_spam_reported':
            case 'spam_complaint':
                await handleSpamEvent(orgId, event);
                break;

            default:
                logger.warn('[SMARTLEAD-WEBHOOK] Unknown event type', {
                    organizationId: orgId,
                    eventType,
                    eventKeys: Object.keys(event)
                });
        }

        // Always return 200 to prevent retry storms
        res.json({ success: true, received: true });

    } catch (error: any) {
        logger.error('[SMARTLEAD-WEBHOOK] Error processing webhook', error, {
            body: req.body
        });

        // Still return 200 to prevent retries
        res.json({ success: false, error: error.message });
    }
};

/**
 * Handle bounce events - CRITICAL for infrastructure health
 */
async function handleBounceEvent(orgId: string, event: any) {
    const mailboxId = event.email_account_id || event.mailbox_id;
    const campaignId = event.campaign_id;
    const email = event.email || event.lead_email;
    const bounceType = event.bounce_type || 'hard'; // hard | soft
    const bounceReason = event.bounce_reason || event.reason || '';

    logger.info('[SMARTLEAD-WEBHOOK] Processing bounce event', {
        organizationId: orgId,
        mailboxId,
        campaignId,
        email,
        bounceType,
        bounceReason
    });

    // Find the lead for this email (if exists)
    let leadId: string | undefined;
    if (email) {
        const lead = await prisma.lead.findUnique({
            where: {
                organization_id_email: {
                    organization_id: orgId,
                    email: email
                }
            }
        });
        leadId = lead?.id;
    }

    // Store detailed bounce event for analytics
    await prisma.bounceEvent.create({
        data: {
            organization_id: orgId,
            lead_id: leadId,
            mailbox_id: mailboxId ? mailboxId.toString() : null,
            campaign_id: campaignId ? campaignId.toString() : null,
            bounce_type: bounceType,
            bounce_reason: bounceReason,
            email_address: email,
            sent_at: event.sent_at ? new Date(event.sent_at) : null,
            bounced_at: event.bounced_at ? new Date(event.bounced_at) : new Date()
        }
    });

    logger.info('[SMARTLEAD-WEBHOOK] Stored bounce event for analytics', {
        organizationId: orgId,
        leadId,
        mailboxId,
        campaignId
    });

    // Update mailbox bounce count
    if (mailboxId) {
        const mailbox = await prisma.mailbox.update({
            where: { id: mailboxId.toString() },
            data: {
                hard_bounce_count: { increment: 1 },
                window_bounce_count: { increment: 1 }
            },
            select: {
                recovery_phase: true,
                email: true,
                status: true,
                resilience_score: true,
                total_sent_count: true,
                hard_bounce_count: true
            }
        });

        // ── WARMUP RECOVERY: Track bounces during recovery (CRITICAL - ZERO TOLERANCE) ──
        if (mailbox.recovery_phase &&
            (mailbox.recovery_phase === 'restricted_send' || mailbox.recovery_phase === 'warm_recovery')) {

            try {
                const healingService = require('../services/healingService');
                const notificationService = require('../services/notificationService');

                logger.error('[WARMUP-RECOVERY] BOUNCE during recovery - ZERO TOLERANCE VIOLATED', undefined, {
                    organizationId: orgId,
                    mailboxId,
                    recoveryPhase: mailbox.recovery_phase,
                    bounceType,
                    bounceReason
                });

                // REGRESSION: Bounce during recovery = back to PAUSED
                await healingService.transitionPhase(
                    'mailbox',
                    mailboxId.toString(),
                    orgId,
                    mailbox.recovery_phase as RecoveryPhase,
                    RecoveryPhase.PAUSED,
                    `Bounce during ${mailbox.recovery_phase} warmup recovery: ${bounceReason}`,
                    mailbox.resilience_score || 50
                );

                // Notify user of recovery failure
                await notificationService.createNotification(orgId, {
                    type: 'ERROR',
                    title: 'Recovery Failed - Bounce Detected',
                    message: `${mailbox.email} bounced during ${mailbox.recovery_phase} warmup. Mailbox reset to PAUSED. Recovery will restart after cooldown.`
                });

                logger.warn('[WARMUP-RECOVERY] Regressed mailbox to PAUSED due to bounce during recovery', {
                    organizationId: orgId,
                    mailboxId,
                    fromPhase: mailbox.recovery_phase,
                    toPhase: 'paused'
                });

            } catch (healingError: any) {
                logger.error('[WARMUP-RECOVERY] Failed to handle recovery bounce', healingError, {
                    organizationId: orgId,
                    mailboxId
                });
            }
        }

        // Real-time auto-pause: Check if mailbox exceeds 3% bounce threshold
        const updatedMailbox = mailbox;

        if (updatedMailbox && updatedMailbox.total_sent_count >= 60) {
            const bounceRate = updatedMailbox.hard_bounce_count / updatedMailbox.total_sent_count;

            // Auto-pause at 3% threshold (real-time protection)
            if (bounceRate >= 0.03 && updatedMailbox.status !== 'paused') {
                // Step 1: Update mailbox status in our DB (mark as paused + cooldown)
                await prisma.mailbox.update({
                    where: { id: mailboxId.toString() },
                    data: {
                        status: 'paused',
                        recovery_phase: 'paused', // Triggers healing system entry
                        cooldown_until: new Date(Date.now() + 48 * 60 * 60 * 1000), // 48h cooldown
                        last_pause_at: new Date(),
                        consecutive_pauses: { increment: 1 },
                        resilience_score: Math.max(0, (updatedMailbox.resilience_score || 50) - 15), // -15 penalty
                        healing_origin: 'bounce_threshold' // Track why healing started
                    }
                });

                logger.warn('[SMARTLEAD-WEBHOOK] Auto-paused mailbox due to 3% bounce threshold', {
                    organizationId: orgId,
                    mailboxId,
                    email: updatedMailbox.email,
                    bounceRate: (bounceRate * 100).toFixed(2) + '%',
                    totalSent: updatedMailbox.total_sent_count,
                    totalBounced: updatedMailbox.hard_bounce_count
                });

                // Step 2: Remove mailbox from ALL campaigns in Smartlead (infrastructure hygiene)
                // This ensures Mailbox A stops sending while B, C, D continue
                const smartleadEmailAccountId = event.email_account_id || mailboxId;
                if (smartleadEmailAccountId) {
                    try {
                        const smartleadClient = require('../services/smartleadClient');
                        const result = await smartleadClient.removeMailboxFromCampaigns(
                            orgId,
                            mailboxId.toString(),
                            smartleadEmailAccountId
                        );

                        logger.info('[SMARTLEAD-WEBHOOK] Removed mailbox from Smartlead campaigns', {
                            organizationId: orgId,
                            mailboxId,
                            smartleadEmailAccountId,
                            campaignsRemoved: result.campaignsRemoved,
                            campaignsFailed: result.campaignsFailed
                        });
                    } catch (smartleadError: any) {
                        logger.error('[SMARTLEAD-WEBHOOK] Failed to remove mailbox from Smartlead campaigns', smartleadError, {
                            organizationId: orgId,
                            mailboxId,
                            smartleadEmailAccountId
                        });
                        // Continue even if Smartlead removal fails - we've paused locally
                    }
                }

                // Step 3: Notify user of auto-pause
                try {
                    const notificationService = require('../services/notificationService');
                    await notificationService.createNotification(orgId, {
                        type: 'WARNING',
                        title: 'Mailbox Auto-Paused & Removed',
                        message: `${updatedMailbox.email} paused and removed from campaigns due to ${(bounceRate * 100).toFixed(1)}% bounce rate (threshold: 3%). Other mailboxes continue sending. Review email list quality.`
                    });
                } catch (notifError) {
                    logger.error('[SMARTLEAD-WEBHOOK] Failed to send auto-pause notification', notifError as Error);
                }

                // Step 4: Audit log
                await auditLogService.logAction({
                    organizationId: orgId,
                    entity: 'mailbox',
                    entityId: mailboxId.toString(),
                    trigger: 'smartlead_webhook',
                    action: 'auto_paused_bounce_threshold',
                    details: `Auto-paused and removed from Smartlead campaigns at ${(bounceRate * 100).toFixed(1)}% bounce rate (${updatedMailbox.hard_bounce_count} bounces in ${updatedMailbox.total_sent_count} sends). Entered healing system.`
                });
            }
        }
    }

    // Update campaign bounce stats
    if (campaignId) {
        const campaign = await prisma.campaign.findUnique({
            where: { id: campaignId.toString() }
        });

        if (campaign) {
            const totalBounced = campaign.total_bounced + 1;
            const bounceRate = campaign.total_sent > 0
                ? (totalBounced / campaign.total_sent) * 100
                : 0;

            await prisma.campaign.update({
                where: { id: campaignId.toString() },
                data: {
                    total_bounced: totalBounced,
                    bounce_rate: bounceRate
                }
            });

            logger.info('[SMARTLEAD-WEBHOOK] Updated campaign bounce rate', {
                campaignId,
                totalBounced,
                totalSent: campaign.total_sent,
                bounceRate: bounceRate.toFixed(2) + '%'
            });
        }
    }

    // Update lead status if it exists
    if (leadId) {
        await prisma.lead.update({
            where: { id: leadId },
            data: {
                status: 'paused',
                health_state: 'unhealthy',
                health_classification: 'red'
            }
        });

        // Log bounce event in audit log
        await auditLogService.logAction({
            organizationId: orgId,
            entity: 'lead',
            entityId: leadId,
            trigger: 'smartlead_webhook',
            action: 'lead_bounced',
            details: `Email bounced (${bounceType}) on campaign ${campaignId || 'unknown'}`
        });
    }
}

/**
 * Handle email sent events
 */
async function handleSentEvent(orgId: string, event: any) {
    const campaignId = event.campaign_id;
    const mailboxId = event.email_account_id || event.mailbox_id;
    const email = event.email || event.lead_email;

    logger.info('[SMARTLEAD-WEBHOOK] Processing sent event', {
        organizationId: orgId,
        mailboxId,
        campaignId,
        email
    });

    // Find the lead for this email (if exists)
    let leadId: string | undefined;
    if (email) {
        const lead = await prisma.lead.findUnique({
            where: {
                organization_id_email: {
                    organization_id: orgId,
                    email: email
                }
            }
        });
        leadId = lead?.id;

        // Update lead activity stats
        if (leadId) {
            await prisma.lead.update({
                where: { id: leadId },
                data: {
                    emails_sent: { increment: 1 },
                    last_activity_at: new Date()
                }
            });
        }
    }

    // Update campaign sent count
    if (campaignId) {
        await prisma.campaign.update({
            where: { id: campaignId.toString() },
            data: {
                total_sent: { increment: 1 }
            }
        });
    }

    // Update mailbox sent count
    if (mailboxId) {
        await prisma.mailbox.update({
            where: { id: mailboxId.toString() },
            data: {
                total_sent_count: { increment: 1 },
                window_sent_count: { increment: 1 },
                last_activity_at: new Date()
            }
        });
    }

    // Log email sent activity to lead timeline
    if (leadId) {
        await auditLogService.logAction({
            organizationId: orgId,
            entity: 'lead',
            entityId: leadId,
            trigger: 'smartlead_webhook',
            action: 'email_sent',
            details: `Email sent via campaign ${campaignId || 'unknown'} from mailbox ${mailboxId || 'unknown'}`
        });

        logger.info('[SMARTLEAD-WEBHOOK] Logged email sent activity to lead timeline', {
            organizationId: orgId,
            leadId,
            campaignId,
            mailboxId
        });
    }
}

/**
 * Handle email open events
 */
async function handleOpenEvent(orgId: string, event: any) {
    const email = event.email || event.lead_email;

    if (email) {
        // Find the lead
        const lead = await prisma.lead.findUnique({
            where: {
                organization_id_email: {
                    organization_id: orgId,
                    email: email
                }
            }
        });

        if (lead) {
            // Update lead engagement score and activity stats
            await prisma.lead.update({
                where: { id: lead.id },
                data: {
                    lead_score: { increment: 5 }, // +5 points for open
                    emails_opened: { increment: 1 },
                    last_activity_at: new Date(),
                    updated_at: new Date()
                }
            });

            // Log to timeline
            await auditLogService.logAction({
                organizationId: orgId,
                entity: 'lead',
                entityId: lead.id,
                trigger: 'smartlead_webhook',
                action: 'email_opened',
                details: `Lead opened email (+5 engagement score)`
            });
        }
    }
}

/**
 * Handle email click events
 */
async function handleClickEvent(orgId: string, event: any) {
    const email = event.email || event.lead_email;

    if (email) {
        // Find the lead
        const lead = await prisma.lead.findUnique({
            where: {
                organization_id_email: {
                    organization_id: orgId,
                    email: email
                }
            }
        });

        if (lead) {
            // Update lead engagement score and activity stats
            await prisma.lead.update({
                where: { id: lead.id },
                data: {
                    lead_score: { increment: 10 }, // +10 points for click
                    emails_clicked: { increment: 1 },
                    last_activity_at: new Date(),
                    updated_at: new Date()
                }
            });

            // Log to timeline
            await auditLogService.logAction({
                organizationId: orgId,
                entity: 'lead',
                entityId: lead.id,
                trigger: 'smartlead_webhook',
                action: 'email_clicked',
                details: `Lead clicked link in email (+10 engagement score)`
            });
        }
    }
}

/**
 * Handle reply events
 */
async function handleReplyEvent(orgId: string, event: any) {
    const email = event.email || event.lead_email;

    if (email) {
        // Find the lead
        const lead = await prisma.lead.findUnique({
            where: {
                organization_id_email: {
                    organization_id: orgId,
                    email: email
                }
            }
        });

        if (lead) {
            // Update lead engagement score, status, and activity stats
            await prisma.lead.update({
                where: { id: lead.id },
                data: {
                    lead_score: { increment: 20 }, // +20 points for reply
                    status: 'active', // Keep active on reply
                    emails_replied: { increment: 1 },
                    last_activity_at: new Date(),
                    updated_at: new Date()
                }
            });

            // Log to timeline
            await auditLogService.logAction({
                organizationId: orgId,
                entity: 'lead',
                entityId: lead.id,
                trigger: 'smartlead_webhook',
                action: 'email_replied',
                details: `Lead replied to email (+20 engagement score)`
            });
        }
    }
}

/**
 * Handle unsubscribe events
 */
async function handleUnsubscribeEvent(orgId: string, event: any) {
    const email = event.email || event.lead_email;

    if (email) {
        await prisma.lead.updateMany({
            where: {
                organization_id: orgId,
                email: email
            },
            data: {
                status: 'blocked',
                health_state: 'unhealthy',
                updated_at: new Date()
            }
        });
    }
}

/**
 * Handle spam complaint events
 */
async function handleSpamEvent(orgId: string, event: any) {
    const email = event.email || event.lead_email;
    const mailboxId = event.email_account_id || event.mailbox_id;

    if (email) {
        await prisma.lead.updateMany({
            where: {
                organization_id: orgId,
                email: email
            },
            data: {
                status: 'blocked',
                health_state: 'unhealthy',
                health_classification: 'red',
                updated_at: new Date()
            }
        });
    }

    // Flag mailbox as potentially compromised (logged in audit trail)
    if (mailboxId) {
        await auditLogService.logAction({
            organizationId: orgId,
            entity: 'mailbox',
            entityId: mailboxId.toString(),
            trigger: 'smartlead_webhook',
            action: 'spam_complaint_received',
            details: `Spam complaint from ${email}`
        });
    }
}
