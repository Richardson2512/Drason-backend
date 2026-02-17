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
        await prisma.mailbox.update({
            where: { id: mailboxId.toString() },
            data: {
                hard_bounce_count: { increment: 1 },
                window_bounce_count: { increment: 1 }
            }
        });
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
}

/**
 * Handle email open events
 */
async function handleOpenEvent(orgId: string, event: any) {
    const email = event.email || event.lead_email;

    if (email) {
        // Update lead engagement score
        await prisma.lead.updateMany({
            where: {
                organization_id: orgId,
                email: email
            },
            data: {
                lead_score: { increment: 5 }, // +5 points for open
                updated_at: new Date()
            }
        });
    }
}

/**
 * Handle email click events
 */
async function handleClickEvent(orgId: string, event: any) {
    const email = event.email || event.lead_email;

    if (email) {
        // Update lead engagement score
        await prisma.lead.updateMany({
            where: {
                organization_id: orgId,
                email: email
            },
            data: {
                lead_score: { increment: 10 }, // +10 points for click
                updated_at: new Date()
            }
        });
    }
}

/**
 * Handle reply events
 */
async function handleReplyEvent(orgId: string, event: any) {
    const email = event.email || event.lead_email;

    if (email) {
        // Update lead engagement score and status
        await prisma.lead.updateMany({
            where: {
                organization_id: orgId,
                email: email
            },
            data: {
                lead_score: { increment: 20 }, // +20 points for reply
                status: 'active', // Keep active on reply
                updated_at: new Date()
            }
        });
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
