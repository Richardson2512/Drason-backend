/**
 * Smartlead Event Parser Service
 *
 * Handles the heavy business logic for parsing and processing real-time events.
 */
import { prisma } from '../index';
import { logger } from '../services/observabilityService';
import * as auditLogService from '../services/auditLogService';
import * as entityStateService from '../services/entityStateService';
import * as campaignHealthService from '../services/campaignHealthService';
import * as notificationService from '../services/notificationService';
import { calculateEngagementScore, calculateFinalScore } from './leadScoringService';
import { LeadState, TriggerType } from '../types';

/**
 * Recalculate lead_score from engagement counters using the proper formula.
 * Called after each open/click/reply webhook to keep scores accurate in real-time.
 */
async function recalculateLeadScore(leadId: string): Promise<void> {
    const lead = await prisma.lead.findUnique({
        where: { id: leadId },
        select: {
            emails_opened: true,
            emails_clicked: true,
            emails_replied: true,
            last_activity_at: true,
        }
    });
    if (!lead) return;

    const breakdown = calculateEngagementScore({
        opens: lead.emails_opened || 0,
        clicks: lead.emails_clicked || 0,
        replies: lead.emails_replied || 0,
        bounces: 0,
        lastEngagementDate: lead.last_activity_at || undefined,
    });
    const newScore = calculateFinalScore(breakdown);

    await prisma.lead.update({
        where: { id: leadId },
        data: { lead_score: newScore }
    });
}

/**
 * Handle email sent events
 */
export async function handleSentEvent(orgId: string, event: any) {
    const campaignIdRaw = event.campaign_id;
    const mailboxIdRaw = event.email_account_id || event.mailbox_id;
    const campaignId = campaignIdRaw ? String(campaignIdRaw) : undefined;
    const mailboxId = mailboxIdRaw ? String(mailboxIdRaw) : undefined;
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
    // Use updateMany to avoid P2025 if campaign hasn't been synced yet
    if (campaignId) {
        await prisma.campaign.updateMany({
            where: { id: campaignId.toString() },
            data: {
                total_sent: { increment: 1 }
            }
        }).catch(err => {
            logger.warn('[SMARTLEAD-WEBHOOK] Failed to update campaign sent count', { campaignId, error: err.message });
        });
    }

    // Update mailbox sent count
    // Use updateMany to avoid P2025 if mailbox hasn't been synced yet
    if (mailboxId) {
        await prisma.mailbox.updateMany({
            where: { id: mailboxId.toString() },
            data: {
                total_sent_count: { increment: 1 },
                window_sent_count: { increment: 1 },
                last_activity_at: new Date()
            }
        }).catch(err => {
            logger.warn('[SMARTLEAD-WEBHOOK] Failed to update mailbox sent count', { mailboxId, error: err.message });
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
 * Handle email open events (SOFT SIGNAL - informational only, never triggers auto-pause)
 */
export async function handleOpenEvent(orgId: string, event: any) {
    const email = event.email || event.lead_email;
    const campaignIdRaw = event.campaign_id;
    const mailboxIdRaw = event.email_account_id || event.mailbox_id;
    const campaignId = campaignIdRaw ? String(campaignIdRaw) : undefined;
    const mailboxId = mailboxIdRaw ? String(mailboxIdRaw) : undefined;

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
            // Update engagement counters
            await prisma.lead.update({
                where: { id: lead.id },
                data: {
                    emails_opened: { increment: 1 },
                    last_activity_at: new Date(),
                    updated_at: new Date()
                }
            });

            // Recalculate lead_score from proper formula (engagement + recency + frequency)
            await recalculateLeadScore(lead.id);

            // Fetch mailbox for context
            const mailboxEmail = mailboxId ? await prisma.mailbox.findUnique({
                where: { id: mailboxId.toString() },
                select: { email: true }
            }) : null;

            const campaignName = campaignId ? await prisma.campaign.findUnique({
                where: { id: campaignId.toString() },
                select: { name: true }
            }) : null;

            // Log to timeline
            await auditLogService.logAction({
                organizationId: orgId,
                entity: 'lead',
                entityId: lead.id,
                trigger: 'smartlead_webhook',
                action: 'email_opened',
                details: `Opened email${campaignName ? ` from campaign "${campaignName.name}"` : ''}${mailboxEmail ? ` via ${mailboxEmail.email}` : ''}`
            });
        }
    }

    // Update campaign open count (SOFT SIGNAL)
    if (campaignId) {
        const campaign = await prisma.campaign.findUnique({
            where: { id: campaignId.toString() },
            select: { total_sent: true, open_count: true }
        });

        if (campaign) {
            const newOpenCount = campaign.open_count + 1;
            const openRate = campaign.total_sent > 0
                ? (newOpenCount / campaign.total_sent) * 100
                : 0;

            await prisma.campaign.update({
                where: { id: campaignId.toString() },
                data: {
                    open_count: newOpenCount,
                    open_rate: openRate,
                    analytics_updated_at: new Date()
                }
            }).catch(err => {
                logger.warn('[SMARTLEAD-WEBHOOK] Failed to update campaign open count', {
                    campaignId,
                    error: err.message
                });
            });
        }
    }

    // Update mailbox open count and engagement rate (SOFT SIGNAL)
    if (mailboxId) {
        const mailbox = await prisma.mailbox.findUnique({
            where: { id: mailboxId.toString() },
            select: {
                total_sent_count: true,
                open_count_lifetime: true,
                click_count_lifetime: true,
                reply_count_lifetime: true
            }
        });

        if (mailbox) {
            const newOpenCount = mailbox.open_count_lifetime + 1;
            const totalEngagement = newOpenCount + mailbox.click_count_lifetime + mailbox.reply_count_lifetime;
            const engagementRate = mailbox.total_sent_count > 0
                ? (totalEngagement / mailbox.total_sent_count) * 100
                : 0;

            await prisma.mailbox.update({
                where: { id: mailboxId.toString() },
                data: {
                    open_count_lifetime: newOpenCount,
                    engagement_rate: engagementRate
                }
            }).catch(err => {
                logger.warn('[SMARTLEAD-WEBHOOK] Failed to update mailbox open count', {
                    mailboxId,
                    error: err.message
                });
            });
        }
    }
}

/**
 * Handle email click events (SOFT SIGNAL - informational only, never triggers auto-pause)
 */
export async function handleClickEvent(orgId: string, event: any) {
    const email = event.email || event.lead_email;
    const campaignIdRaw = event.campaign_id;
    const mailboxIdRaw = event.email_account_id || event.mailbox_id;
    const campaignId = campaignIdRaw ? String(campaignIdRaw) : undefined;
    const mailboxId = mailboxIdRaw ? String(mailboxIdRaw) : undefined;

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
            // Update engagement counters
            await prisma.lead.update({
                where: { id: lead.id },
                data: {
                    emails_clicked: { increment: 1 },
                    last_activity_at: new Date(),
                    updated_at: new Date()
                }
            });

            // Recalculate lead_score from proper formula (engagement + recency + frequency)
            await recalculateLeadScore(lead.id);

            // Fetch mailbox for context
            const mailboxEmail = mailboxId ? await prisma.mailbox.findUnique({
                where: { id: mailboxId.toString() },
                select: { email: true }
            }) : null;

            const campaignName = campaignId ? await prisma.campaign.findUnique({
                where: { id: campaignId.toString() },
                select: { name: true }
            }) : null;

            // Log to timeline
            await auditLogService.logAction({
                organizationId: orgId,
                entity: 'lead',
                entityId: lead.id,
                trigger: 'smartlead_webhook',
                action: 'email_clicked',
                details: `Clicked link${campaignName ? ` in campaign "${campaignName.name}"` : ''}${mailboxEmail ? ` via ${mailboxEmail.email}` : ''}`
            });
        }
    }

    // Update campaign click count (SOFT SIGNAL)
    if (campaignId) {
        const campaign = await prisma.campaign.findUnique({
            where: { id: campaignId.toString() },
            select: { total_sent: true, click_count: true }
        });

        if (campaign) {
            const newClickCount = campaign.click_count + 1;
            const clickRate = campaign.total_sent > 0
                ? (newClickCount / campaign.total_sent) * 100
                : 0;

            await prisma.campaign.update({
                where: { id: campaignId.toString() },
                data: {
                    click_count: newClickCount,
                    click_rate: clickRate,
                    analytics_updated_at: new Date()
                }
            }).catch(err => {
                logger.warn('[SMARTLEAD-WEBHOOK] Failed to update campaign click count', {
                    campaignId,
                    error: err.message
                });
            });
        }
    }

    // Update mailbox click count and engagement rate (SOFT SIGNAL)
    if (mailboxId) {
        const mailbox = await prisma.mailbox.findUnique({
            where: { id: mailboxId.toString() },
            select: {
                total_sent_count: true,
                open_count_lifetime: true,
                click_count_lifetime: true,
                reply_count_lifetime: true
            }
        });

        if (mailbox) {
            const newClickCount = mailbox.click_count_lifetime + 1;
            const totalEngagement = mailbox.open_count_lifetime + newClickCount + mailbox.reply_count_lifetime;
            const engagementRate = mailbox.total_sent_count > 0
                ? (totalEngagement / mailbox.total_sent_count) * 100
                : 0;

            await prisma.mailbox.update({
                where: { id: mailboxId.toString() },
                data: {
                    click_count_lifetime: newClickCount,
                    engagement_rate: engagementRate
                }
            }).catch(err => {
                logger.warn('[SMARTLEAD-WEBHOOK] Failed to update mailbox click count', {
                    mailboxId,
                    error: err.message
                });
            });
        }
    }
}

/**
 * Handle reply events (SOFT SIGNAL - informational only, never triggers auto-pause)
 */
export async function handleReplyEvent(orgId: string, event: any) {
    const email = event.email || event.lead_email;
    const campaignIdRaw = event.campaign_id;
    const mailboxIdRaw = event.email_account_id || event.mailbox_id;
    const campaignId = campaignIdRaw ? String(campaignIdRaw) : undefined;
    const mailboxId = mailboxIdRaw ? String(mailboxIdRaw) : undefined;

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
            // Update engagement counters (status stays unchanged — no direct write)
            await prisma.lead.update({
                where: { id: lead.id },
                data: {
                    emails_replied: { increment: 1 },
                    last_activity_at: new Date(),
                    updated_at: new Date()
                }
            });

            // Recalculate lead_score from proper formula (engagement + recency + frequency)
            await recalculateLeadScore(lead.id);

            // Fetch mailbox for context
            const mailboxEmail = mailboxId ? await prisma.mailbox.findUnique({
                where: { id: mailboxId.toString() },
                select: { email: true }
            }) : null;

            const campaignName = campaignId ? await prisma.campaign.findUnique({
                where: { id: campaignId.toString() },
                select: { name: true }
            }) : null;

            // Log to timeline
            await auditLogService.logAction({
                organizationId: orgId,
                entity: 'lead',
                entityId: lead.id,
                trigger: 'smartlead_webhook',
                action: 'email_replied',
                details: `Replied to email${campaignName ? ` from campaign "${campaignName.name}"` : ''}${mailboxEmail ? ` sent by ${mailboxEmail.email}` : ''}`
            });
        }
    }

    // Update campaign reply count (SOFT SIGNAL)
    if (campaignId) {
        const campaign = await prisma.campaign.findUnique({
            where: { id: campaignId.toString() },
            select: { total_sent: true, reply_count: true }
        });

        if (campaign) {
            const newReplyCount = campaign.reply_count + 1;
            const replyRate = campaign.total_sent > 0
                ? (newReplyCount / campaign.total_sent) * 100
                : 0;

            await prisma.campaign.update({
                where: { id: campaignId.toString() },
                data: {
                    reply_count: newReplyCount,
                    reply_rate: replyRate,
                    analytics_updated_at: new Date()
                }
            }).catch(err => {
                logger.warn('[SMARTLEAD-WEBHOOK] Failed to update campaign reply count', {
                    campaignId,
                    error: err.message
                });
            });
        }
    }

    // Update mailbox reply count and engagement rate (SOFT SIGNAL)
    if (mailboxId) {
        const mailbox = await prisma.mailbox.findUnique({
            where: { id: mailboxId.toString() },
            select: {
                total_sent_count: true,
                open_count_lifetime: true,
                click_count_lifetime: true,
                reply_count_lifetime: true
            }
        });

        if (mailbox) {
            const newReplyCount = mailbox.reply_count_lifetime + 1;
            const totalEngagement = mailbox.open_count_lifetime + mailbox.click_count_lifetime + newReplyCount;
            const engagementRate = mailbox.total_sent_count > 0
                ? (totalEngagement / mailbox.total_sent_count) * 100
                : 0;

            await prisma.mailbox.update({
                where: { id: mailboxId.toString() },
                data: {
                    reply_count_lifetime: newReplyCount,
                    engagement_rate: engagementRate
                }
            }).catch(err => {
                logger.warn('[SMARTLEAD-WEBHOOK] Failed to update mailbox reply count', {
                    mailboxId,
                    error: err.message
                });
            });
        }
    }
}

/**
 * Handle unsubscribe events (SOFT SIGNAL - informational only)
 */
export async function handleUnsubscribeEvent(orgId: string, event: any) {
    const email = event.email || event.lead_email;
    const campaignIdRaw = event.campaign_id;
    const campaignId = campaignIdRaw ? String(campaignIdRaw) : undefined;

    if (email) {
        // Transition lead to BLOCKED via state machine (org+email is unique)
        const lead = await prisma.lead.findUnique({
            where: { organization_id_email: { organization_id: orgId, email } }
        });
        if (lead) {
            await entityStateService.transitionLead(
                orgId, lead.id, LeadState.BLOCKED,
                'Lead unsubscribed', TriggerType.WEBHOOK
            );
            await prisma.lead.update({
                where: { id: lead.id },
                data: { health_state: 'unhealthy', updated_at: new Date() }
            });
        }
    }

    // Update campaign unsubscribe count (SOFT SIGNAL)
    if (campaignId) {
        await prisma.campaign.update({
            where: { id: campaignId.toString() },
            data: {
                unsubscribed_count: { increment: 1 },
                analytics_updated_at: new Date()
            }
        }).catch(err => {
            logger.warn('[SMARTLEAD-WEBHOOK] Failed to update campaign unsubscribe count', {
                campaignId,
                error: err.message
            });
        });
    }
}

/**
 * Handle spam complaint events (SOFT SIGNAL - logged but doesn't auto-pause)
 */
export async function handleSpamEvent(orgId: string, event: any) {
    const email = event.email || event.lead_email;
    const mailboxIdRaw = event.email_account_id || event.mailbox_id;
    const mailboxId = mailboxIdRaw ? String(mailboxIdRaw) : undefined;

    if (email) {
        // Transition lead to BLOCKED via state machine (org+email is unique)
        const lead = await prisma.lead.findUnique({
            where: { organization_id_email: { organization_id: orgId, email } }
        });
        if (lead) {
            await entityStateService.transitionLead(
                orgId, lead.id, LeadState.BLOCKED,
                'Spam complaint received', TriggerType.WEBHOOK
            );
            await prisma.lead.update({
                where: { id: lead.id },
                data: { health_state: 'unhealthy', health_classification: 'red', updated_at: new Date() }
            });
        }
    }

    // Update mailbox spam count (SOFT SIGNAL - logged but doesn't auto-pause)
    if (mailboxId) {
        await prisma.mailbox.update({
            where: { id: mailboxId.toString() },
            data: {
                spam_count: { increment: 1 }
            }
        }).catch(err => {
            logger.warn('[SMARTLEAD-WEBHOOK] Failed to update mailbox spam count', {
                mailboxId,
                error: err.message
            });
        });

        // Flag mailbox as potentially compromised (logged in audit trail)
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

/**
 * Handle campaign status changed events from Smartlead.
 * Syncs campaign status when it changes externally (paused, completed, etc.)
 */
export async function handleCampaignStatusChangedEvent(orgId: string, event: any) {
    const campaignIdRaw = event.campaign_id;
    const campaignId = campaignIdRaw ? String(campaignIdRaw) : undefined;
    const newStatus = (event.status || event.new_status || '').toLowerCase();
    const oldStatus = (event.old_status || event.previous_status || '').toLowerCase();

    if (!campaignId) {
        logger.warn('[SMARTLEAD-WEBHOOK] Campaign status changed event missing campaign_id', {
            organizationId: orgId,
            event
        });
        return;
    }

    logger.info('[SMARTLEAD-WEBHOOK] Processing campaign status changed event', {
        organizationId: orgId,
        campaignId,
        oldStatus,
        newStatus
    });

    // Find the campaign in our DB
    const campaign = await prisma.campaign.findUnique({
        where: { id: campaignId },
        select: { id: true, name: true, status: true }
    });

    if (!campaign) {
        logger.warn('[SMARTLEAD-WEBHOOK] Campaign not found for status change', {
            organizationId: orgId,
            campaignId
        });
        return;
    }

    // Skip if status hasn't actually changed
    if (campaign.status === newStatus) {
        logger.info('[SMARTLEAD-WEBHOOK] Campaign status unchanged, skipping', {
            organizationId: orgId,
            campaignId,
            status: newStatus
        });
        return;
    }

    // Route through campaignHealthService for proper state tracking
    if (newStatus === 'paused') {
        await campaignHealthService.pauseCampaign(
            orgId,
            campaignId,
            `Campaign paused externally in Smartlead${oldStatus ? ` (was: ${oldStatus})` : ''}`
        );
    } else if (newStatus === 'active') {
        await campaignHealthService.resumeCampaign(orgId, campaignId);
    } else {
        // For other statuses (completed, draft, etc.) update directly + record transition
        await prisma.campaign.update({
            where: { id: campaignId },
            data: { status: newStatus }
        });

        await prisma.stateTransition.create({
            data: {
                organization_id: orgId,
                entity_type: 'campaign',
                entity_id: campaignId,
                from_state: campaign.status,
                to_state: newStatus,
                reason: `Campaign status changed in Smartlead`,
                triggered_by: 'webhook',
            }
        });
    }

    await auditLogService.logAction({
        organizationId: orgId,
        entity: 'campaign',
        entityId: campaignId,
        trigger: 'smartlead_webhook',
        action: 'campaign_status_changed',
        details: `Campaign "${campaign.name}" status changed: ${campaign.status} → ${newStatus}`
    });

    // Notify user of external status change
    try {
        await notificationService.createNotification(orgId, {
            type: newStatus === 'paused' ? 'WARNING' : 'INFO',
            title: 'Campaign Status Changed in Smartlead',
            message: `Campaign "${campaign.name}" was ${newStatus === 'paused' ? 'paused' : `changed to ${newStatus}`} in Smartlead.`
        });
    } catch (notifError) {
        logger.error('[SMARTLEAD-WEBHOOK] Failed to send campaign status notification', notifError as Error);
    }
}

/**
 * Handle lead category updated events from Smartlead.
 * Captures lead categorization (interested, not_interested, do_not_contact, etc.)
 */
export async function handleLeadCategoryUpdatedEvent(orgId: string, event: any) {
    const email = event.email || event.lead_email;
    const campaignIdRaw = event.campaign_id;
    const campaignId = campaignIdRaw ? String(campaignIdRaw) : undefined;
    const category = event.category || event.lead_category || event.new_category || '';

    logger.info('[SMARTLEAD-WEBHOOK] Processing lead category updated event', {
        organizationId: orgId,
        email,
        campaignId,
        category
    });

    if (!email) {
        logger.warn('[SMARTLEAD-WEBHOOK] Lead category event missing email', {
            organizationId: orgId,
            event
        });
        return;
    }

    // Find the lead
    const lead = await prisma.lead.findUnique({
        where: {
            organization_id_email: {
                organization_id: orgId,
                email: email
            }
        }
    });

    if (!lead) {
        logger.warn('[SMARTLEAD-WEBHOOK] Lead not found for category update', {
            organizationId: orgId,
            email,
            category
        });
        return;
    }

    const normalizedCategory = category.toLowerCase().replace(/\s+/g, '_');

    // Always persist the category on the lead record
    await prisma.lead.update({
        where: { id: lead.id },
        data: {
            lead_category: normalizedCategory,
            updated_at: new Date()
        }
    });

    // Handle "do not contact" / "not interested" as blocking signals
    if (['do_not_contact', 'not_interested', 'wrong_person', 'opted_out'].includes(normalizedCategory)) {
        await entityStateService.transitionLead(
            orgId, lead.id, LeadState.BLOCKED,
            `Lead categorized as "${category}" in Smartlead`,
            TriggerType.WEBHOOK
        );

        await prisma.lead.update({
            where: { id: lead.id },
            data: {
                health_state: 'unhealthy',
            }
        });
    }

    // Handle "interested" / "meeting_booked" as positive signals
    if (['interested', 'meeting_booked', 'meeting_completed', 'closed'].includes(normalizedCategory)) {
        // Recalculate score with a boost
        await recalculateLeadScore(lead.id);
    }

    // Log to timeline regardless of category
    const campaignName = campaignId ? await prisma.campaign.findUnique({
        where: { id: campaignId },
        select: { name: true }
    }) : null;

    await auditLogService.logAction({
        organizationId: orgId,
        entity: 'lead',
        entityId: lead.id,
        trigger: 'smartlead_webhook',
        action: 'lead_category_updated',
        details: `Lead categorized as "${category}"${campaignName ? ` in campaign "${campaignName.name}"` : ''}`
    });
}
