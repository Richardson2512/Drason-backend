/**
 * Analytics Controller
 *
 * Provides detailed analytics endpoints for bounce events, deliverability, and campaign performance.
 */

import { Request, Response } from 'express';
import { prisma } from '../prisma';
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

        // Support comma-separated campaign_ids for comparison mode
        const campaignIds = campaign_id
            ? (campaign_id as string).split(',').map(id => id.trim()).filter(Boolean)
            : [];
        const isComparison = campaignIds.length > 1;

        if (campaignIds.length === 1) {
            where.campaign_id = campaignIds[0];
        } else if (campaignIds.length > 1) {
            where.campaign_id = { in: campaignIds };
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

        // Comparison mode: return per-campaign grouped data
        if (isComparison) {
            // Look up campaign records with stats for fallback
            const campaignRecords = await prisma.campaign.findMany({
                where: { id: { in: campaignIds }, organization_id: orgId },
                select: {
                    id: true, name: true,
                    total_sent: true, total_bounced: true,
                    open_count: true, click_count: true, reply_count: true,
                },
            });
            const campaignMap = new Map(campaignRecords.map(c => [c.id, c]));

            // Group by campaign
            const byCampaign: Record<string, { name: string; totals: { sent: number; opens: number; clicks: number; replies: number; bounces: number }; daily: any[] }> = {};
            for (const id of campaignIds) {
                const c = campaignMap.get(id);
                byCampaign[id] = {
                    name: c?.name || id,
                    totals: { sent: 0, opens: 0, clicks: 0, replies: 0, bounces: 0 },
                    daily: [],
                };
            }

            for (const row of dailyData) {
                const entry = byCampaign[row.campaign_id];
                if (!entry) continue;
                const dateStr = row.date.toISOString().split('T')[0];
                entry.daily.push({
                    date: dateStr,
                    sent_count: row.sent_count,
                    open_count: row.open_count,
                    click_count: row.click_count,
                    reply_count: row.reply_count,
                    bounce_count: row.bounce_count,
                });
                entry.totals.sent += row.sent_count;
                entry.totals.opens += row.open_count;
                entry.totals.clicks += row.click_count;
                entry.totals.replies += row.reply_count;
                entry.totals.bounces += row.bounce_count;
            }

            // Fallback: if daily data is empty/sparse, use campaign-level totals
            for (const id of campaignIds) {
                const entry = byCampaign[id];
                const c = campaignMap.get(id);
                if (entry && c && entry.totals.sent === 0) {
                    entry.totals.sent = c.total_sent || 0;
                    entry.totals.opens = c.open_count || 0;
                    entry.totals.clicks = c.click_count || 0;
                    entry.totals.replies = c.reply_count || 0;
                    entry.totals.bounces = c.total_bounced || 0;
                }
            }

            res.json({ success: true, comparison: true, data: byCampaign });
            return;
        }

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
                        click_count: true,
                        reply_count: true,
                        unsubscribed_count: true,
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
                            click_count: campaign.click_count || 0,
                            reply_count: campaign.reply_count || 0,
                            bounce_count: campaign.total_bounced,
                            unsubscribe_count: campaign.unsubscribed_count || 0,
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

/**
 * GET /api/analytics/esp-performance
 * Returns per-mailbox ESP performance matrix for the dashboard.
 */
export const getEspPerformance = async (req: Request, res: Response) => {
    try {
        const orgId = getOrgId(req);

        const performances = await prisma.mailboxEspPerformance.findMany({
            where: { organization_id: orgId },
            orderBy: { send_count_30d: 'desc' },
        });

        // Group by mailbox, with email lookup
        const mailboxIds = [...new Set(performances.map(p => p.mailbox_id))];
        const mailboxes = await prisma.mailbox.findMany({
            where: { id: { in: mailboxIds } },
            select: { id: true, email: true, status: true },
        });
        const mailboxMap = new Map(mailboxes.map(m => [m.id, m]));

        const matrix = mailboxIds.map(mbId => {
            const mb = mailboxMap.get(mbId);
            const espData = performances.filter(p => p.mailbox_id === mbId);
            return {
                mailbox_id: mbId,
                email: mb?.email || 'Unknown',
                status: mb?.status || 'unknown',
                esp_scores: espData.reduce((acc, p) => {
                    acc[p.esp_bucket] = {
                        send_count: p.send_count_30d,
                        bounce_count: p.bounce_count_30d,
                        bounce_rate: p.bounce_rate_30d,
                        reply_count: p.reply_count_30d,
                    };
                    return acc;
                }, {} as Record<string, { send_count: number; bounce_count: number; bounce_rate: number; reply_count: number }>),
            };
        });

        res.json({ success: true, data: matrix });
    } catch (error) {
        logger.error('[ANALYTICS] Error fetching ESP performance', error instanceof Error ? error : new Error(String(error)));
        res.status(500).json({ success: false, error: 'Failed to fetch ESP performance' });
    }
};

/**
 * GET /api/analytics/mailbox-comparison
 *
 * Side-by-side mailbox health for the protection analytics page. Returns
 * BOTH per-mailbox rows AND provider-bucket rollups in one payload so the
 * UI can switch tabs without a re-fetch.
 *
 * Per-mailbox row: send / bounce / reply counts over the window,
 * computed bounce + reply rates, healing state, last-activity timestamp.
 *
 * Provider rollup: same shape, summed by `connected_account.provider`
 * bucket (google / microsoft / smtp). Lets the operator answer "are my
 * Gmail mailboxes outperforming Outlook?" without per-row arithmetic.
 *
 * Window resolution:
 *   start_date + end_date (preferred — matches the existing analytics page)
 *   timeRange (7d/30d/90d preset — for shorthand)
 *   default: last 30 days
 */
export const getMailboxComparison = async (req: Request, res: Response) => {
    try {
        const orgId = getOrgId(req);
        const { gte, lte } = resolveWindow(req);

        const accounts = await prisma.connectedAccount.findMany({
            where: { organization_id: orgId },
            select: {
                id: true,
                email: true,
                display_name: true,
                provider: true,
                connection_status: true,
                daily_send_limit: true,
                sends_today: true,
                warmup_complete: true,
            },
            orderBy: { email: 'asc' },
        });

        if (accounts.length === 0) {
            return res.json({ success: true, data: { mailboxes: [], providers: [], window: { start: gte, end: lte } } });
        }

        const mailboxIds = accounts.map(a => a.id);
        const sendWhere: any = { organization_id: orgId, mailbox_id: { in: mailboxIds }, sent_at: { gte, lte } };
        const replyWhere: any = { organization_id: orgId, mailbox_id: { in: mailboxIds }, replied_at: { gte, lte } };
        const bounceWhere: any = { organization_id: orgId, mailbox_id: { in: mailboxIds }, bounced_at: { gte, lte } };

        // Parallel groupBy queries — same pattern as sequencer's
        // getMailboxPerformance. Index-friendly: each event model has a
        // (mailbox_id, <time-column>) composite index.
        const [sends, replies, bounces, mailboxStates] = await Promise.all([
            prisma.sendEvent.groupBy({
                by: ['mailbox_id'],
                where: sendWhere,
                _count: { _all: true },
            }),
            prisma.replyEvent.groupBy({
                by: ['mailbox_id'],
                where: replyWhere,
                _count: { _all: true },
            }),
            prisma.bounceEvent.groupBy({
                by: ['mailbox_id'],
                where: bounceWhere,
                _count: { _all: true },
            }),
            prisma.mailbox.findMany({
                where: { id: { in: mailboxIds } },
                select: {
                    id: true,
                    status: true,
                    recovery_phase: true,
                    last_activity_at: true,
                    engagement_rate: true,
                    spam_count: true,
                    open_count_lifetime: true,
                    click_count_lifetime: true,
                },
            }),
        ]);

        const sendCounts = new Map<string, number>();
        for (const r of sends) if (r.mailbox_id) sendCounts.set(r.mailbox_id, r._count._all);
        const replyCounts = new Map<string, number>();
        for (const r of replies) if (r.mailbox_id) replyCounts.set(r.mailbox_id, r._count._all);
        const bounceCounts = new Map<string, number>();
        for (const r of bounces) if (r.mailbox_id) bounceCounts.set(r.mailbox_id, r._count._all);
        const stateById = new Map<string, typeof mailboxStates[number]>();
        for (const m of mailboxStates) stateById.set(m.id, m);

        const pct = (n: number, d: number) => (d > 0 ? parseFloat(((n / d) * 100).toFixed(2)) : 0);

        // Health score 0-100 — single composite signal for ranking. We use:
        //   reply_rate * 6   (signal: deliverable + engaged audience)
        //   delivery_rate * 0.4 (1 - bounce_rate; signal: list quality)
        //   warmup bonus +10 (mailbox graduated warmup)
        //   recovery penalty -30 (mailbox in any non-healthy phase)
        // Clamped to [0, 100]. The weights are tuned to the rough ranges seen
        // on real campaigns (reply rates of 5–15% are good, bounce rates >2%
        // are bad). Operators care about the relative ordering more than the
        // absolute number; rebalance if real-world ranking surfaces issues.
        const healthScore = (replyRate: number, bounceRate: number, warmupComplete: boolean, recoveryPhase: string): number => {
            const replyComponent = Math.min(60, replyRate * 6);
            const deliveryComponent = Math.max(0, (100 - bounceRate)) * 0.4;
            const warmupBonus = warmupComplete ? 10 : 0;
            const recoveryPenalty = recoveryPhase && recoveryPhase !== 'healthy' ? -30 : 0;
            const raw = replyComponent + deliveryComponent + warmupBonus + recoveryPenalty;
            return Math.max(0, Math.min(100, Math.round(raw)));
        };

        const perMailbox = accounts.map(a => {
            const sent = sendCounts.get(a.id) || 0;
            const replied = replyCounts.get(a.id) || 0;
            const bounced = bounceCounts.get(a.id) || 0;
            const state = stateById.get(a.id);
            const recoveryPhase = state?.recovery_phase || 'healthy';
            const reply_rate = pct(replied, sent);
            const bounce_rate = pct(bounced, sent);
            const delivered = Math.max(0, sent - bounced);
            return {
                id: a.id,
                email: a.email,
                display_name: a.display_name,
                provider: a.provider,
                connection_status: a.connection_status,
                daily_send_limit: a.daily_send_limit,
                sends_today: a.sends_today,
                warmup_complete: a.warmup_complete,
                status: state?.status || 'healthy',
                recovery_phase: recoveryPhase,
                last_activity_at: state?.last_activity_at ?? null,
                lifetime_engagement_rate: state?.engagement_rate ?? 0,
                lifetime_spam_count: state?.spam_count ?? 0,
                total_sent: sent,
                total_replied: replied,
                total_bounced: bounced,
                total_delivered: delivered,
                reply_rate,
                bounce_rate,
                delivery_rate: pct(delivered, sent),
                health_score: healthScore(reply_rate, bounce_rate, a.warmup_complete, recoveryPhase),
            };
        });

        // Provider-bucket rollup. Sum the volume columns; recompute rates on
        // the sums (NOT an average of rates) so a low-volume mailbox with a
        // freak 50% bounce rate doesn't drag the bucket-level number.
        const providerBuckets = new Map<string, {
            provider: string;
            mailbox_count: number;
            total_sent: number;
            total_replied: number;
            total_bounced: number;
            healthy_count: number;
            in_recovery_count: number;
            paused_count: number;
            warmup_complete_count: number;
            health_score_sum: number;
        }>();
        for (const m of perMailbox) {
            const b = providerBuckets.get(m.provider) || {
                provider: m.provider, mailbox_count: 0,
                total_sent: 0, total_replied: 0, total_bounced: 0,
                healthy_count: 0, in_recovery_count: 0, paused_count: 0,
                warmup_complete_count: 0, health_score_sum: 0,
            };
            b.mailbox_count += 1;
            b.total_sent += m.total_sent;
            b.total_replied += m.total_replied;
            b.total_bounced += m.total_bounced;
            if (m.recovery_phase === 'paused' || m.status === 'paused') b.paused_count += 1;
            else if (m.recovery_phase !== 'healthy') b.in_recovery_count += 1;
            else b.healthy_count += 1;
            if (m.warmup_complete) b.warmup_complete_count += 1;
            b.health_score_sum += m.health_score;
            providerBuckets.set(m.provider, b);
        }

        const providers = Array.from(providerBuckets.values()).map(b => {
            const delivered = Math.max(0, b.total_sent - b.total_bounced);
            return {
                provider: b.provider,
                mailbox_count: b.mailbox_count,
                total_sent: b.total_sent,
                total_replied: b.total_replied,
                total_bounced: b.total_bounced,
                total_delivered: delivered,
                reply_rate: pct(b.total_replied, b.total_sent),
                bounce_rate: pct(b.total_bounced, b.total_sent),
                delivery_rate: pct(delivered, b.total_sent),
                healthy_count: b.healthy_count,
                in_recovery_count: b.in_recovery_count,
                paused_count: b.paused_count,
                warmup_complete_count: b.warmup_complete_count,
                avg_health_score: b.mailbox_count > 0
                    ? Math.round(b.health_score_sum / b.mailbox_count)
                    : 0,
            };
        }).sort((a, b) => b.total_sent - a.total_sent);

        // Sort mailboxes by health_score desc, then volume desc — that's the
        // "show me my best performers first" answer the operator wants when
        // the question is "what mailboxes are doing well".
        perMailbox.sort((a, b) => {
            if (b.health_score !== a.health_score) return b.health_score - a.health_score;
            return b.total_sent - a.total_sent;
        });

        res.json({
            success: true,
            data: {
                mailboxes: perMailbox,
                providers,
                window: { start: gte, end: lte },
            },
        });
    } catch (error) {
        logger.error('[ANALYTICS] Error fetching mailbox comparison', error instanceof Error ? error : new Error(String(error)));
        res.status(500).json({ success: false, error: 'Failed to fetch mailbox comparison' });
    }
};

/** Shared window resolver — accepts `start_date`/`end_date` (analytics-page
 *  convention) or `timeRange` (sequencer convention) so the same endpoint
 *  works regardless of which surface calls it. */
function resolveWindow(req: Request): { gte: Date; lte: Date } {
    const startStr = (req.query.start_date as string) || (req.query.from as string);
    const endStr = (req.query.end_date as string) || (req.query.to as string);
    if (startStr && endStr) {
        const gte = new Date(startStr);
        const lte = new Date(endStr);
        lte.setHours(23, 59, 59, 999);
        if (!isNaN(gte.getTime()) && !isNaN(lte.getTime())) return { gte, lte };
    }
    const tr = (req.query.timeRange as string) || '30d';
    const days = tr === '7d' ? 7 : tr === '90d' ? 90 : 30;
    const lte = new Date();
    const gte = new Date(lte.getTime() - days * 24 * 60 * 60 * 1000);
    return { gte, lte };
}
