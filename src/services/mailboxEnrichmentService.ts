/**
 * Mailbox Enrichment Service
 *
 * Backfills mailbox engagement statistics from historical lead data.
 *
 * Strategy:
 * - Campaign leads have engagement data (emails_opened, emails_clicked, emails_replied)
 * - Campaigns are linked to mailboxes via CampaignToMailbox
 * - Distribute lead engagement proportionally across campaign mailboxes
 * - Update mailbox lifetime counters
 */

import { prisma } from '../index';
import { logger } from './observabilityService';

interface MailboxEngagementStats {
    mailboxId: string;
    opensToAdd: number;
    clicksToAdd: number;
    repliesToAdd: number;
}

/**
 * Backfill mailbox engagement stats from historical lead data.
 * This fills the gap for leads synced before webhooks were active.
 */
export async function backfillMailboxStatsFromLeads(organizationId: string): Promise<{
    mailboxesUpdated: number;
    totalOpens: number;
    totalClicks: number;
    totalReplies: number;
}> {
    logger.info('[MAILBOX-ENRICHMENT] Starting backfill from lead engagement data', { organizationId });

    try {
        // Get all campaigns with their mailboxes and leads
        const campaigns = await prisma.campaign.findMany({
            where: { organization_id: organizationId },
            include: {
                mailboxes: {
                    select: { id: true, email: true }
                }
            }
        });

        logger.info(`[MAILBOX-ENRICHMENT] Found ${campaigns.length} campaigns`, { organizationId });

        const mailboxStatsMap = new Map<string, MailboxEngagementStats>();

        for (const campaign of campaigns) {
            if (campaign.mailboxes.length === 0) {
                logger.debug(`[MAILBOX-ENRICHMENT] Campaign ${campaign.id} has no mailboxes, skipping`);
                continue;
            }

            // Get lead engagement for this campaign
            const leads = await prisma.lead.findMany({
                where: {
                    organization_id: organizationId,
                    assigned_campaign_id: campaign.id
                },
                select: {
                    id: true,
                    email: true,
                    emails_opened: true,
                    emails_clicked: true,
                    emails_replied: true
                }
            });

            const leadsWithEngagement = leads.filter(
                l => l.emails_opened > 0 || l.emails_clicked > 0 || l.emails_replied > 0
            );

            if (leadsWithEngagement.length === 0) {
                continue;
            }

            logger.info(`[MAILBOX-ENRICHMENT] Campaign ${campaign.name}: ${leadsWithEngagement.length} leads with engagement`, {
                campaignId: campaign.id,
                totalLeads: leads.length,
                mailboxCount: campaign.mailboxes.length
            });

            // Aggregate total engagement for this campaign
            const campaignEngagement = leadsWithEngagement.reduce(
                (acc, lead) => ({
                    opens: acc.opens + lead.emails_opened,
                    clicks: acc.clicks + lead.emails_clicked,
                    replies: acc.replies + lead.emails_replied
                }),
                { opens: 0, clicks: 0, replies: 0 }
            );

            // Distribute engagement proportionally across mailboxes
            // Since we don't know which specific mailbox sent to which lead,
            // we distribute evenly across all campaign mailboxes
            const mailboxCount = campaign.mailboxes.length;
            const opensPerMailbox = Math.floor(campaignEngagement.opens / mailboxCount);
            const clicksPerMailbox = Math.floor(campaignEngagement.clicks / mailboxCount);
            const repliesPerMailbox = Math.floor(campaignEngagement.replies / mailboxCount);

            // Handle remainder by adding to first mailbox
            const opensRemainder = campaignEngagement.opens % mailboxCount;
            const clicksRemainder = campaignEngagement.clicks % mailboxCount;
            const repliesRemainder = campaignEngagement.replies % mailboxCount;

            campaign.mailboxes.forEach((mailbox, index) => {
                const existing = mailboxStatsMap.get(mailbox.id) || {
                    mailboxId: mailbox.id,
                    opensToAdd: 0,
                    clicksToAdd: 0,
                    repliesToAdd: 0
                };

                existing.opensToAdd += opensPerMailbox + (index === 0 ? opensRemainder : 0);
                existing.clicksToAdd += clicksPerMailbox + (index === 0 ? clicksRemainder : 0);
                existing.repliesToAdd += repliesPerMailbox + (index === 0 ? repliesRemainder : 0);

                mailboxStatsMap.set(mailbox.id, existing);
            });
        }

        // Update all mailboxes in batch
        let mailboxesUpdated = 0;
        let totalOpens = 0;
        let totalClicks = 0;
        let totalReplies = 0;

        for (const [mailboxId, stats] of mailboxStatsMap.entries()) {
            if (stats.opensToAdd === 0 && stats.clicksToAdd === 0 && stats.repliesToAdd === 0) {
                continue;
            }

            // Fetch current mailbox stats
            const mailbox = await prisma.mailbox.findUnique({
                where: { id: mailboxId },
                select: {
                    email: true,
                    open_count_lifetime: true,
                    click_count_lifetime: true,
                    reply_count_lifetime: true,
                    total_sent_count: true
                }
            });

            if (!mailbox) {
                logger.warn(`[MAILBOX-ENRICHMENT] Mailbox ${mailboxId} not found, skipping`);
                continue;
            }

            const newOpens = mailbox.open_count_lifetime + stats.opensToAdd;
            const newClicks = mailbox.click_count_lifetime + stats.clicksToAdd;
            const newReplies = mailbox.reply_count_lifetime + stats.repliesToAdd;

            // Calculate updated engagement rate
            const totalEngagement = newOpens + newClicks + newReplies;
            const engagementRate = mailbox.total_sent_count > 0
                ? (totalEngagement / mailbox.total_sent_count) * 100
                : 0;

            await prisma.mailbox.update({
                where: { id: mailboxId },
                data: {
                    open_count_lifetime: newOpens,
                    click_count_lifetime: newClicks,
                    reply_count_lifetime: newReplies,
                    engagement_rate: engagementRate,
                    updated_at: new Date()
                }
            });

            logger.info(`[MAILBOX-ENRICHMENT] Updated ${mailbox.email}`, {
                mailboxId,
                opensAdded: stats.opensToAdd,
                clicksAdded: stats.clicksToAdd,
                repliesAdded: stats.repliesToAdd,
                newTotals: { opens: newOpens, clicks: newClicks, replies: newReplies }
            });

            mailboxesUpdated++;
            totalOpens += stats.opensToAdd;
            totalClicks += stats.clicksToAdd;
            totalReplies += stats.repliesToAdd;
        }

        logger.info('[MAILBOX-ENRICHMENT] Backfill complete', {
            organizationId,
            mailboxesUpdated,
            totalOpens,
            totalClicks,
            totalReplies
        });

        return {
            mailboxesUpdated,
            totalOpens,
            totalClicks,
            totalReplies
        };
    } catch (error: any) {
        logger.error('[MAILBOX-ENRICHMENT] Backfill failed', error);
        throw error;
    }
}

/**
 * Backfill engagement stats for a specific mailbox from its campaign's leads.
 */
export async function backfillSingleMailboxStats(mailboxId: string): Promise<{
    opensAdded: number;
    clicksAdded: number;
    repliesAdded: number;
}> {
    const mailbox = await prisma.mailbox.findUnique({
        where: { id: mailboxId },
        include: {
            campaigns: {
                include: {
                    _count: {
                        select: { mailboxes: true }
                    }
                }
            }
        }
    });

    if (!mailbox) {
        throw new Error(`Mailbox ${mailboxId} not found`);
    }

    let totalOpens = 0;
    let totalClicks = 0;
    let totalReplies = 0;

    for (const campaign of mailbox.campaigns) {
        const leads = await prisma.lead.findMany({
            where: {
                organization_id: mailbox.organization_id,
                assigned_campaign_id: campaign.id
            },
            select: {
                emails_opened: true,
                emails_clicked: true,
                emails_replied: true
            }
        });

        const campaignEngagement = leads.reduce(
            (acc, lead) => ({
                opens: acc.opens + lead.emails_opened,
                clicks: acc.clicks + lead.emails_clicked,
                replies: acc.replies + lead.emails_replied
            }),
            { opens: 0, clicks: 0, replies: 0 }
        );

        // Distribute proportionally across campaign mailboxes
        const mailboxCount = campaign._count.mailboxes;
        totalOpens += Math.floor(campaignEngagement.opens / mailboxCount);
        totalClicks += Math.floor(campaignEngagement.clicks / mailboxCount);
        totalReplies += Math.floor(campaignEngagement.replies / mailboxCount);
    }

    // Update mailbox
    const totalEngagement = totalOpens + totalClicks + totalReplies;
    const engagementRate = mailbox.total_sent_count > 0
        ? (totalEngagement / mailbox.total_sent_count) * 100
        : 0;

    await prisma.mailbox.update({
        where: { id: mailboxId },
        data: {
            open_count_lifetime: { increment: totalOpens },
            click_count_lifetime: { increment: totalClicks },
            reply_count_lifetime: { increment: totalReplies },
            engagement_rate: engagementRate,
            updated_at: new Date()
        }
    });

    logger.info(`[MAILBOX-ENRICHMENT] Backfilled single mailbox ${mailbox.email}`, {
        mailboxId,
        opensAdded: totalOpens,
        clicksAdded: totalClicks,
        repliesAdded: totalReplies
    });

    return {
        opensAdded: totalOpens,
        clicksAdded: totalClicks,
        repliesAdded: totalReplies
    };
}
