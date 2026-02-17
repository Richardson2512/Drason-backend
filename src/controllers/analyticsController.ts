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

        // Get bounce reasons distribution
        const bounceReasons = await prisma.$queryRaw<Array<{ bounce_reason: string; count: bigint }>>`
            SELECT
                COALESCE("bounce_reason", 'Unknown') as bounce_reason,
                COUNT(*) as count
            FROM "BounceEvent"
            WHERE "organization_id" = ${orgId}
            ${mailbox_id ? prisma.$queryRawUnsafe(`AND "mailbox_id" = '${mailbox_id}'`) : prisma.$queryRawUnsafe('')}
            ${campaign_id ? prisma.$queryRawUnsafe(`AND "campaign_id" = '${campaign_id}'`) : prisma.$queryRawUnsafe('')}
            GROUP BY "bounce_reason"
            ORDER BY count DESC
            LIMIT 10
        `;

        const formattedBounceReasons = bounceReasons.map(r => ({
            reason: r.bounce_reason,
            count: Number(r.count)
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
