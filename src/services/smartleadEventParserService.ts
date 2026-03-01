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
import * as healingService from '../services/healingService';
import * as notificationService from '../services/notificationService';
import * as rotationService from './rotationService';
import { removeMailboxFromCampaigns } from '../services/smartleadInfrastructureMutator';
import { calculateEngagementScore, calculateFinalScore } from './leadScoringService';
import { RecoveryPhase, LeadState, MailboxState, TriggerType } from '../types';
import * as eventQueue from '../services/eventQueue';

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

export async function handleBounceEvent(orgId: string, event: any) {
    const mailboxIdRaw = event.email_account_id || event.mailbox_id;
    const campaignIdRaw = event.campaign_id;
    const mailboxId = mailboxIdRaw ? String(mailboxIdRaw) : undefined;
    const campaignId = campaignIdRaw ? String(campaignIdRaw) : undefined;
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
    // Guard against P2025 (record not found) so campaign + lead updates still run
    if (mailboxId) {
        let mailbox: { recovery_phase: string; email: string; status: string; resilience_score: number; total_sent_count: number; hard_bounce_count: number } | null = null;
        try {
            mailbox = await prisma.mailbox.update({
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
        } catch (mailboxErr: any) {
            if (mailboxErr.code === 'P2025') {
                logger.warn('[SMARTLEAD-WEBHOOK] Mailbox not found for bounce event, skipping mailbox stat update', { mailboxId, orgId });
            } else {
                throw mailboxErr;
            }
        }

        if (mailbox) {

        // ── WARMUP RECOVERY: Track bounces during recovery (CRITICAL - ZERO TOLERANCE) ──
        if (mailbox.recovery_phase &&
            (mailbox.recovery_phase === 'restricted_send' || mailbox.recovery_phase === 'warm_recovery')) {

            try {
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
                // Step 1a: Transition mailbox via centralized state service (validates, records history, audits)
                const transitionResult = await entityStateService.transitionMailbox(
                    orgId,
                    mailboxId.toString(),
                    MailboxState.PAUSED,
                    `Auto-paused: ${(bounceRate * 100).toFixed(1)}% bounce rate exceeds 3% threshold (${updatedMailbox.hard_bounce_count} bounces in ${updatedMailbox.total_sent_count} sends)`,
                    TriggerType.THRESHOLD_BREACH
                );

                // Step 1b: Set operational healing fields (cooldown, recovery phase, resilience)
                if (transitionResult.success) {
                    await prisma.mailbox.update({
                        where: { id: mailboxId.toString() },
                        data: {
                            recovery_phase: 'paused',
                            cooldown_until: new Date(Date.now() + 48 * 60 * 60 * 1000), // 48h cooldown
                            last_pause_at: new Date(),
                            consecutive_pauses: { increment: 1 },
                            resilience_score: Math.max(0, (updatedMailbox.resilience_score || 50) - 15),
                            healing_origin: 'bounce_threshold'
                        }
                    });
                }

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
                        const result = await removeMailboxFromCampaigns(
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

                // Step 3: Rotate in standby mailbox(es) for affected campaigns
                try {
                    const affectedCampaigns = await prisma.campaign.findMany({
                        where: { mailboxes: { some: { id: mailboxId.toString() } } },
                        select: { id: true, external_id: true, name: true }
                    });
                    if (affectedCampaigns.length > 0) {
                        const rotationResult = await rotationService.rotateForPausedMailbox(
                            orgId,
                            mailboxId.toString(),
                            affectedCampaigns
                        );
                        logger.info('[SMARTLEAD-WEBHOOK] Rotation result after bounce auto-pause', {
                            organizationId: orgId,
                            mailboxId,
                            rotationsSucceeded: rotationResult.rotationsSucceeded,
                            noStandbyAvailable: rotationResult.noStandbyAvailable
                        });
                    }
                } catch (rotationError: any) {
                    logger.error('[SMARTLEAD-WEBHOOK] Rotation failed after bounce auto-pause', rotationError, {
                        organizationId: orgId,
                        mailboxId
                    });
                }

                // Step 4: Notify user of auto-pause
                try {
                    await notificationService.createNotification(orgId, {
                        type: 'WARNING',
                        title: 'Mailbox Auto-Paused & Removed',
                        message: `${updatedMailbox.email} paused and removed from campaigns due to ${(bounceRate * 100).toFixed(1)}% bounce rate (threshold: 3%). Other mailboxes continue sending. Review email list quality.`
                    });
                } catch (notifError) {
                    logger.error('[SMARTLEAD-WEBHOOK] Failed to send auto-pause notification', notifError as Error);
                }

                // Step 5: Audit log
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
        } // end if (mailbox)
    } // end if (mailboxId)

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

    // Update lead status via centralized state service
    if (leadId) {
        await entityStateService.transitionLead(
            orgId,
            leadId,
            LeadState.PAUSED,
            `Email bounced (${bounceType}) on campaign ${campaignId || 'unknown'}`,
            TriggerType.WEBHOOK
        );

        // Also update health fields and mark as bounced
        await prisma.lead.update({
            where: { id: leadId },
            data: {
                health_state: 'unhealthy',
                health_classification: 'red',
                bounced: true
            }
        });
    }
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
