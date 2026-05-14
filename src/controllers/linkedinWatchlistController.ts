/**
 * Signal Watchlist controller — CRUD + scan trigger + match review.
 *
 * Routes (mounted under /api/linkedin):
 *   GET    /watchlists
 *   POST   /watchlists
 *   GET    /watchlists/:id
 *   PATCH  /watchlists/:id
 *   DELETE /watchlists/:id
 *   POST   /watchlists/:id/run-now
 *   GET    /watchlists/:id/matches?status=&limit=
 *   POST   /watchlists/:id/matches/:matchId/push
 *   POST   /watchlists/:id/matches/:matchId/skip
 *
 * Server-side ceilings — protect operators from accidentally configuring
 * a watchlist that would burn through LinkedIn's daily action ceiling
 * (and risk an account block):
 *   - keywords: max 5
 *   - daily_signal_budget: max 100
 *   - min_reaction_count: floor 0
 */

import { Request, Response } from 'express';
import { prisma } from '../prisma';
import { getOrgId } from '../middleware/orgContext';

const MAX_KEYWORDS = 5;
const MAX_DAILY_BUDGET = 100;

export const list = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const rows = await prisma.signalWatchlist.findMany({
            where: { organization_id: orgId },
            orderBy: { created_at: 'desc' },
        });
        return res.json({ success: true, data: rows });
    } catch (err) {
        return res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
    }
};

export const create = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const body = req.body as Record<string, unknown>;

        const name = String(body.name ?? '').trim();
        if (!name) return res.status(400).json({ success: false, error: 'name is required' });

        const keywords = Array.isArray(body.keywords)
            ? (body.keywords as unknown[]).map(s => String(s).trim()).filter(Boolean).slice(0, MAX_KEYWORDS)
            : [];
        if (keywords.length === 0) {
            return res.status(400).json({ success: false, error: 'At least one keyword is required' });
        }

        const routing_mode = body.routing_mode === 'auto_push' ? 'auto_push' : 'manual_review';
        const target_campaign_id = (body.target_campaign_id as string | undefined) ?? null;
        if (routing_mode === 'auto_push') {
            if (!target_campaign_id) {
                return res.status(400).json({ success: false, error: 'target_campaign_id is required when routing_mode=auto_push' });
            }
            const campaign = await prisma.campaign.findFirst({
                where: { id: target_campaign_id, organization_id: orgId, channel: 'linkedin' },
                select: { id: true },
            });
            if (!campaign) {
                return res.status(400).json({ success: false, error: 'target_campaign_id must reference a LinkedIn campaign in this org' });
            }
        }

        const enabled = body.enabled !== false;
        const created = await prisma.signalWatchlist.create({
            data: {
                organization_id: orgId,
                name,
                kind: 'TOPICS',
                keywords,
                icp_profile_id: (body.icp_profile_id as string) ?? null,
                excluded_profile_slugs: clampStrArr(body.excluded_profile_slugs, 50),
                excluded_company_terms: clampStrArr(body.excluded_company_terms, 50),
                min_reaction_count: clampInt(body.min_reaction_count, 0, 1000, 20),
                daily_signal_budget: clampInt(body.daily_signal_budget, 1, MAX_DAILY_BUDGET, 50),
                routing_mode,
                target_campaign_id: routing_mode === 'auto_push' ? target_campaign_id : null,
                enabled,
                // Seed next_run_at so the watchlist runner picks the
                // new row up on its next tick. NULL = never scheduled.
                next_run_at: enabled ? new Date() : null,
            },
        });

        return res.status(201).json({ success: true, data: created });
    } catch (err) {
        return res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
    }
};

export const detail = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const id = String(req.params.id);
        const row = await prisma.signalWatchlist.findFirst({
            where: { id, organization_id: orgId },
        });
        if (!row) return res.status(404).json({ success: false, error: 'Watchlist not found' });

        const [counts, recent] = await Promise.all([
            prisma.signalWatchlistMatch.groupBy({
                by: ['status'],
                where: { watchlist_id: id },
                _count: true,
            }),
            prisma.signalWatchlistMatch.findMany({
                where: { watchlist_id: id },
                orderBy: { created_at: 'desc' },
                take: 10,
            }),
        ]);

        const by_status = counts.reduce((acc, c) => { acc[c.status] = c._count; return acc; }, {} as Record<string, number>);
        return res.json({ success: true, data: { ...row, _stats: { by_status, total: counts.reduce((s, c) => s + c._count, 0) }, recent_matches: recent } });
    } catch (err) {
        return res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
    }
};

export const update = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const id = String(req.params.id);
        const existing = await prisma.signalWatchlist.findFirst({
            where: { id, organization_id: orgId }, select: { id: true },
        });
        if (!existing) return res.status(404).json({ success: false, error: 'Watchlist not found' });

        const body = req.body as Record<string, unknown>;
        const data: Record<string, unknown> = {};
        if (body.name !== undefined) data.name = String(body.name).trim();
        if (Array.isArray(body.keywords)) {
            const k = (body.keywords as unknown[]).map(s => String(s).trim()).filter(Boolean).slice(0, MAX_KEYWORDS);
            if (k.length === 0) return res.status(400).json({ success: false, error: 'At least one keyword is required' });
            data.keywords = k;
        }
        if (body.icp_profile_id !== undefined) data.icp_profile_id = body.icp_profile_id || null;
        if (body.excluded_profile_slugs !== undefined) data.excluded_profile_slugs = clampStrArr(body.excluded_profile_slugs, 50);
        if (body.excluded_company_terms !== undefined) data.excluded_company_terms = clampStrArr(body.excluded_company_terms, 50);
        if (body.min_reaction_count !== undefined) data.min_reaction_count = clampInt(body.min_reaction_count, 0, 1000, 20);
        if (body.daily_signal_budget !== undefined) data.daily_signal_budget = clampInt(body.daily_signal_budget, 1, MAX_DAILY_BUDGET, 50);
        if (body.routing_mode !== undefined) data.routing_mode = body.routing_mode === 'auto_push' ? 'auto_push' : 'manual_review';
        if (body.target_campaign_id !== undefined) data.target_campaign_id = body.target_campaign_id || null;
        if (body.enabled !== undefined) {
            const enabled = Boolean(body.enabled);
            data.enabled = enabled;
            // When re-enabling a watchlist that hasn't run recently, give
            // it an immediate slot so the runner picks it up next tick.
            if (enabled) data.next_run_at = new Date();
        }

        const updated = await prisma.signalWatchlist.update({
            where: { id }, data,
        });
        return res.json({ success: true, data: updated });
    } catch (err) {
        return res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
    }
};

export const remove = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const id = String(req.params.id);
        const existing = await prisma.signalWatchlist.findFirst({
            where: { id, organization_id: orgId }, select: { id: true },
        });
        if (!existing) return res.status(404).json({ success: false, error: 'Watchlist not found' });
        await prisma.signalWatchlist.delete({ where: { id } });
        return res.json({ success: true });
    } catch (err) {
        return res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
    }
};

/**
 * Schedule the watchlist for an immediate run.
 *
 * We don't execute synchronously here — a full keyword sweep can take
 * 20-60s and an HTTP request blocking that long is fragile (proxies time
 * out, browsers retry, load balancers reset). Instead we set
 * `next_run_at = now` and return 202; the watchlist cron worker
 * (linkedinWatchlistRunnerWorker) picks it up on the next tick (5 min).
 *
 * The operator UI polls watchlist detail to surface last_run_at +
 * last_run_summary once the worker writes them back.
 */
export const runNow = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const id = String(req.params.id);
        const existing = await prisma.signalWatchlist.findFirst({
            where: { id, organization_id: orgId },
            select: { id: true, enabled: true, last_run_at: true, next_run_at: true },
        });
        if (!existing) return res.status(404).json({ success: false, error: 'Watchlist not found' });
        if (!existing.enabled) {
            return res.status(400).json({ success: false, error: 'Watchlist is disabled — enable it before triggering a run' });
        }

        await prisma.signalWatchlist.update({
            where: { id },
            data: { next_run_at: new Date() },
        });

        return res.status(202).json({
            success: true,
            data: {
                status: 'queued',
                queued_at: new Date().toISOString(),
                last_run_at: existing.last_run_at ?? null,
                message: 'Scan queued. The watchlist runner will pick it up within ~5 minutes; refresh to see last_run_at update.',
            },
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
    }
};

export const listMatches = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const id = String(req.params.id);
        const status = req.query.status ? String(req.query.status) : undefined;
        const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit ?? '50')) || 50));

        const where: { watchlist_id: string; organization_id: string; status?: string } = {
            watchlist_id: id, organization_id: orgId,
        };
        if (status) where.status = status;

        const rows = await prisma.signalWatchlistMatch.findMany({
            where,
            orderBy: { created_at: 'desc' },
            take: limit,
            include: {
                /* eslint-disable @typescript-eslint/no-explicit-any */
            } as any,
        });

        // Attach engager profile data so the UI doesn't need a second call.
        const profileIds: string[] = Array.from(new Set(rows.map((r: { engager_profile_id: string }) => r.engager_profile_id))) as string[];
        const profiles = profileIds.length > 0
            ? await prisma.linkedInProfile.findMany({
                where: { id: { in: profileIds } },
                select: { id: true, name: true, public_identifier: true, headline: true, company: true, position: true, location: true, icp_match_score: true, lead_id: true },
            })
            : [];
        const byId = new Map(profiles.map(p => [p.id, p]));

        return res.json({
            success: true,
            data: rows.map((r: { engager_profile_id: string }) => ({ ...r, engager: byId.get(r.engager_profile_id) ?? null })),
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
    }
};

export const pushMatch = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const id = String(req.params.id);
        const matchId = String(req.params.matchId);
        const body = req.body as { campaign_id?: string };

        const match = await prisma.signalWatchlistMatch.findFirst({
            where: { id: matchId, watchlist_id: id, organization_id: orgId },
        }) as { id: string; status: string; engager_profile_id: string } | null;
        if (!match) return res.status(404).json({ success: false, error: 'Match not found' });
        if (match.status === 'pushed') {
            return res.status(400).json({ success: false, error: 'Match already pushed' });
        }

        const campaignId = body.campaign_id || (await prisma.signalWatchlist.findUnique({
            where: { id }, select: { target_campaign_id: true },
        }))?.target_campaign_id;
        if (!campaignId) {
            return res.status(400).json({ success: false, error: 'campaign_id is required (watchlist has no default target campaign)' });
        }
        const campaign = await prisma.campaign.findFirst({
            where: { id: campaignId, organization_id: orgId, channel: 'linkedin' },
            select: { id: true },
        });
        if (!campaign) return res.status(400).json({ success: false, error: 'campaign must be a LinkedIn campaign in this org' });

        const profile = await prisma.linkedInProfile.findUnique({
            where: { id: match.engager_profile_id },
        });
        if (!profile) return res.status(404).json({ success: false, error: 'Engager profile no longer exists' });

        // Route through the same supervisor-equivalent promotion flow
        // the auto-push path uses. Operators clicking "push to campaign"
        // get the same enrichment + routing + audit benefits.
        const { promoteProfileToCampaign } = await import('../services/linkedin/profilePromotionService');
        const result = await promoteProfileToCampaign({
            organizationId: orgId,
            profileId: profile.id,
            campaignId,
            coldCallListId: null,
            engagementEventId: null,
            trigger: 'manual_push',
            triggerRefId: matchId,
        });

        await prisma.signalWatchlistMatch.update({
            where: { id: matchId },
            data: {
                status: 'pushed',
                pushed_campaign_id: campaignId,
                pushed_at: new Date(),
                reviewed_at: new Date(),
                reviewed_by_user_id: req.orgContext?.userId ?? null,
            },
        });
        return res.json({
            success: true,
            data: {
                lead_id: result.lead_id,
                icebreaker_status: result.icebreaker_status,
                routed: result.routed,
                warnings: result.warnings,
            },
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
    }
};

export const skipMatch = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const id = String(req.params.id);
        const matchId = String(req.params.matchId);

        const match = await prisma.signalWatchlistMatch.findFirst({
            where: { id: matchId, watchlist_id: id, organization_id: orgId }, select: { id: true },
        });
        if (!match) return res.status(404).json({ success: false, error: 'Match not found' });

        await prisma.signalWatchlistMatch.update({
            where: { id: matchId },
            data: { status: 'manual_skipped', reviewed_at: new Date() },
        });
        return res.json({ success: true });
    } catch (err) {
        return res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
    }
};

// ── helpers ──────────────────────────────────────────────────────────

function clampStrArr(v: unknown, max: number): string[] {
    if (!Array.isArray(v)) return [];
    return v.map(x => String(x).trim()).filter(Boolean).slice(0, max);
}

function clampInt(v: unknown, lo: number, hi: number, fallback: number): number {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(lo, Math.min(hi, Math.round(n)));
}
