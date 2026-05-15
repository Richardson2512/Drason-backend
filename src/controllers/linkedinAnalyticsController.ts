/**
 * LinkedIn analytics controller.
 *
 *   GET /api/linkedin/analytics/kpi                      - top-line numbers
 *   GET /api/linkedin/analytics/sender-perf              - per-account stats
 *   GET /api/linkedin/analytics/campaign-perf            - per-campaign stats
 *   GET /api/linkedin/analytics/daily-sent               - daily sent series
 *   GET /api/linkedin/analytics/signal-funnel            - engagement → ICP → enrich → lead
 *   GET /api/linkedin/analytics/acceptance-funnel        - 4-stage waterfall
 *   GET /api/linkedin/analytics/reply-quality            - DM reply classification breakdown
 *   GET /api/linkedin/analytics/step-level               - per-step send / skip / fail / branch
 *   GET /api/linkedin/analytics/sender-capacity          - sender × action heatmap
 *   GET /api/linkedin/analytics/auto-tag-distribution    - Interested / Not Interested / Generic / Untagged
 *   GET /api/linkedin/analytics/signal-lead-funnel       - funnel segmented by event_type
 *   GET /api/linkedin/analytics/account-status           - status tile counts + per-account detail
 *   GET /api/linkedin/analytics/acceptance-by-type       - accept rate by account_type
 *   GET /api/linkedin/analytics/working-hours-compliance - % sends inside configured working hours
 *   GET /api/linkedin/analytics/campaign-sender-affinity - campaign × sender heatmap
 *   GET /api/linkedin/analytics/failure-taxonomy         - skip_reason + error_message counts
 *   GET /api/linkedin/analytics/agent-telemetry          - per-agent latency / cost / count
 *   GET /api/linkedin/analytics/sender-comparison        - daily series for picked senders
 *
 * Common filters (accepted by every handler, ignored when irrelevant):
 *   range            '7d' | '30d' | '90d' | 'ytd' (default 30d)
 *   start_date       ISO date (overrides range lower bound)
 *   end_date         ISO date (defaults to now)
 *   campaign_ids     comma-separated Campaign ids
 *   sender_ids       comma-separated LinkedInAccount ids
 *   account_types    comma-separated CLASSIC|PREMIUM|SALES_NAV|RECRUITER
 *   connection_states comma-separated CONNECTED|INVITE_SENT|INVITE_ACCEPTED|...
 *   event_types      comma-separated REACTION|COMMENT|SHARE|REPOST
 *
 * Every query is scoped by getOrgId(req).
 */

import { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { getOrgId } from '../middleware/orgContext';

interface RangeFilters {
    since: Date;
    until: Date;
    campaignIds: string[] | null;
    senderIds: string[] | null;
    accountTypes: string[] | null;
    connectionStates: string[] | null;
    eventTypes: string[] | null;
}

function parseRangeStart(q: string | undefined): Date {
    const now = new Date();
    switch (q) {
        case '7d':  return new Date(now.getTime() - 7  * 24 * 60 * 60 * 1000);
        case '90d': return new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
        case 'ytd': return new Date(now.getFullYear(), 0, 1);
        case '30d':
        default:    return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    }
}

function splitCsv(v: unknown): string[] | null {
    if (typeof v !== 'string' || !v.trim()) return null;
    const parts = v.split(',').map(s => s.trim()).filter(Boolean);
    return parts.length > 0 ? parts : null;
}

function parseFilters(req: Request): RangeFilters {
    const startQ = req.query.start_date as string | undefined;
    const endQ = req.query.end_date as string | undefined;
    const since = startQ ? new Date(startQ) : parseRangeStart(req.query.range as string | undefined);
    const until = endQ ? new Date(endQ + 'T23:59:59.999Z') : new Date();
    return {
        since,
        until,
        campaignIds: splitCsv(req.query.campaign_ids),
        senderIds: splitCsv(req.query.sender_ids),
        accountTypes: splitCsv(req.query.account_types),
        connectionStates: splitCsv(req.query.connection_states),
        eventTypes: splitCsv(req.query.event_types),
    };
}

function sseTimeWhere(f: RangeFilters): Prisma.SequenceStepExecutionWhereInput {
    const w: Prisma.SequenceStepExecutionWhereInput = {
        completed_at: { gte: f.since, lte: f.until },
    };
    if (f.campaignIds) w.campaign_id = { in: f.campaignIds };
    if (f.senderIds) w.sender_ref_id = { in: f.senderIds };
    return w;
}

async function senderIdsScopedToFilters(orgId: string, f: RangeFilters): Promise<string[] | null> {
    if (!f.senderIds && !f.accountTypes) return null;
    const where: Prisma.LinkedInAccountWhereInput = { organization_id: orgId };
    if (f.senderIds) where.id = { in: f.senderIds };
    if (f.accountTypes) where.account_type = { in: f.accountTypes };
    const rows = await prisma.linkedInAccount.findMany({ where, select: { id: true } });
    return rows.map(r => r.id);
}

function safeNumber(v: unknown): number {
    if (typeof v === 'number') return v;
    if (typeof v === 'bigint') return Number(v);
    if (typeof v === 'string') { const n = Number(v); return Number.isFinite(n) ? n : 0; }
    return 0;
}

function jsonError(err: unknown): { success: false; error: string } {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
}

// ──────────────────────────────────────────────────────────────────────────────
// 1. KPI
// ──────────────────────────────────────────────────────────────────────────────

export const kpi = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const f = parseFilters(req);
        const scopedSenderIds = await senderIdsScopedToFilters(orgId, f);
        const baseSse = sseTimeWhere(f);
        if (scopedSenderIds) baseSse.sender_ref_id = { in: scopedSenderIds };

        const edgeWhere: Prisma.LinkedInConnectionEdgeWhereInput = {
            account: { organization_id: orgId },
            status: 'CONNECTED',
            accepted_at: { gte: f.since, lte: f.until },
        };
        if (scopedSenderIds) edgeWhere.linkedin_account_id = { in: scopedSenderIds };

        const [invitesSent, accepted, dms, repliesReceived] = await Promise.all([
            prisma.sequenceStepExecution.count({ where: { ...baseSse, organization_id: orgId, step_type: 'linkedin_connection_request', status: 'SENT' } }),
            prisma.linkedInConnectionEdge.count({ where: edgeWhere }),
            prisma.sequenceStepExecution.count({ where: { ...baseSse, organization_id: orgId, step_type: { in: ['linkedin_message', 'linkedin_inmail'] }, status: 'SENT' } }),
            prisma.agentRun.count({ where: { organization_id: orgId, agent_name: 'reply_classifier', created_at: { gte: f.since, lte: f.until } } }),
        ]);

        return res.json({
            success: true,
            data: {
                invites_sent: invitesSent,
                accepted,
                acceptance_rate: invitesSent > 0 ? accepted / invitesSent : 0,
                dms_sent: dms,
                replies_received: repliesReceived,
                reply_rate: dms > 0 ? repliesReceived / dms : 0,
            },
        });
    } catch (err) {
        return res.status(500).json(jsonError(err));
    }
};

// ──────────────────────────────────────────────────────────────────────────────
// 2. Sender performance
// ──────────────────────────────────────────────────────────────────────────────

export const senderPerformance = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const f = parseFilters(req);
        const accountWhere: Prisma.LinkedInAccountWhereInput = { organization_id: orgId };
        if (f.senderIds) accountWhere.id = { in: f.senderIds };
        if (f.accountTypes) accountWhere.account_type = { in: f.accountTypes };

        const accounts = await prisma.linkedInAccount.findMany({
            where: accountWhere,
            select: {
                id: true, display_name: true, account_type: true, status: true,
                invites_today: true, max_invites_per_day: true,
                messages_today: true, max_messages_per_day: true,
                inmails_today: true, max_inmails_per_day: true,
            },
        });

        const rows = [];
        for (const a of accounts) {
            const sseBase: Prisma.SequenceStepExecutionWhereInput = {
                organization_id: orgId,
                sender_ref_type: 'linkedin_account',
                sender_ref_id: a.id,
                completed_at: { gte: f.since, lte: f.until },
            };
            if (f.campaignIds) sseBase.campaign_id = { in: f.campaignIds };

            const [sent, accepted, failed, dmsSent] = await Promise.all([
                prisma.sequenceStepExecution.count({ where: { ...sseBase, step_type: 'linkedin_connection_request', status: 'SENT' } }),
                prisma.linkedInConnectionEdge.count({ where: { linkedin_account_id: a.id, status: 'CONNECTED', accepted_at: { gte: f.since, lte: f.until } } }),
                prisma.sequenceStepExecution.count({ where: { ...sseBase, step_type: 'linkedin_connection_request', status: 'FAILED' } }),
                prisma.sequenceStepExecution.count({ where: { ...sseBase, step_type: { in: ['linkedin_message', 'linkedin_inmail'] }, status: 'SENT' } }),
            ]);

            rows.push({
                account_id: a.id,
                display_name: a.display_name,
                account_type: a.account_type,
                status: a.status,
                sent,
                accepted,
                failed,
                dms_sent: dmsSent,
                accept_rate: sent > 0 ? accepted / sent : 0,
                fail_rate: sent > 0 ? failed / sent : 0,
                capacity: {
                    invites: { today: a.invites_today, cap: a.max_invites_per_day },
                    messages: { today: a.messages_today, cap: a.max_messages_per_day },
                    inmails: { today: a.inmails_today, cap: a.max_inmails_per_day },
                },
            });
        }
        rows.sort((a, b) => b.sent - a.sent);
        return res.json({ success: true, data: rows });
    } catch (err) {
        return res.status(500).json(jsonError(err));
    }
};

// ──────────────────────────────────────────────────────────────────────────────
// 3. Campaign performance
// ──────────────────────────────────────────────────────────────────────────────

export const campaignPerformance = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const f = parseFilters(req);
        const campWhere: Prisma.CampaignWhereInput = { organization_id: orgId, linkedinSenders: { some: {} } };
        if (f.campaignIds) campWhere.id = { in: f.campaignIds };

        const campaigns = await prisma.campaign.findMany({
            where: campWhere,
            select: { id: true, name: true, status: true },
            take: 200,
        });

        const rows = [];
        for (const c of campaigns) {
            const grouped = await prisma.sequenceStepExecution.groupBy({
                by: ['step_type', 'status'],
                where: { organization_id: orgId, campaign_id: c.id, completed_at: { gte: f.since, lte: f.until } },
                _count: { _all: true },
            });
            const counts: Record<string, number> = {};
            for (const g of grouped) counts[`${g.step_type}_${g.status}`] = g._count._all;

            const sent = counts['linkedin_connection_request_SENT'] || 0;
            const dmsSent = (counts['linkedin_message_SENT'] || 0) + (counts['linkedin_inmail_SENT'] || 0);
            const skipped = Object.entries(counts).filter(([k]) => k.endsWith('_SKIPPED')).reduce((s, [, v]) => s + v, 0);
            const failed = Object.entries(counts).filter(([k]) => k.endsWith('_FAILED')).reduce((s, [, v]) => s + v, 0);

            const senderIds = (await prisma.campaignLinkedInSender.findMany({
                where: { campaign_id: c.id }, select: { linkedin_account_id: true },
            })).map(s => s.linkedin_account_id);

            const accepted = senderIds.length > 0
                ? await prisma.linkedInConnectionEdge.count({
                    where: { linkedin_account_id: { in: senderIds }, status: 'CONNECTED', accepted_at: { gte: f.since, lte: f.until } },
                })
                : 0;

            rows.push({
                campaign_id: c.id,
                campaign_name: c.name,
                status: c.status,
                sent,
                dms_sent: dmsSent,
                accepted,
                accept_rate: sent > 0 ? accepted / sent : 0,
                skipped,
                failed,
            });
        }
        rows.sort((a, b) => b.sent - a.sent);
        return res.json({ success: true, data: rows });
    } catch (err) {
        return res.status(500).json(jsonError(err));
    }
};

// ──────────────────────────────────────────────────────────────────────────────
// 4. Daily sent
// ──────────────────────────────────────────────────────────────────────────────

export const dailySent = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const f = parseFilters(req);
        const scopedSenderIds = await senderIdsScopedToFilters(orgId, f);

        // Build the where clause for prisma then aggregate by day in JS - keeps
        // the filter logic in one place and avoids hand-rolling a long SQL
        // CTE per filter combination.
        const where: Prisma.SequenceStepExecutionWhereInput = {
            organization_id: orgId,
            step_type: 'linkedin_connection_request',
            status: 'SENT',
            completed_at: { gte: f.since, lte: f.until },
        };
        if (f.campaignIds) where.campaign_id = { in: f.campaignIds };
        if (scopedSenderIds) where.sender_ref_id = { in: scopedSenderIds };

        const rows = await prisma.sequenceStepExecution.findMany({
            where,
            select: { completed_at: true },
        });

        const dayMap = new Map<string, number>();
        for (const r of rows) {
            if (!r.completed_at) continue;
            const day = r.completed_at.toISOString().slice(0, 10);
            dayMap.set(day, (dayMap.get(day) || 0) + 1);
        }
        const out = Array.from(dayMap.entries())
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([day, count]) => ({ day, count }));

        return res.json({ success: true, data: out });
    } catch (err) {
        return res.status(500).json(jsonError(err));
    }
};

// ──────────────────────────────────────────────────────────────────────────────
// 5. Signal funnel (legacy 4-stage, single number per stage)
// ──────────────────────────────────────────────────────────────────────────────

export const signalFunnel = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const f = parseFilters(req);

        const engagementWhere: Prisma.EngagementEventWhereInput = {
            organization_id: orgId,
            occurred_at: { gte: f.since, lte: f.until },
        };
        if (f.eventTypes) engagementWhere.event_type = { in: f.eventTypes };

        const [engagementEvents, icpMatches, enriched, leadsCreated] = await Promise.all([
            prisma.engagementEvent.count({ where: engagementWhere }),
            prisma.agentRun.count({ where: { organization_id: orgId, agent_name: 'icp_matcher', status: 'SUCCESS', created_at: { gte: f.since, lte: f.until } } }),
            prisma.enrichmentAttempt.count({ where: { organization_id: orgId, result: 'HIT', attempted_at: { gte: f.since, lte: f.until } } }),
            prisma.lead.count({
                where: { organization_id: orgId, source: 'linkedin_signal', created_at: { gte: f.since, lte: f.until } } as Prisma.LeadWhereInput,
            }),
        ]);

        return res.json({
            success: true,
            data: {
                engagement_events: engagementEvents,
                icp_matches_evaluated: icpMatches,
                enriched_hits: enriched,
                leads_created: leadsCreated,
            },
        });
    } catch (err) {
        return res.status(500).json(jsonError(err));
    }
};

// ──────────────────────────────────────────────────────────────────────────────
// 6. Acceptance funnel - 4-stage waterfall with drop-off rates
// ──────────────────────────────────────────────────────────────────────────────

export const acceptanceFunnel = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const f = parseFilters(req);
        const scopedSenderIds = await senderIdsScopedToFilters(orgId, f);

        const sseBase: Prisma.SequenceStepExecutionWhereInput = {
            organization_id: orgId,
            completed_at: { gte: f.since, lte: f.until },
        };
        if (f.campaignIds) sseBase.campaign_id = { in: f.campaignIds };
        if (scopedSenderIds) sseBase.sender_ref_id = { in: scopedSenderIds };

        const edgeWhere: Prisma.LinkedInConnectionEdgeWhereInput = {
            account: { organization_id: orgId },
            status: 'CONNECTED',
            accepted_at: { gte: f.since, lte: f.until },
        };
        if (scopedSenderIds) edgeWhere.linkedin_account_id = { in: scopedSenderIds };

        const [invitesSent, accepted, dmsSent, replies] = await Promise.all([
            prisma.sequenceStepExecution.count({ where: { ...sseBase, step_type: 'linkedin_connection_request', status: 'SENT' } }),
            prisma.linkedInConnectionEdge.count({ where: edgeWhere }),
            prisma.sequenceStepExecution.count({ where: { ...sseBase, step_type: { in: ['linkedin_message', 'linkedin_inmail'] }, status: 'SENT' } }),
            prisma.agentRun.count({ where: { organization_id: orgId, agent_name: 'reply_classifier', created_at: { gte: f.since, lte: f.until } } }),
        ]);

        const stage = (label: string, value: number, prev: number) => ({
            label, value,
            conversion_from_prev: prev > 0 ? value / prev : 0,
            drop_off_from_prev: prev > 0 ? (prev - value) / prev : 0,
        });

        return res.json({
            success: true,
            data: {
                stages: [
                    stage('Invites sent', invitesSent, invitesSent),
                    stage('Accepted', accepted, invitesSent),
                    stage('DMs sent', dmsSent, accepted),
                    stage('Replies received', replies, dmsSent),
                ],
                overall_conversion: invitesSent > 0 ? replies / invitesSent : 0,
            },
        });
    } catch (err) {
        return res.status(500).json(jsonError(err));
    }
};

// ──────────────────────────────────────────────────────────────────────────────
// 7. Reply quality - 9-class breakdown from AgentRun(reply_classifier).decision
// ──────────────────────────────────────────────────────────────────────────────

const REPLY_CLASSES = ['positive', 'qualified', 'objection', 'referral', 'soft_no', 'hard_no', 'angry', 'auto', 'unclassified'] as const;
type ReplyClass = typeof REPLY_CLASSES[number];

export const replyQuality = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const f = parseFilters(req);

        const runs = await prisma.agentRun.findMany({
            where: {
                organization_id: orgId,
                agent_name: 'reply_classifier',
                created_at: { gte: f.since, lte: f.until },
            },
            select: { id: true, decision: true, latency_ms: true, cost_usd: true, status: true, created_at: true, trigger_ref_id: true },
            orderBy: { created_at: 'desc' },
            take: 5000,
        });

        const breakdown: Record<ReplyClass, number> = {
            positive: 0, qualified: 0, objection: 0, referral: 0,
            soft_no: 0, hard_no: 0, angry: 0, auto: 0, unclassified: 0,
        };
        const samplesByClass: Record<ReplyClass, Array<{ agent_run_id: string; trigger_ref_id: string | null; confidence: number | null; signals: string[]; created_at: string }>> = {
            positive: [], qualified: [], objection: [], referral: [],
            soft_no: [], hard_no: [], angry: [], auto: [], unclassified: [],
        };

        for (const r of runs) {
            const d = (r.decision || {}) as Record<string, unknown>;
            const rawClass = String((d.class ?? d.classification ?? d.label ?? 'unclassified')).toLowerCase();
            const cls: ReplyClass = (REPLY_CLASSES as readonly string[]).includes(rawClass) ? (rawClass as ReplyClass) : 'unclassified';
            breakdown[cls] += 1;
            if (samplesByClass[cls].length < 5) {
                const conf = typeof d.confidence === 'number' ? d.confidence : null;
                const signals = Array.isArray(d.signals) ? (d.signals as unknown[]).map(String).slice(0, 6) : [];
                samplesByClass[cls].push({
                    agent_run_id: r.id,
                    trigger_ref_id: r.trigger_ref_id,
                    confidence: conf,
                    signals,
                    created_at: r.created_at.toISOString(),
                });
            }
        }

        const total = Object.values(breakdown).reduce((a, b) => a + b, 0);

        return res.json({
            success: true,
            data: {
                total_replies: total,
                breakdown,
                breakdown_pct: Object.fromEntries(
                    REPLY_CLASSES.map(c => [c, total > 0 ? breakdown[c] / total : 0]),
                ),
                samples: samplesByClass,
            },
        });
    } catch (err) {
        return res.status(500).json(jsonError(err));
    }
};

// ──────────────────────────────────────────────────────────────────────────────
// 8. Step-level performance
// ──────────────────────────────────────────────────────────────────────────────

export const stepLevelPerformance = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const f = parseFilters(req);
        const scopedSenderIds = await senderIdsScopedToFilters(orgId, f);

        const where: Prisma.SequenceStepExecutionWhereInput = {
            organization_id: orgId,
            step_type: { in: ['linkedin_connection_request', 'linkedin_message', 'linkedin_inmail'] },
            completed_at: { gte: f.since, lte: f.until },
        };
        if (f.campaignIds) where.campaign_id = { in: f.campaignIds };
        if (scopedSenderIds) where.sender_ref_id = { in: scopedSenderIds };

        const grouped = await prisma.sequenceStepExecution.groupBy({
            by: ['step_type', 'status'],
            where,
            _count: { _all: true },
        });

        type Bucket = { sent: number; skipped: number; failed: number; branched: number; total: number };
        const init = (): Bucket => ({ sent: 0, skipped: 0, failed: 0, branched: 0, total: 0 });
        const byStep: Record<string, Bucket> = {
            linkedin_connection_request: init(),
            linkedin_message: init(),
            linkedin_inmail: init(),
        };
        for (const g of grouped) {
            const bucket = byStep[g.step_type];
            if (!bucket) continue;
            const c = g._count._all;
            bucket.total += c;
            if (g.status === 'SENT') bucket.sent += c;
            else if (g.status === 'SKIPPED') bucket.skipped += c;
            else if (g.status === 'FAILED') bucket.failed += c;
            else if (g.status === 'BRANCHED') bucket.branched += c;
        }

        const branched = await prisma.sequenceStepExecution.count({
            where: { ...where, branched_to_step: { not: null } },
        });

        const steps = (Object.keys(byStep) as Array<keyof typeof byStep>).map(stepType => {
            const b = byStep[stepType];
            return {
                step_type: stepType,
                ...b,
                send_rate: b.total > 0 ? b.sent / b.total : 0,
                fail_rate: b.total > 0 ? b.failed / b.total : 0,
                skip_rate: b.total > 0 ? b.skipped / b.total : 0,
            };
        });

        return res.json({ success: true, data: { steps, branched } });
    } catch (err) {
        return res.status(500).json(jsonError(err));
    }
};

// ──────────────────────────────────────────────────────────────────────────────
// 9. Sender capacity heatmap - current today/cap per sender per action
// ──────────────────────────────────────────────────────────────────────────────

export const senderCapacity = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const f = parseFilters(req);
        const where: Prisma.LinkedInAccountWhereInput = { organization_id: orgId };
        if (f.senderIds) where.id = { in: f.senderIds };
        if (f.accountTypes) where.account_type = { in: f.accountTypes };

        const accounts = await prisma.linkedInAccount.findMany({
            where,
            select: {
                id: true, display_name: true, account_type: true, status: true,
                invites_today: true, max_invites_per_day: true,
                invites_this_week: true, max_invites_per_week: true,
                messages_today: true, max_messages_per_day: true,
                inmails_today: true, max_inmails_per_day: true,
                profile_views_today: true, max_profile_views_per_day: true,
            },
            orderBy: { display_name: 'asc' },
        });

        const ratio = (used: number, cap: number) => cap > 0 ? used / cap : 0;

        const rows = accounts.map(a => ({
            account_id: a.id,
            display_name: a.display_name,
            account_type: a.account_type,
            status: a.status,
            cells: {
                invites_day:  { used: a.invites_today,        cap: a.max_invites_per_day,        ratio: ratio(a.invites_today,        a.max_invites_per_day) },
                invites_week: { used: a.invites_this_week,    cap: a.max_invites_per_week,       ratio: ratio(a.invites_this_week,    a.max_invites_per_week) },
                messages:     { used: a.messages_today,       cap: a.max_messages_per_day,       ratio: ratio(a.messages_today,       a.max_messages_per_day) },
                inmails:      { used: a.inmails_today,        cap: a.max_inmails_per_day,        ratio: ratio(a.inmails_today,        a.max_inmails_per_day) },
                profile_views:{ used: a.profile_views_today,  cap: a.max_profile_views_per_day,  ratio: ratio(a.profile_views_today,  a.max_profile_views_per_day) },
            },
        }));

        return res.json({ success: true, data: rows });
    } catch (err) {
        return res.status(500).json(jsonError(err));
    }
};

// ──────────────────────────────────────────────────────────────────────────────
// 10. Auto-tag distribution
// ──────────────────────────────────────────────────────────────────────────────

export const autoTagDistribution = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const f = parseFilters(req);

        const profileWhere: Prisma.LinkedInProfileWhereInput = {
            organization_id: orgId,
        };

        const [tagged, untagged] = await Promise.all([
            prisma.linkedInProfile.groupBy({
                by: ['linkedin_auto_tag'],
                where: {
                    ...profileWhere,
                    linkedin_auto_tag: { not: null },
                    linkedin_auto_tagged_at: { gte: f.since, lte: f.until },
                },
                _count: { _all: true },
            }),
            prisma.linkedInProfile.count({ where: { ...profileWhere, linkedin_auto_tag: null } }),
        ]);

        const buckets: Record<string, number> = { Interested: 0, 'Not Interested': 0, Generic: 0 };
        for (const g of tagged) {
            const t = g.linkedin_auto_tag ?? '';
            if (t in buckets) buckets[t] += g._count._all;
            else buckets[t] = g._count._all;
        }

        const total = Object.values(buckets).reduce((s, v) => s + v, 0) + untagged;

        return res.json({
            success: true,
            data: {
                buckets: { ...buckets, Untagged: untagged },
                total_profiles: total,
                tagged_in_window: Object.values(buckets).reduce((s, v) => s + v, 0),
            },
        });
    } catch (err) {
        return res.status(500).json(jsonError(err));
    }
};

// ──────────────────────────────────────────────────────────────────────────────
// 11. Signal → Lead funnel, segmented by event_type
// ──────────────────────────────────────────────────────────────────────────────

export const signalLeadFunnel = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const f = parseFilters(req);

        const types = ['REACTION', 'COMMENT', 'SHARE', 'REPOST'];
        const eventsByType = await prisma.engagementEvent.groupBy({
            by: ['event_type'],
            where: {
                organization_id: orgId,
                occurred_at: { gte: f.since, lte: f.until },
                ...(f.eventTypes ? { event_type: { in: f.eventTypes } } : {}),
            },
            _count: { _all: true },
        });
        const eventTypeCounts = Object.fromEntries(types.map(t => [t, 0]));
        for (const g of eventsByType) eventTypeCounts[g.event_type] = g._count._all;

        const [totalEvents, icpEvaluated, icpMatched, enrichedHits, leadsCreated] = await Promise.all([
            prisma.engagementEvent.count({
                where: { organization_id: orgId, occurred_at: { gte: f.since, lte: f.until }, ...(f.eventTypes ? { event_type: { in: f.eventTypes } } : {}) },
            }),
            prisma.agentRun.count({
                where: { organization_id: orgId, agent_name: 'icp_matcher', created_at: { gte: f.since, lte: f.until } },
            }),
            prisma.agentRun.count({
                where: { organization_id: orgId, agent_name: 'icp_matcher', status: 'SUCCESS', created_at: { gte: f.since, lte: f.until } },
            }),
            prisma.enrichmentAttempt.count({
                where: { organization_id: orgId, result: 'HIT', attempted_at: { gte: f.since, lte: f.until } },
            }),
            prisma.lead.count({
                where: { organization_id: orgId, source: 'linkedin_signal', created_at: { gte: f.since, lte: f.until } } as Prisma.LeadWhereInput,
            }),
        ]);

        return res.json({
            success: true,
            data: {
                stages: [
                    { label: 'Engagement events',  value: totalEvents },
                    { label: 'ICP evaluated',      value: icpEvaluated },
                    { label: 'ICP matched',        value: icpMatched },
                    { label: 'Enriched (HIT)',     value: enrichedHits },
                    { label: 'Leads created',      value: leadsCreated },
                ],
                event_type_breakdown: eventTypeCounts,
                overall_conversion: totalEvents > 0 ? leadsCreated / totalEvents : 0,
            },
        });
    } catch (err) {
        return res.status(500).json(jsonError(err));
    }
};

// ──────────────────────────────────────────────────────────────────────────────
// 12. Account status monitor
// ──────────────────────────────────────────────────────────────────────────────

export const accountStatus = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const f = parseFilters(req);
        const where: Prisma.LinkedInAccountWhereInput = { organization_id: orgId };
        if (f.senderIds) where.id = { in: f.senderIds };
        if (f.accountTypes) where.account_type = { in: f.accountTypes };

        const [grouped, accounts] = await Promise.all([
            prisma.linkedInAccount.groupBy({
                by: ['status'],
                where,
                _count: { _all: true },
            }),
            prisma.linkedInAccount.findMany({
                where,
                select: { id: true, display_name: true, account_type: true, status: true, status_detail: true, last_status_at: true, connected_at: true },
                orderBy: { last_status_at: 'desc' },
                take: 200,
            }),
        ]);

        const buckets: Record<string, number> = { OK: 0, CONNECTING: 0, CREDENTIALS: 0, ERROR: 0, SYNC_SUCCESS: 0, DELETED: 0 };
        for (const g of grouped) buckets[g.status] = (buckets[g.status] || 0) + g._count._all;

        return res.json({
            success: true,
            data: {
                buckets,
                total_accounts: accounts.length,
                accounts: accounts.map(a => ({
                    account_id: a.id,
                    display_name: a.display_name,
                    account_type: a.account_type,
                    status: a.status,
                    status_detail: a.status_detail,
                    last_status_at: a.last_status_at?.toISOString() ?? null,
                    connected_at: a.connected_at?.toISOString() ?? null,
                })),
            },
        });
    } catch (err) {
        return res.status(500).json(jsonError(err));
    }
};

// ──────────────────────────────────────────────────────────────────────────────
// 13. Acceptance rate by account type
// ──────────────────────────────────────────────────────────────────────────────

export const acceptanceByType = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const f = parseFilters(req);
        const where: Prisma.LinkedInAccountWhereInput = { organization_id: orgId };
        if (f.senderIds) where.id = { in: f.senderIds };
        if (f.accountTypes) where.account_type = { in: f.accountTypes };

        const accounts = await prisma.linkedInAccount.findMany({ where, select: { id: true, account_type: true } });
        const byType = new Map<string, { account_ids: string[]; sent: number; accepted: number }>();
        for (const a of accounts) {
            const entry = byType.get(a.account_type) ?? { account_ids: [], sent: 0, accepted: 0 };
            entry.account_ids.push(a.id);
            byType.set(a.account_type, entry);
        }

        const rows = [];
        for (const [accountType, entry] of byType) {
            if (entry.account_ids.length === 0) {
                rows.push({ account_type: accountType, account_count: 0, sent: 0, accepted: 0, accept_rate: 0 });
                continue;
            }
            const [sent, accepted] = await Promise.all([
                prisma.sequenceStepExecution.count({
                    where: {
                        organization_id: orgId,
                        step_type: 'linkedin_connection_request',
                        status: 'SENT',
                        completed_at: { gte: f.since, lte: f.until },
                        sender_ref_type: 'linkedin_account',
                        sender_ref_id: { in: entry.account_ids },
                        ...(f.campaignIds ? { campaign_id: { in: f.campaignIds } } : {}),
                    },
                }),
                prisma.linkedInConnectionEdge.count({
                    where: {
                        linkedin_account_id: { in: entry.account_ids },
                        status: 'CONNECTED',
                        accepted_at: { gte: f.since, lte: f.until },
                    },
                }),
            ]);
            rows.push({
                account_type: accountType,
                account_count: entry.account_ids.length,
                sent,
                accepted,
                accept_rate: sent > 0 ? accepted / sent : 0,
            });
        }
        rows.sort((a, b) => b.sent - a.sent);
        return res.json({ success: true, data: rows });
    } catch (err) {
        return res.status(500).json(jsonError(err));
    }
};

// ──────────────────────────────────────────────────────────────────────────────
// 14. Working-hours compliance
// ──────────────────────────────────────────────────────────────────────────────

interface WorkingHoursShape {
    tz?: string;
    days?: number[];   // 0=Sun, 6=Sat
    start?: string;    // 'HH:mm'
    end?: string;      // 'HH:mm'
}

function parseHHmm(s: string | undefined): number | null {
    if (!s) return null;
    const m = /^(\d{1,2}):(\d{2})$/.exec(s);
    if (!m) return null;
    const h = Number(m[1]);
    const mi = Number(m[2]);
    if (!Number.isFinite(h) || !Number.isFinite(mi)) return null;
    return h * 60 + mi;
}

function isInsideWorkingHours(at: Date, wh: WorkingHoursShape | null): boolean {
    if (!wh) return true;
    const start = parseHHmm(wh.start);
    const end = parseHHmm(wh.end);
    const day = at.getUTCDay();
    if (Array.isArray(wh.days) && wh.days.length > 0 && !wh.days.includes(day)) return false;
    if (start == null || end == null) return true;
    const minute = at.getUTCHours() * 60 + at.getUTCMinutes();
    return minute >= start && minute < end;
}

export const workingHoursCompliance = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const f = parseFilters(req);

        const senderWhere: Prisma.LinkedInAccountWhereInput = { organization_id: orgId };
        if (f.senderIds) senderWhere.id = { in: f.senderIds };
        if (f.accountTypes) senderWhere.account_type = { in: f.accountTypes };

        const accounts = await prisma.linkedInAccount.findMany({
            where: senderWhere,
            select: { id: true, display_name: true, account_type: true },
        });

        // Per-account working_hours can vary by campaign - pick the most
        // specific working_hours window for each (campaign, sender) pair.
        const campaignSenders = await prisma.campaignLinkedInSender.findMany({
            where: { linkedin_account_id: { in: accounts.map(a => a.id) } },
            select: { campaign_id: true, linkedin_account_id: true, working_hours: true },
        });
        const whByPair = new Map<string, WorkingHoursShape | null>();
        for (const cs of campaignSenders) {
            const key = `${cs.campaign_id}:${cs.linkedin_account_id}`;
            whByPair.set(key, (cs.working_hours as WorkingHoursShape | null) ?? null);
        }

        const rows = [];
        for (const a of accounts) {
            const sends = await prisma.sequenceStepExecution.findMany({
                where: {
                    organization_id: orgId,
                    sender_ref_type: 'linkedin_account',
                    sender_ref_id: a.id,
                    status: 'SENT',
                    step_type: { in: ['linkedin_connection_request', 'linkedin_message', 'linkedin_inmail'] },
                    completed_at: { gte: f.since, lte: f.until },
                    ...(f.campaignIds ? { campaign_id: { in: f.campaignIds } } : {}),
                },
                select: { campaign_id: true, completed_at: true },
            });

            let compliant = 0;
            let out = 0;
            for (const s of sends) {
                if (!s.completed_at) continue;
                const wh = whByPair.get(`${s.campaign_id}:${a.id}`) ?? null;
                if (isInsideWorkingHours(s.completed_at, wh)) compliant += 1;
                else out += 1;
            }
            const total = compliant + out;
            rows.push({
                account_id: a.id,
                display_name: a.display_name,
                account_type: a.account_type,
                total_sends: total,
                in_hours: compliant,
                out_of_hours: out,
                compliance_rate: total > 0 ? compliant / total : 1,
            });
        }
        rows.sort((a, b) => a.compliance_rate - b.compliance_rate);
        return res.json({ success: true, data: rows });
    } catch (err) {
        return res.status(500).json(jsonError(err));
    }
};

// ──────────────────────────────────────────────────────────────────────────────
// 15. Campaign × sender affinity heatmap
// ──────────────────────────────────────────────────────────────────────────────

export const campaignSenderAffinity = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const f = parseFilters(req);
        const scopedSenderIds = await senderIdsScopedToFilters(orgId, f);

        const where: Prisma.SequenceStepExecutionWhereInput = {
            organization_id: orgId,
            step_type: 'linkedin_connection_request',
            completed_at: { gte: f.since, lte: f.until },
            sender_ref_type: 'linkedin_account',
        };
        if (f.campaignIds) where.campaign_id = { in: f.campaignIds };
        if (scopedSenderIds) where.sender_ref_id = { in: scopedSenderIds };

        const grouped = await prisma.sequenceStepExecution.groupBy({
            by: ['campaign_id', 'sender_ref_id', 'status'],
            where,
            _count: { _all: true },
        });

        type Cell = { sent: number; failed: number; skipped: number; accepted: number };
        const cellMap = new Map<string, Cell>();
        const campaignIds = new Set<string>();
        const senderIds = new Set<string>();

        for (const g of grouped) {
            if (!g.sender_ref_id) continue;
            const key = `${g.campaign_id}:${g.sender_ref_id}`;
            const cur = cellMap.get(key) ?? { sent: 0, failed: 0, skipped: 0, accepted: 0 };
            if (g.status === 'SENT') cur.sent += g._count._all;
            else if (g.status === 'FAILED') cur.failed += g._count._all;
            else if (g.status === 'SKIPPED') cur.skipped += g._count._all;
            cellMap.set(key, cur);
            campaignIds.add(g.campaign_id);
            senderIds.add(g.sender_ref_id);
        }

        // Acceptance is keyed to (sender, time-range) only; we don't have a
        // campaign-attributed acceptance yet, so we apportion accepted edges
        // to a campaign by the share of CRs that sender sent for it.
        const senderAccepted = new Map<string, number>();
        if (senderIds.size > 0) {
            const edges = await prisma.linkedInConnectionEdge.groupBy({
                by: ['linkedin_account_id'],
                where: {
                    linkedin_account_id: { in: Array.from(senderIds) },
                    status: 'CONNECTED',
                    accepted_at: { gte: f.since, lte: f.until },
                },
                _count: { _all: true },
            });
            for (const e of edges) senderAccepted.set(e.linkedin_account_id, e._count._all);
        }

        const senderTotalSent = new Map<string, number>();
        for (const [key, cell] of cellMap) {
            const sid = key.split(':')[1];
            senderTotalSent.set(sid, (senderTotalSent.get(sid) ?? 0) + cell.sent);
        }
        for (const [key, cell] of cellMap) {
            const sid = key.split(':')[1];
            const senderSent = senderTotalSent.get(sid) ?? 0;
            const totalAccepted = senderAccepted.get(sid) ?? 0;
            cell.accepted = senderSent > 0 ? Math.round((cell.sent / senderSent) * totalAccepted) : 0;
        }

        const [campaigns, senders] = await Promise.all([
            prisma.campaign.findMany({ where: { id: { in: Array.from(campaignIds) } }, select: { id: true, name: true } }),
            prisma.linkedInAccount.findMany({ where: { id: { in: Array.from(senderIds) } }, select: { id: true, display_name: true } }),
        ]);

        const cells = Array.from(cellMap.entries()).map(([key, c]) => {
            const [campaign_id, sender_id] = key.split(':');
            return {
                campaign_id,
                sender_id,
                sent: c.sent,
                failed: c.failed,
                skipped: c.skipped,
                accepted: c.accepted,
                accept_rate: c.sent > 0 ? c.accepted / c.sent : 0,
            };
        });

        return res.json({
            success: true,
            data: {
                campaigns: campaigns.map(c => ({ id: c.id, name: c.name })),
                senders: senders.map(s => ({ id: s.id, name: s.display_name })),
                cells,
            },
        });
    } catch (err) {
        return res.status(500).json(jsonError(err));
    }
};

// ──────────────────────────────────────────────────────────────────────────────
// 16. Failure taxonomy
// ──────────────────────────────────────────────────────────────────────────────

export const failureTaxonomy = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const f = parseFilters(req);
        const scopedSenderIds = await senderIdsScopedToFilters(orgId, f);

        const baseWhere: Prisma.SequenceStepExecutionWhereInput = {
            organization_id: orgId,
            step_type: { in: ['linkedin_connection_request', 'linkedin_message', 'linkedin_inmail'] },
            completed_at: { gte: f.since, lte: f.until },
        };
        if (f.campaignIds) baseWhere.campaign_id = { in: f.campaignIds };
        if (scopedSenderIds) baseWhere.sender_ref_id = { in: scopedSenderIds };

        const [skipGrouped, failRows] = await Promise.all([
            prisma.sequenceStepExecution.groupBy({
                by: ['skip_reason'],
                where: { ...baseWhere, status: 'SKIPPED' },
                _count: { _all: true },
            }),
            prisma.sequenceStepExecution.findMany({
                where: { ...baseWhere, status: 'FAILED' },
                select: { error_message: true },
                take: 5000,
            }),
        ]);

        const skipReasons = skipGrouped
            .map(g => ({ reason: g.skip_reason ?? 'unknown', count: g._count._all }))
            .sort((a, b) => b.count - a.count);

        // Normalize free-text error messages into buckets by their first
        // ~60 chars so we don't show 4000 unique strings - the prefix is
        // typically the error class.
        const errorBuckets = new Map<string, number>();
        for (const r of failRows) {
            const key = (r.error_message ?? 'unknown').slice(0, 80);
            errorBuckets.set(key, (errorBuckets.get(key) ?? 0) + 1);
        }
        const errors = Array.from(errorBuckets.entries())
            .map(([message, count]) => ({ message, count }))
            .sort((a, b) => b.count - a.count)
            .slice(0, 50);

        return res.json({ success: true, data: { skip_reasons: skipReasons, errors } });
    } catch (err) {
        return res.status(500).json(jsonError(err));
    }
};

// ──────────────────────────────────────────────────────────────────────────────
// 17. Agent telemetry
// ──────────────────────────────────────────────────────────────────────────────

export const agentTelemetry = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const f = parseFilters(req);

        const agentNames = ['supervisor', 'signal_monitoring', 'icp_matcher', 'enrichment', 'reply_classifier'];
        const grouped = await prisma.agentRun.groupBy({
            by: ['agent_name', 'status'],
            where: {
                organization_id: orgId,
                agent_name: { in: agentNames },
                created_at: { gte: f.since, lte: f.until },
            },
            _count: { _all: true },
            _avg: { latency_ms: true },
            _sum: { cost_usd: true, prompt_tokens: true, completion_tokens: true },
        });

        type Agg = {
            count: number;
            success: number;
            error: number;
            skipped: number;
            latency_avg_ms: number;
            cost_usd: number;
            prompt_tokens: number;
            completion_tokens: number;
            _latency_weighted_sum: number;
        };
        const init = (): Agg => ({ count: 0, success: 0, error: 0, skipped: 0, latency_avg_ms: 0, cost_usd: 0, prompt_tokens: 0, completion_tokens: 0, _latency_weighted_sum: 0 });
        const byAgent: Record<string, Agg> = Object.fromEntries(agentNames.map(n => [n, init()]));

        for (const g of grouped) {
            const a = byAgent[g.agent_name];
            if (!a) continue;
            const c = g._count._all;
            a.count += c;
            if (g.status === 'SUCCESS') a.success += c;
            else if (g.status === 'ERROR') a.error += c;
            else if (g.status === 'SKIPPED') a.skipped += c;
            a._latency_weighted_sum += (g._avg.latency_ms ?? 0) * c;
            a.cost_usd += Number(g._sum.cost_usd ?? 0);
            a.prompt_tokens += g._sum.prompt_tokens ?? 0;
            a.completion_tokens += g._sum.completion_tokens ?? 0;
        }

        const rows = agentNames.map(n => {
            const a = byAgent[n];
            return {
                agent_name: n,
                count: a.count,
                success: a.success,
                error: a.error,
                skipped: a.skipped,
                latency_avg_ms: a.count > 0 ? Math.round(a._latency_weighted_sum / a.count) : 0,
                cost_usd: Number(a.cost_usd.toFixed(6)),
                prompt_tokens: a.prompt_tokens,
                completion_tokens: a.completion_tokens,
                error_rate: a.count > 0 ? a.error / a.count : 0,
            };
        });

        return res.json({ success: true, data: rows });
    } catch (err) {
        return res.status(500).json(jsonError(err));
    }
};

// ──────────────────────────────────────────────────────────────────────────────
// 18. Sender comparison - daily series for selected senders
// ──────────────────────────────────────────────────────────────────────────────

export const senderComparison = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const f = parseFilters(req);
        if (!f.senderIds || f.senderIds.length === 0) {
            return res.json({ success: true, data: { senders: [], series: [] } });
        }

        const senders = await prisma.linkedInAccount.findMany({
            where: { id: { in: f.senderIds }, organization_id: orgId },
            select: { id: true, display_name: true, account_type: true },
        });

        const rows = await prisma.sequenceStepExecution.findMany({
            where: {
                organization_id: orgId,
                sender_ref_type: 'linkedin_account',
                sender_ref_id: { in: f.senderIds },
                status: 'SENT',
                step_type: { in: ['linkedin_connection_request', 'linkedin_message', 'linkedin_inmail'] },
                completed_at: { gte: f.since, lte: f.until },
            },
            select: { sender_ref_id: true, step_type: true, completed_at: true },
        });

        type DayCell = { invites: number; messages: number; inmails: number };
        const senderDayMap = new Map<string, Map<string, DayCell>>();
        for (const r of rows) {
            if (!r.completed_at || !r.sender_ref_id) continue;
            const day = r.completed_at.toISOString().slice(0, 10);
            const sMap = senderDayMap.get(r.sender_ref_id) ?? new Map<string, DayCell>();
            const cur = sMap.get(day) ?? { invites: 0, messages: 0, inmails: 0 };
            if (r.step_type === 'linkedin_connection_request') cur.invites += 1;
            else if (r.step_type === 'linkedin_message') cur.messages += 1;
            else if (r.step_type === 'linkedin_inmail') cur.inmails += 1;
            sMap.set(day, cur);
            senderDayMap.set(r.sender_ref_id, sMap);
        }

        const series = senders.map(s => ({
            sender_id: s.id,
            display_name: s.display_name,
            account_type: s.account_type,
            daily: Array.from((senderDayMap.get(s.id) ?? new Map()).entries())
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([day, cell]) => ({ day, ...(cell as DayCell) })),
        }));

        return res.json({
            success: true,
            data: { senders, series },
        });
    } catch (err) {
        return res.status(500).json(jsonError(err));
    }
};

// Unused helpers (kept for completeness - referenced via exports). Eliminates
// dead-code warnings if a future handler needs them.
void safeNumber;
