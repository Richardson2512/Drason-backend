/**
 * Analytics Controller
 *
 * Provides detailed analytics endpoints for bounce events, deliverability, and campaign performance.
 */

import { Request, Response } from 'express';
import { prisma } from '../index';
import { getOrgId } from '../middleware/orgContext';
import { logger } from '../services/observabilityService';

/**
 * GET /api/analytics/bounces
 *
 * Get detailed bounce analytics with lead-to-mailbox mapping.
 *
 * Query params:
 * - mailbox_id: Filter by specific mailbox
 * - campaign_id: Filter by specific campaign
 * - bounce_type: Filter by bounce type (hard_bounce, soft_bounce)
 * - start_date: Start date for analytics (ISO string)
 * - end_date: End date for analytics (ISO string)
 * - limit: Number of records to return (default 100, max 1000)
 */
export const getBounceAnalytics = async (req: Request, res: Response) => {
    try {
        const orgId = getOrgId(req);
        const {
            mailbox_id,
            domain_id,
            campaign_id,
            bounce_type,
            start_date,
            end_date,
            limit = '100'
        } = req.query;

        const limitNum = Math.min(parseInt(limit as string, 10), 1000);

        // Build filter conditions
        const where: any = {
            organization_id: orgId
        };

        if (mailbox_id) {
            where.mailbox_id = mailbox_id as string;
        }

        // Domain filter: find all mailboxes belonging to this domain, then filter bounces by those mailbox IDs
        if (domain_id && !mailbox_id) {
            const domainMailboxes = await prisma.mailbox.findMany({
                where: { domain_id: domain_id as string, organization_id: orgId },
                select: { id: true }
            });
            const mailboxIds = domainMailboxes.map(m => m.id);
            if (mailboxIds.length > 0) {
                where.mailbox_id = { in: mailboxIds };
            } else {
                // No mailboxes on this domain — return empty results
                where.mailbox_id = 'no-match';
            }
        }

        if (campaign_id) {
            where.campaign_id = campaign_id as string;
        }

        if (bounce_type) {
            where.bounce_type = bounce_type as string;
        }

        if (start_date || end_date) {
            where.bounced_at = {};
            if (start_date) {
                where.bounced_at.gte = new Date(start_date as string);
            }
            if (end_date) {
                where.bounced_at.lte = new Date(end_date as string);
            }
        }

        // Fetch bounce events
        const bounceEvents = await prisma.bounceEvent.findMany({
            where,
            orderBy: {
                bounced_at: 'desc'
            },
            take: limitNum
        });

        // Get summary statistics
        const [totalBounces, hardBounces, softBounces, uniqueMailboxes, uniqueCampaigns] = await Promise.all([
            prisma.bounceEvent.count({ where }),
            prisma.bounceEvent.count({ where: { ...where, bounce_type: 'hard_bounce' } }),
            prisma.bounceEvent.count({ where: { ...where, bounce_type: 'soft_bounce' } }),
            prisma.bounceEvent.groupBy({
                by: ['mailbox_id'],
                where: { ...where, mailbox_id: { not: null } },
                _count: true
            }),
            prisma.bounceEvent.groupBy({
                by: ['campaign_id'],
                where: { ...where, campaign_id: { not: null } },
                _count: true
            })
        ]);

        // Get mailbox breakdown
        const mailboxBreakdown = await prisma.bounceEvent.groupBy({
            by: ['mailbox_id'],
            where: { ...where, mailbox_id: { not: null } },
            _count: {
                id: true
            },
            orderBy: {
                _count: {
                    id: 'desc'
                }
            },
            take: 20
        });

        // Enrich mailbox data with mailbox details
        const mailboxIds = mailboxBreakdown
            .map(mb => mb.mailbox_id)
            .filter(id => id !== null) as string[];

        const mailboxes = await prisma.mailbox.findMany({
            where: {
                id: { in: mailboxIds }
            },
            select: {
                id: true,
                email: true,
                status: true
            }
        });

        const mailboxMap = new Map(mailboxes.map(mb => [mb.id, mb]));

        const enrichedMailboxBreakdown = mailboxBreakdown.map(mb => {
            const mailbox = mb.mailbox_id ? mailboxMap.get(mb.mailbox_id) : null;
            return {
                mailbox_id: mb.mailbox_id,
                mailbox_email: mailbox?.email || 'Unknown',
                mailbox_status: mailbox?.status || 'unknown',
                bounce_count: mb._count.id
            };
        });

        // Get campaign breakdown
        const campaignBreakdown = await prisma.bounceEvent.groupBy({
            by: ['campaign_id'],
            where: { ...where, campaign_id: { not: null } },
            _count: {
                id: true
            },
            orderBy: {
                _count: {
                    id: 'desc'
                }
            },
            take: 20
        });

        // Enrich campaign data
        const campaignIds = campaignBreakdown
            .map(c => c.campaign_id)
            .filter(id => id !== null) as string[];

        const campaigns = await prisma.campaign.findMany({
            where: {
                id: { in: campaignIds }
            },
            select: {
                id: true,
                name: true,
                status: true,
                bounce_rate: true
            }
        });

        const campaignMap = new Map(campaigns.map(c => [c.id, c]));

        const enrichedCampaignBreakdown = campaignBreakdown.map(c => {
            const campaign = c.campaign_id ? campaignMap.get(c.campaign_id) : null;
            return {
                campaign_id: c.campaign_id,
                campaign_name: campaign?.name || 'Unknown',
                campaign_status: campaign?.status || 'unknown',
                campaign_bounce_rate: campaign?.bounce_rate || 0,
                bounce_count: c._count.id
            };
        });

        // Get bounce reasons distribution using Prisma groupBy (respects all where filters including domain)
        const bounceReasonsRaw = await prisma.bounceEvent.groupBy({
            by: ['bounce_reason'],
            where,
            _count: { id: true },
            orderBy: { _count: { id: 'desc' } },
            take: 10
        });

        const formattedBounceReasons = bounceReasonsRaw.map(r => ({
            reason: r.bounce_reason || 'Unknown',
            count: r._count.id
        }));

        res.json({
            success: true,
            data: {
                summary: {
                    total_bounces: totalBounces,
                    hard_bounces: hardBounces,
                    soft_bounces: softBounces,
                    unique_mailboxes: uniqueMailboxes.length,
                    unique_campaigns: uniqueCampaigns.length,
                    hard_bounce_rate: totalBounces > 0 ? ((hardBounces / totalBounces) * 100).toFixed(2) + '%' : '0%',
                    soft_bounce_rate: totalBounces > 0 ? ((softBounces / totalBounces) * 100).toFixed(2) + '%' : '0%'
                },
                mailbox_breakdown: enrichedMailboxBreakdown,
                campaign_breakdown: enrichedCampaignBreakdown,
                bounce_reasons: formattedBounceReasons,
                recent_bounces: bounceEvents.map(event => ({
                    id: event.id,
                    email_address: event.email_address,
                    bounce_type: event.bounce_type,
                    bounce_reason: event.bounce_reason,
                    bounced_at: event.bounced_at,
                    mailbox_id: event.mailbox_id,
                    campaign_id: event.campaign_id,
                    lead_id: event.lead_id
                }))
            }
        });

        logger.info('[ANALYTICS] Bounce analytics retrieved', {
            organizationId: orgId,
            totalBounces,
            hardBounces,
            softBounces
        });

    } catch (error: any) {
        logger.error('[ANALYTICS] Error fetching bounce analytics', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch bounce analytics'
        });
    }
};

/**
 * GET /api/analytics/daily
 *
 * Get date-bucketed campaign analytics for trend visualization.
 *
 * Query params:
 * - campaign_id: Filter by specific campaign (optional — aggregates all if omitted)
 * - start_date: Start date (ISO string, default: 30 days ago)
 * - end_date: End date (ISO string, default: today)
 */
export const getDailyAnalytics = async (req: Request, res: Response) => {
    try {
        const orgId = getOrgId(req);
        const { campaign_id, start_date, end_date } = req.query;

        const startDate = start_date
            ? new Date(start_date as string)
            : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // 30 days ago
        const endDate = end_date
            ? new Date(end_date as string)
            : new Date();

        const where: any = {
            organization_id: orgId,
            date: {
                gte: startDate,
                lte: endDate,
            }
        };

        if (campaign_id) {
            where.campaign_id = campaign_id as string;
        }

        const dailyData = await prisma.campaignDailyAnalytics.findMany({
            where,
            orderBy: { date: 'asc' },
            select: {
                date: true,
                campaign_id: true,
                sent_count: true,
                open_count: true,
                click_count: true,
                reply_count: true,
                bounce_count: true,
                unsubscribe_count: true,
            }
        });

        // If no campaign_id filter, aggregate across all campaigns per day
        if (!campaign_id) {
            const aggregated = new Map<string, {
                date: string;
                sent_count: number;
                open_count: number;
                click_count: number;
                reply_count: number;
                bounce_count: number;
                unsubscribe_count: number;
            }>();

            for (const row of dailyData) {
                const dateKey = row.date.toISOString().split('T')[0];
                const existing = aggregated.get(dateKey) || {
                    date: dateKey,
                    sent_count: 0,
                    open_count: 0,
                    click_count: 0,
                    reply_count: 0,
                    bounce_count: 0,
                    unsubscribe_count: 0,
                };
                existing.sent_count += row.sent_count;
                existing.open_count += row.open_count;
                existing.click_count += row.click_count;
                existing.reply_count += row.reply_count;
                existing.bounce_count += row.bounce_count;
                existing.unsubscribe_count += row.unsubscribe_count;
                aggregated.set(dateKey, existing);
            }

            res.json({
                success: true,
                data: Array.from(aggregated.values()),
            });
        } else {
            // If daily data exists, return it
            if (dailyData.length > 0) {
                res.json({
                    success: true,
                    data: dailyData.map(row => ({
                        date: row.date.toISOString().split('T')[0],
                        campaign_id: row.campaign_id,
                        sent_count: row.sent_count,
                        open_count: row.open_count,
                        click_count: row.click_count,
                        reply_count: row.reply_count,
                        bounce_count: row.bounce_count,
                        unsubscribe_count: row.unsubscribe_count,
                    })),
                });
            } else {
                // Fallback: for platforms without daily analytics (Instantly, EmailBison),
                // synthesize from aggregate campaign data
                const campaign = await prisma.campaign.findFirst({
                    where: { id: campaign_id as string, organization_id: orgId },
                    select: {
                        total_sent: true,
                        total_bounced: true,
                        open_count: true,
                        reply_count: true,
                        analytics_updated_at: true,
                    }
                });

                if (campaign && campaign.total_sent > 0) {
                    const date = campaign.analytics_updated_at
                        ? campaign.analytics_updated_at.toISOString().split('T')[0]
                        : new Date().toISOString().split('T')[0];
                    res.json({
                        success: true,
                        data: [{
                            date,
                            campaign_id: campaign_id as string,
                            sent_count: campaign.total_sent,
                            open_count: campaign.open_count || 0,
                            click_count: 0,
                            reply_count: campaign.reply_count || 0,
                            bounce_count: campaign.total_bounced,
                            unsubscribe_count: 0,
                        }],
                    });
                } else {
                    res.json({ success: true, data: [] });
                }
            }
        }

        logger.info('[ANALYTICS] Daily analytics retrieved', {
            organizationId: orgId,
            campaignId: campaign_id,
            dataPoints: dailyData.length,
        });
    } catch (error: any) {
        logger.error('[ANALYTICS] Error fetching daily analytics', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch daily analytics'
        });
    }
};
