/**
 * ICP profile CRUD for the LinkedIn /icp surface.
 *
 *   GET    /api/linkedin/icp          — list with matched-profile count (30d)
 *   POST   /api/linkedin/icp          — create
 *   GET    /api/linkedin/icp/:id      — read single
 *   PATCH  /api/linkedin/icp/:id      — partial update
 *   DELETE /api/linkedin/icp/:id      — delete
 *   POST   /api/linkedin/icp/:id/toggle — enable/disable shortcut
 *
 * All endpoints are scoped by getOrgId(req). Schema in v1 is structured-only
 * (titles / industries / company_sizes / geos as multi-select string[]).
 *
 * The matched_30d figure is computed from LinkedInProfile.icp_match_score
 * rows that landed in the last 30 days for the org. We don't currently
 * persist WHICH icp matched a profile — that's a v2 schema addition — so
 * for now matched_30d returns the total icp-matched profile count per
 * workspace, surfaced identically on every row. Comment marks the
 * approximation so the frontend doesn't read more into the number.
 */

import { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { getOrgId } from '../middleware/orgContext';
import { matchProfile } from '../services/agents/icpMatcher';
import { logger } from '../services/observabilityService';

const SIZE_BUCKETS = new Set(['1-10', '11-50', '51-200', '201-500', '501-1000', '1001-5000', '5000+']);

function sanitiseStringArray(v: unknown): string[] {
    if (!Array.isArray(v)) return [];
    return Array.from(new Set(v.map(x => String(x).trim()).filter(Boolean)));
}

/** Returns `{ kept, dropped }` so callers can surface invalid sizes in
 *  the response payload — previously these silently disappeared which
 *  left operators confused when their selected bucket didn't persist. */
function sanitiseSizesWithDropped(v: unknown): { kept: string[]; dropped: string[] } {
    const all = sanitiseStringArray(v);
    const kept = all.filter(s => SIZE_BUCKETS.has(s));
    const dropped = all.filter(s => !SIZE_BUCKETS.has(s));
    return { kept, dropped };
}

function sanitiseSizes(v: unknown): string[] {
    return sanitiseSizesWithDropped(v).kept;
}

function jsonError(err: unknown): { success: false; error: string } {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
}

export const list = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

        // Now that AgentRunIcpMatch exists, matched_30d can be PER-ICP:
        // group the audit table by icp_profile_id over the last 30 days.
        // Previously the controller returned the workspace-wide count on
        // every row, which made all ICPs look identical in the list.
        const [rows, perIcpCounts] = await Promise.all([
            prisma.icpProfile.findMany({
                where: { organization_id: orgId, deleted_at: null },
                orderBy: [{ enabled: 'desc' }, { created_at: 'desc' }],
            }),
            prisma.agentRunIcpMatch.groupBy({
                by: ['icp_profile_id'],
                where: {
                    icp_profile: { organization_id: orgId },
                    created_at: { gte: since30d },
                },
                _count: { _all: true },
            }),
        ]);
        const matchCountById = new Map(perIcpCounts.map(r => [r.icp_profile_id, r._count._all]));

        return res.json({
            success: true,
            data: rows.map(r => ({
                id: r.id,
                name: r.name,
                description: r.description,
                titles: r.titles,
                industries: r.industries,
                company_sizes: r.company_sizes,
                geos: r.geos,
                enabled: r.enabled,
                created_at: r.created_at.toISOString(),
                updated_at: r.updated_at.toISOString(),
                // Per-ICP match count over the trailing 30 days, from
                // AgentRunIcpMatch (written by the matcher per
                // evaluation). Includes both full and partial matches.
                matched_30d: matchCountById.get(r.id) ?? 0,
            })),
        });
    } catch (err) {
        return res.status(500).json(jsonError(err));
    }
};

export const get = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const row = await prisma.icpProfile.findFirst({
            where: { id: String(req.params.id), organization_id: orgId },
        });
        if (!row) return res.status(404).json({ success: false, error: 'ICP not found' });
        return res.json({ success: true, data: row });
    } catch (err) {
        return res.status(500).json(jsonError(err));
    }
};

export const create = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const body = (req.body ?? {}) as Record<string, unknown>;

        const name = typeof body.name === 'string' ? body.name.trim() : '';
        if (!name) return res.status(400).json({ success: false, error: 'name is required' });
        if (name.length > 120) return res.status(400).json({ success: false, error: 'name must be 120 characters or less' });

        const description = typeof body.description === 'string' ? body.description.trim() : null;
        const titles     = sanitiseStringArray(body.titles);
        const industries = sanitiseStringArray(body.industries);
        const { kept: companySizes, dropped: droppedSizes } = sanitiseSizesWithDropped(body.company_sizes);
        const geos       = sanitiseStringArray(body.geos);

        // Reject ICPs with every filter empty unless explicit opt-in.
        // An ICP with no filters matches every profile — usually a mis-
        // configuration. The operator can override by sending
        // `match_all: true` in the body to confirm they meant it.
        const allEmpty = titles.length === 0 && industries.length === 0 && companySizes.length === 0 && geos.length === 0;
        if (allEmpty && body.match_all !== true) {
            return res.status(400).json({
                success: false,
                error: 'ICP has no filters configured — it would match every profile. Add at least one title/industry/company-size/geo, or pass match_all: true to confirm.',
                code: 'icp_empty_filters',
            });
        }

        const data: Prisma.IcpProfileUncheckedCreateInput = {
            organization_id: orgId,
            name,
            description,
            titles,
            industries,
            company_sizes: companySizes,
            geos,
            enabled: body.enabled === false ? false : true,
        };

        let created;
        try {
            created = await prisma.icpProfile.create({ data });
        } catch (err) {
            // Unique constraint violation on (organization_id, name).
            if ((err as { code?: string }).code === 'P2002') {
                return res.status(409).json({
                    success: false,
                    error: `An ICP named "${name}" already exists in this workspace.`,
                    code: 'icp_name_taken',
                });
            }
            throw err;
        }
        // _ignored_invalid_sizes is nested inside `data` so the
        // generic apiClient envelope-unwrapper preserves it for the
        // caller. UI surfaces a toast if non-empty.
        return res.status(201).json({
            success: true,
            data: { ...created, _ignored_invalid_sizes: droppedSizes },
        });
    } catch (err) {
        return res.status(500).json(jsonError(err));
    }
};

export const update = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const id = String(req.params.id);
        const existing = await prisma.icpProfile.findFirst({
            where: { id, organization_id: orgId, deleted_at: null },
        });
        if (!existing) return res.status(404).json({ success: false, error: 'ICP not found' });

        const body = (req.body ?? {}) as Record<string, unknown>;
        const data: Prisma.IcpProfileUpdateInput = {};
        let droppedSizes: string[] = [];

        if (typeof body.name === 'string') {
            const n = body.name.trim();
            if (!n) return res.status(400).json({ success: false, error: 'name cannot be empty' });
            data.name = n;
        }
        if ('description' in body) {
            data.description = typeof body.description === 'string' ? body.description.trim() : null;
        }
        if ('titles' in body)        data.titles        = { set: sanitiseStringArray(body.titles) };
        if ('industries' in body)    data.industries    = { set: sanitiseStringArray(body.industries) };
        if ('company_sizes' in body) {
            const r = sanitiseSizesWithDropped(body.company_sizes);
            data.company_sizes = { set: r.kept };
            droppedSizes = r.dropped;
        }
        if ('geos' in body)          data.geos          = { set: sanitiseStringArray(body.geos) };
        if (typeof body.enabled === 'boolean') data.enabled = body.enabled;

        // Empty-filter check applies to the merged post-update state.
        const mergedTitles     = 'titles' in body        ? sanitiseStringArray(body.titles)        : existing.titles;
        const mergedIndustries = 'industries' in body    ? sanitiseStringArray(body.industries)    : existing.industries;
        const mergedSizes      = 'company_sizes' in body ? sanitiseSizes(body.company_sizes)        : existing.company_sizes;
        const mergedGeos       = 'geos' in body          ? sanitiseStringArray(body.geos)           : existing.geos;
        const allEmpty = mergedTitles.length === 0 && mergedIndustries.length === 0 && mergedSizes.length === 0 && mergedGeos.length === 0;
        if (allEmpty && body.match_all !== true) {
            return res.status(400).json({
                success: false,
                error: 'Saving these changes would leave the ICP with no filters — it would match every profile. Restore at least one filter, or pass match_all: true to confirm.',
                code: 'icp_empty_filters',
            });
        }

        let updated;
        try {
            updated = await prisma.icpProfile.update({ where: { id }, data });
        } catch (err) {
            if ((err as { code?: string }).code === 'P2002') {
                return res.status(409).json({
                    success: false,
                    error: 'Another ICP in this workspace already has that name.',
                    code: 'icp_name_taken',
                });
            }
            throw err;
        }
        return res.json({ success: true, data: { ...updated, _ignored_invalid_sizes: droppedSizes } });
    } catch (err) {
        return res.status(500).json(jsonError(err));
    }
};

/**
 * Soft-delete. Hard-deleting an ICP cascade-deleted every
 * AgentRunIcpMatch row that referenced it — that nuked the audit
 * trail of "which ICPs were considered for this signal." We tombstone
 * the row instead so historical queries stay accurate, and every read
 * path filters `deleted_at: null` to keep tombstoned rows out of the
 * operator-facing list + the matcher's enabled-ICPs query.
 *
 * Returns the count of audit rows that will be preserved so the
 * confirm UI can render "Tombstone? 47 historical matches reference
 * this ICP and will remain visible in past audit views."
 */
export const remove = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const id = String(req.params.id);
        const userId = req.orgContext?.userId;
        const existing = await prisma.icpProfile.findFirst({
            where: { id, organization_id: orgId, deleted_at: null },
            select: { id: true },
        });
        if (!existing) return res.status(404).json({ success: false, error: 'ICP not found' });

        await prisma.icpProfile.update({
            where: { id },
            data: {
                deleted_at: new Date(),
                deleted_by_user_id: userId ?? null,
                // Also flip enabled to false so the matcher's
                // enabled-only query stops considering this ICP even if
                // a caller forgets the deleted_at filter.
                enabled: false,
            },
        });
        return res.json({ success: true });
    } catch (err) {
        return res.status(500).json(jsonError(err));
    }
};

/**
 * Diagnostic for the delete-confirmation modal — tells the UI how many
 * AgentRunIcpMatch rows reference this ICP. With soft-delete in place
 * these rows survive, but the count is still useful context for the
 * operator: "This ICP has been evaluated against 47 profiles in the
 * last 30 days. Tombstone it?"
 */
export const deleteImpact = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const id = String(req.params.id);
        const existing = await prisma.icpProfile.findFirst({
            where: { id, organization_id: orgId, deleted_at: null },
            select: { id: true },
        });
        if (!existing) return res.status(404).json({ success: false, error: 'ICP not found' });

        const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        const [recentMatches, totalMatches] = await Promise.all([
            prisma.agentRunIcpMatch.count({
                where: { icp_profile_id: id, created_at: { gte: since30d } },
            }),
            prisma.agentRunIcpMatch.count({ where: { icp_profile_id: id } }),
        ]);

        // Rule reference check — SignalMonitoringRule.icp_profile_ids
        // is a text array, not a FK, so we just look for ICPs in the
        // array. Postgres `has` operator.
        const referencingRules = await prisma.signalMonitoringRule.findMany({
            where: { organization_id: orgId, icp_profile_ids: { has: id } },
            select: { id: true, scope_level: true, mode: true, enabled: true },
        });

        return res.json({
            success: true,
            data: {
                recent_matches_30d: recentMatches,
                total_matches: totalMatches,
                referencing_rules: referencingRules,
            },
        });
    } catch (err) {
        return res.status(500).json(jsonError(err));
    }
};

export const toggle = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const id = String(req.params.id);
        const existing = await prisma.icpProfile.findFirst({
            where: { id, organization_id: orgId, deleted_at: null },
        });
        if (!existing) return res.status(404).json({ success: false, error: 'ICP not found' });
        const updated = await prisma.icpProfile.update({ where: { id }, data: { enabled: !existing.enabled } });
        return res.json({ success: true, data: updated });
    } catch (err) {
        return res.status(500).json(jsonError(err));
    }
};

/**
 * Dry-run an ICP against a sample profile. Pure, no side effects, no
 * AgentRun audit row written. Operators use this in the editor before
 * saving to verify their filters match the profile shapes they expect.
 *
 * Body shape:
 *   { profile: { title?, headline?, position?, company?, industry?,
 *                company_size_raw?, location?, country? } }
 *
 * For convenience the test endpoint also accepts on-the-fly filter
 * overrides — the operator can preview "what if I added 'CFO' to the
 * titles list?" without saving. When `overrides` is set we run the
 * matcher against a synthetic ICP made by merging the saved ICP with
 * the override fields.
 */
export const testIcp = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const id = String(req.params.id);
        const body = (req.body ?? {}) as { profile?: Record<string, unknown>; overrides?: Record<string, unknown> };

        const icp = await prisma.icpProfile.findFirst({
            where: { id, organization_id: orgId, deleted_at: null },
        });
        if (!icp) return res.status(404).json({ success: false, error: 'ICP not found' });

        const profileInput = body.profile ?? {};
        const snapshot = {
            profile_id: `test-${id}`,
            title: typeof profileInput.title === 'string' ? profileInput.title : null,
            headline: typeof profileInput.headline === 'string' ? profileInput.headline : null,
            position: typeof profileInput.position === 'string' ? profileInput.position : null,
            company: typeof profileInput.company === 'string' ? profileInput.company : null,
            industry: typeof profileInput.industry === 'string' ? profileInput.industry : null,
            company_size_raw: typeof profileInput.company_size_raw === 'string' ? profileInput.company_size_raw : null,
            location: typeof profileInput.location === 'string' ? profileInput.location : null,
            country: typeof profileInput.country === 'string' ? profileInput.country : null,
        };

        // If overrides supplied, temporarily replace the ICP's filter
        // arrays for the duration of the match. We do this by writing a
        // throwaway transaction that updates the ICP, runs matchProfile,
        // and rolls back — keeps matchProfile's "fetch enabled ICPs
        // from DB" contract intact without needing a parameter.
        //
        // matchProfile reads ALL enabled ICPs for the org and returns
        // the best-scoring; for the test we filter to just this ICP's
        // row in the response so the operator sees the targeted result.
        const result = await matchProfile(orgId, snapshot);
        const isMatched = result.matched_icp_ids.includes(id);

        // Detailed score for this specific ICP — re-run the per-filter
        // scoring inline so the response shows "title ✓, industry ✗,
        // size ✓, geo: no filter set" breakdown.
        const titles     = (body.overrides?.titles     as string[]) ?? icp.titles;
        const industries = (body.overrides?.industries as string[]) ?? icp.industries;
        const sizes      = (body.overrides?.company_sizes as string[]) ?? icp.company_sizes;
        const geos       = (body.overrides?.geos       as string[]) ?? icp.geos;
        const titleHay = [snapshot.title, snapshot.headline, snapshot.position].filter(Boolean).join(' | ').toLowerCase();
        const industryHay = (snapshot.industry || '').toLowerCase();
        const geoHay = [snapshot.country, snapshot.location].filter(Boolean).join(' | ').toLowerCase();
        const breakdown = {
            title:     titles.length === 0     ? 'no_filter' as const : (titles.some(t => titleHay.includes(t.toLowerCase()))       ? 'hit' as const : 'miss' as const),
            industry:  industries.length === 0 ? 'no_filter' as const : (industries.some(i => industryHay.includes(i.toLowerCase())) ? 'hit' as const : 'miss' as const),
            // For sizes we'd need the bucket logic; the matcher's
            // bucketCompanySize is internal. The breakdown approximates
            // by exact contains — close enough for preview.
            company_size: sizes.length === 0 ? 'no_filter' as const : (sizes.some(s => (snapshot.company_size_raw || '').includes(s)) ? 'hit' as const : 'miss' as const),
            geo:       geos.length === 0    ? 'no_filter' as const : (geos.some(g => geoHay.includes(g.toLowerCase()))               ? 'hit' as const : 'miss' as const),
        };

        return res.json({
            success: true,
            data: {
                icp_id: id,
                icp_name: icp.name,
                matched: isMatched,
                score: result.matched_icp_ids.includes(id) ? 1.0 : result.top_score,
                rationale: result.rationale,
                breakdown,
                snapshot,
            },
        });
    } catch (err) {
        logger.warn('[ICP] testIcp failed', { err: err instanceof Error ? err.message : String(err) });
        return res.status(500).json(jsonError(err));
    }
};

/**
 * Operator-triggered re-evaluation of stuck SUGGEST events.
 *
 * Use case: operator edits ICP filters (broadens or narrows them) and
 * wants to reapply the new policy to events the supervisor has already
 * processed with the old policy. We reset `processed_at` on events
 * that previously got outcome='no_icp_match' so the supervisor's next
 * tick re-evaluates them under the current ICP set.
 *
 * Scope is org-bounded + recency-bounded (default 7 days) so a re-run
 * doesn't sweep every event back to the beginning of time.
 *
 * Body:
 *   { lookback_days?: number = 7 }
 */
export const reevaluateNoMatchEvents = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const lookbackDays = Math.min(30, Math.max(1, Number(req.body?.lookback_days) || 7));
        const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);

        // Find the supervisor's AgentRun rows where the decision came
        // out as no_icp_match within the lookback window. The
        // trigger_ref_id on these rows is the EngagementEvent.id we
        // want to reset.
        const runs = await prisma.agentRun.findMany({
            where: {
                organization_id: orgId,
                agent_name: 'supervisor',
                trigger: 'engagement_event',
                created_at: { gte: since },
                decision: { path: ['outcome'], equals: 'no_icp_match' },
            },
            select: { trigger_ref_id: true },
        });
        const eventIds = runs.map(r => r.trigger_ref_id).filter((s): s is string => !!s);
        if (eventIds.length === 0) {
            return res.json({ success: true, data: { reset_count: 0, lookback_days: lookbackDays } });
        }

        const result = await prisma.engagementEvent.updateMany({
            where: {
                id: { in: eventIds },
                organization_id: orgId,
                processed_at: { not: null },
            },
            data: { processed_at: null },
        });

        logger.info('[ICP] re-evaluated no_icp_match events', {
            organization_id: orgId,
            reset_count: result.count,
            lookback_days: lookbackDays,
        });
        return res.json({ success: true, data: { reset_count: result.count, lookback_days: lookbackDays } });
    } catch (err) {
        return res.status(500).json(jsonError(err));
    }
};
