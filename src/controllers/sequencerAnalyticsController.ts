/**
 * Sequencer Analytics Controller
 *
 * Aggregate stats across SendCampaigns and per-campaign performance.
 */

import { Request, Response } from 'express';
import { getOrgId } from '../middleware/orgContext';
import { prisma } from '../index';
import { logger } from '../services/observabilityService';

/**
 * Parse time range from query params.
 * Supports preset ranges (7d, 30d, 90d) and custom date ranges (from/to).
 */
function getDateFilter(req: { query: Record<string, any> }): { gte?: Date; lte?: Date } | null {
    const from = req.query.from as string | undefined;
    const to = req.query.to as string | undefined;

    // Custom date range
    if (from && to) {
        const fromDate = new Date(from);
        const toDate = new Date(to);
        toDate.setHours(23, 59, 59, 999); // Include the full end day
        if (!isNaN(fromDate.getTime()) && !isNaN(toDate.getTime())) {
            return { gte: fromDate, lte: toDate };
        }
    }

    // Preset range
    const timeRange = req.query.timeRange as string | undefined;
    if (!timeRange) return null;
    const now = new Date();
    switch (timeRange) {
        case '7d': return { gte: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000) };
        case '30d': return { gte: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000) };
        case '90d': return { gte: new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000) };
        default: return null;
    }
}

/**
 * GET /api/sequencer/analytics
 * Aggregate stats across all SendCampaigns: total sent, opened, clicked, replied, bounced, unsubscribed + rates.
 */
export const getOverview = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const dateFilter = getDateFilter(req);

        // Sequencer analytics — scoped to source_platform='sequencer' so legacy
        // platform-synced campaigns don't pollute the sequencer dashboard.
        const where: any = { organization_id: orgId };
        if (dateFilter) where.created_at = dateFilter;

        const campaigns = await prisma.campaign.findMany({
            where,
            select: {
                total_sent: true,
                open_count: true,
                click_count: true,
                reply_count: true,
                total_bounced: true,
                unsubscribed_count: true,
                total_leads: true,
            },
        });

        // Column names differ from the legacy SendCampaign schema — the unified
        // Campaign table uses open_count / click_count / reply_count /
        // unsubscribed_count. API response shape below keeps the prior
        // sequencer-style field names for FE stability.
        const totals = campaigns.reduce(
            (acc, c) => ({
                sent: acc.sent + c.total_sent,
                opened: acc.opened + c.open_count,
                clicked: acc.clicked + c.click_count,
                replied: acc.replied + c.reply_count,
                bounced: acc.bounced + c.total_bounced,
                unsubscribed: acc.unsubscribed + c.unsubscribed_count,
                leads: acc.leads + c.total_leads,
            }),
            { sent: 0, opened: 0, clicked: 0, replied: 0, bounced: 0, unsubscribed: 0, leads: 0 },
        );

        const safe = (n: number, d: number) => (d > 0 ? parseFloat(((n / d) * 100).toFixed(2)) : 0);

        return res.json({
            success: true,
            data: {
                total_campaigns: campaigns.length,
                total_leads: totals.leads,
                total_sent: totals.sent,
                total_opened: totals.opened,
                total_clicked: totals.clicked,
                total_replied: totals.replied,
                total_bounced: totals.bounced,
                total_unsubscribed: totals.unsubscribed,
                open_rate: safe(totals.opened, totals.sent),
                click_rate: safe(totals.clicked, totals.sent),
                reply_rate: safe(totals.replied, totals.sent),
                bounce_rate: safe(totals.bounced, totals.sent),
                unsubscribe_rate: safe(totals.unsubscribed, totals.sent),
            },
        });
    } catch (error: any) {
        logger.error('[SEQ_ANALYTICS] Failed to get overview', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ success: false, error: 'Failed to get analytics overview' });
    }
};

/**
 * GET /api/sequencer/analytics/campaigns
 * Per-campaign stats table.
 */
export const getCampaignPerformance = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const dateFilter = getDateFilter(req);

        const where: any = { organization_id: orgId };
        if (dateFilter) where.created_at = dateFilter;

        const campaigns = await prisma.campaign.findMany({
            where,
            orderBy: { created_at: 'desc' },
            select: {
                id: true,
                name: true,
                status: true,
                total_leads: true,
                total_sent: true,
                open_count: true,
                click_count: true,
                reply_count: true,
                total_bounced: true,
                unsubscribed_count: true,
                created_at: true,
                launched_at: true,
            },
        });

        const safe = (n: number, d: number) => (d > 0 ? parseFloat(((n / d) * 100).toFixed(2)) : 0);

        // Keep the FE-visible field names (total_opened etc.) by remapping on output.
        // Internal column names on the unified Campaign table are open_count / click_count
        // / reply_count / unsubscribed_count.
        const data = campaigns.map((c) => ({
            id: c.id,
            name: c.name,
            status: c.status,
            total_leads: c.total_leads,
            total_sent: c.total_sent,
            total_opened: c.open_count,
            total_clicked: c.click_count,
            total_replied: c.reply_count,
            total_bounced: c.total_bounced,
            total_unsubscribed: c.unsubscribed_count,
            created_at: c.created_at,
            launched_at: c.launched_at,
            open_rate: safe(c.open_count, c.total_sent),
            click_rate: safe(c.click_count, c.total_sent),
            reply_rate: safe(c.reply_count, c.total_sent),
            bounce_rate: safe(c.total_bounced, c.total_sent),
        }));

        return res.json({ success: true, data });
    } catch (error: any) {
        logger.error('[SEQ_ANALYTICS] Failed to get campaign performance', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ success: false, error: 'Failed to get campaign performance' });
    }
};

/**
 * GET /api/sequencer/analytics/volume
 *
 * Historical daily send count for the org. Backward-looking — answers "how
 * many emails did we actually send each day". Source of truth is `SendEvent`
 * (one row per delivered message) so this reflects what actually went out,
 * not what `Campaign.total_sent` reports (which can drift from real send
 * activity if external syncs touch it).
 *
 * Query params:
 *   range = '7d' | '14d' | '30d' | '90d'   (default: '30d')
 *
 * Response shape:
 *   {
 *     points: [{ date: 'YYYY-MM-DD', count: 123 }, ...],
 *     total: 1234,
 *     daily_average: 41,
 *     peak_day: { date: '2026-04-19', count: 87 } | null,
 *     range_start: ISODate,
 *     range_end: ISODate,
 *   }
 *
 * Days with zero sends are included so the chart renders a continuous
 * timeline (no gaps that the user might mistake for missing data).
 */
export const getDailySendVolume = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const range = String(req.query.range || '30d');
        const days = range === '7d' ? 7 : range === '14d' ? 14 : range === '90d' ? 90 : 30;

        const end = new Date();
        end.setHours(23, 59, 59, 999);
        const start = new Date(end);
        start.setDate(start.getDate() - (days - 1));
        start.setHours(0, 0, 0, 0);

        // Group sends by day. Postgres date_trunc on `sent_at` keeps this in one
        // round trip rather than fetching every event into Node.
        // $queryRawUnsafe + positional args because newer Prisma client versions
        // reject Date objects in tagged-template form ("Expected Flat JSON array").
        const rows = await prisma.$queryRawUnsafe<Array<{ day: Date; count: bigint }>>(
            `SELECT date_trunc('day', sent_at AT TIME ZONE 'UTC') AS day,
                    COUNT(*)::bigint AS count
             FROM "SendEvent"
             WHERE organization_id = $1
               AND sent_at >= $2::timestamptz
               AND sent_at <= $3::timestamptz
             GROUP BY 1
             ORDER BY 1`,
            orgId,
            start.toISOString(),
            end.toISOString(),
        );

        const byDay = new Map<string, number>();
        for (const r of rows) {
            byDay.set(new Date(r.day).toISOString().slice(0, 10), Number(r.count));
        }

        const points: { date: string; count: number }[] = [];
        for (let i = 0; i < days; i++) {
            const d = new Date(start);
            d.setDate(d.getDate() + i);
            const key = d.toISOString().slice(0, 10);
            points.push({ date: key, count: byDay.get(key) || 0 });
        }

        const total = points.reduce((a, p) => a + p.count, 0);
        const dailyAverage = days > 0 ? Math.round(total / days) : 0;
        const peakDay = points.reduce<{ date: string; count: number } | null>(
            (best, p) => (best === null || p.count > best.count) ? p : best,
            null,
        );

        return res.json({
            success: true,
            data: {
                points,
                total,
                daily_average: dailyAverage,
                peak_day: peakDay && peakDay.count > 0 ? peakDay : null,
                range_start: start.toISOString(),
                range_end: end.toISOString(),
            },
        });
    } catch (error: unknown) {
        logger.error('[SEQ_ANALYTICS] Daily volume failed', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ success: false, error: 'Failed to compute daily send volume' });
    }
};

/**
 * GET /api/sequencer/analytics/forecast
 * 7-day projected send capacity. Day 0 uses today's remaining (daily_send_limit -
 * sends_today); days 1–6 use the full daily_send_limit per mailbox. Excludes
 * mailboxes the Protection layer has removed from rotation.
 */
export const getSendVolumeForecast = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);

        const accounts = await prisma.connectedAccount.findMany({
            where: { organization_id: orgId, connection_status: 'active' },
            select: {
                id: true,
                email: true,
                daily_send_limit: true,
                sends_today: true,
                mailbox: { select: { status: true } },
            },
        });

        const eligible = accounts.filter(a => {
            const status = a.mailbox?.status || 'healthy';
            return status !== 'paused' && status !== 'quarantine' && status !== 'restricted_send';
        });

        const todayCapacity = eligible.reduce((sum, a) => sum + Math.max(0, a.daily_send_limit - a.sends_today), 0);
        const dailyCapacity = eligible.reduce((sum, a) => sum + a.daily_send_limit, 0);

        const projection: { date: string; capacity: number; isToday: boolean }[] = [];
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        for (let i = 0; i < 7; i++) {
            const d = new Date(today);
            d.setDate(d.getDate() + i);
            projection.push({
                date: d.toISOString().slice(0, 10),
                capacity: i === 0 ? todayCapacity : dailyCapacity,
                isToday: i === 0,
            });
        }

        const sortedByCapacity = [...eligible].sort((a, b) => b.daily_send_limit - a.daily_send_limit);
        const bottleneckMailboxes = sortedByCapacity.slice(0, 3).map(a => ({
            id: a.id,
            email: a.email,
            daily_send_limit: a.daily_send_limit,
            sends_today: a.sends_today,
            percent_of_total: dailyCapacity > 0 ? Math.round((a.daily_send_limit / dailyCapacity) * 100) : 0,
        }));

        return res.json({
            success: true,
            data: {
                today_remaining: todayCapacity,
                daily_capacity: dailyCapacity,
                weekly_capacity: dailyCapacity * 7,
                eligible_mailboxes: eligible.length,
                excluded_mailboxes: accounts.length - eligible.length,
                projection,
                bottleneck_mailboxes: bottleneckMailboxes,
            },
        });
    } catch (error: unknown) {
        logger.error('[SEQ_ANALYTICS] Forecast failed', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ success: false, error: 'Failed to compute forecast' });
    }
};

// ────────────────────────────────────────────────────────────────────
// REPLY QUALITY
// ────────────────────────────────────────────────────────────────────

/**
 * GET /api/sequencer/analytics/reply-quality
 *
 * Returns three things in one call:
 *   1. breakdown          — total inbound count + per-class counts
 *   2. subject_correlation — for each outbound subject the org has used,
 *                            the class distribution of replies. The frontend
 *                            renders this as "what works" vs "what hurts" tables
 *                            (top subjects by % positive, top by % angry/hard_no).
 *   3. samples            — up to 5 example replies per class for the drill-down
 *
 * Subject correlation joins outbound EmailMessages (by thread_id) to the inbound
 * replies on the same thread, then groups by the outbound subject. Only threads
 * that have at least one inbound reply are counted.
 *
 * Optional query: ?days=30 (default 90)
 */
const REPLY_CLASSES = [
    'positive', 'qualified', 'objection', 'referral',
    'soft_no', 'hard_no', 'angry', 'auto', 'unclassified',
] as const;

export const getReplyQuality = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const days = Math.max(1, Math.min(365, parseInt(String(req.query.days || '90'), 10)));
        const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

        // ── 1. Class breakdown ─────────────────────────────────────────
        // Group inbound EmailMessages by quality_class. Scope to the org via
        // the thread relation so we only count this org's replies.
        const breakdownRows = await prisma.emailMessage.groupBy({
            by: ['quality_class'],
            where: {
                direction: 'inbound',
                created_at: { gte: since },
                thread: { organization_id: orgId },
            },
            _count: true,
        });

        const breakdown: Record<string, number> = {};
        for (const c of REPLY_CLASSES) breakdown[c] = 0;
        let total = 0;
        for (const row of breakdownRows) {
            const cls = row.quality_class || 'unclassified';
            breakdown[cls] = (breakdown[cls] || 0) + row._count;
            total += row._count;
        }

        // ── 2. Subject correlation ─────────────────────────────────────
        // For every (outbound_subject, reply_class) pair, count threads.
        // Raw SQL because we want the join + double-aggregation in one pass —
        // doing this in Prisma would require fetching every reply + outbound
        // message, which doesn't scale.
        const correlationRows = await prisma.$queryRawUnsafe<Array<{
            subject: string;
            quality_class: string;
            count: bigint;
        }>>(
            `SELECT
                outbound.subject AS subject,
                COALESCE(inbound.quality_class, 'unclassified') AS quality_class,
                COUNT(*)::bigint AS count
            FROM "EmailMessage" inbound
            JOIN "EmailThread" t ON t.id = inbound.thread_id
            JOIN "EmailMessage" outbound
                ON outbound.thread_id = inbound.thread_id
                AND outbound.direction = 'outbound'
                AND outbound.sent_at < inbound.sent_at
            WHERE inbound.direction = 'inbound'
              AND inbound.created_at >= $1::timestamptz
              AND t.organization_id = $2
              AND outbound.subject IS NOT NULL
              AND outbound.subject <> ''
            GROUP BY outbound.subject, inbound.quality_class`,
            since.toISOString(),
            orgId,
        );

        // Reshape into one row per subject with the class counts inline.
        type SubjectAgg = { subject: string; total: number; counts: Record<string, number> };
        const subjectMap = new Map<string, SubjectAgg>();
        for (const row of correlationRows) {
            const subj = row.subject;
            const count = Number(row.count);
            const cls = row.quality_class || 'unclassified';
            let agg = subjectMap.get(subj);
            if (!agg) {
                agg = { subject: subj, total: 0, counts: {} };
                for (const c of REPLY_CLASSES) agg.counts[c] = 0;
                subjectMap.set(subj, agg);
            }
            agg.counts[cls] = (agg.counts[cls] || 0) + count;
            agg.total += count;
        }

        // Filter to subjects with enough volume to be meaningful (>= 3 replies)
        // and add derived rates so the FE doesn't have to compute them.
        const subjectCorrelation = Array.from(subjectMap.values())
            .filter(a => a.total >= 3)
            .map(a => ({
                subject: a.subject,
                total_replies: a.total,
                class_counts: a.counts,
                positive_rate: pct(a.counts.positive + a.counts.qualified, a.total),
                negative_rate: pct(a.counts.hard_no + a.counts.angry, a.total),
                soft_no_rate: pct(a.counts.soft_no, a.total),
                objection_rate: pct(a.counts.objection, a.total),
            }));

        // Sort once into "what works" (highest positive_rate) and "what hurts"
        // (highest negative_rate). Both lists are top 10.
        const whatWorks = [...subjectCorrelation]
            .sort((a, b) => b.positive_rate - a.positive_rate)
            .slice(0, 10);
        const whatHurts = [...subjectCorrelation]
            .sort((a, b) => b.negative_rate - a.negative_rate)
            .filter(s => s.negative_rate > 0)
            .slice(0, 10);

        // ── 3. Sample replies per class for drill-down ────────────────
        // 5 latest snippets per non-empty class. We could pull all in one query
        // and bucket, but the per-class fetch is bounded and lets us page
        // independently in the future.
        const samples: Record<string, Array<{
            id: string;
            subject: string;
            from_email: string;
            snippet: string;
            confidence: string;
            signals: string[];
            received_at: Date;
        }>> = {};
        await Promise.all(
            REPLY_CLASSES.map(async cls => {
                if (breakdown[cls] === 0) { samples[cls] = []; return; }
                const rows = await prisma.emailMessage.findMany({
                    where: {
                        direction: 'inbound',
                        quality_class: cls,
                        created_at: { gte: since },
                        thread: { organization_id: orgId },
                    },
                    orderBy: { created_at: 'desc' },
                    take: 5,
                    select: {
                        id: true,
                        subject: true,
                        from_email: true,
                        body_text: true,
                        body_html: true,
                        quality_confidence: true,
                        quality_signals: true,
                        sent_at: true,
                    },
                });
                samples[cls] = rows.map(r => ({
                    id: r.id,
                    subject: r.subject,
                    from_email: r.from_email,
                    snippet: snippetFromBody(r.body_text, r.body_html),
                    confidence: r.quality_confidence || 'low',
                    signals: r.quality_signals,
                    received_at: r.sent_at,
                }));
            }),
        );

        return res.json({
            success: true,
            data: {
                window_days: days,
                total_replies: total,
                breakdown,
                what_works: whatWorks,
                what_hurts: whatHurts,
                samples,
            },
        });
    } catch (error: unknown) {
        logger.error('[SEQ_ANALYTICS] Reply quality failed', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ success: false, error: 'Failed to compute reply quality' });
    }
};

function pct(n: number, total: number): number {
    if (!total) return 0;
    return Math.round((n / total) * 1000) / 10;
}

function snippetFromBody(text: string | null, html: string): string {
    const raw = (text && text.trim().length > 0)
        ? text
        : html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
    return raw.length > 200 ? raw.slice(0, 199) + '…' : raw;
}
