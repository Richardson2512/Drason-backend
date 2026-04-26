/**
 * Cold Call List controller
 *
 * Endpoints for both list types and the workspace-scoped settings.
 *
 *   GET    /api/cold-call-list/system               → today's auto-generated list
 *   GET    /api/cold-call-list/system/csv           → CSV download of today's list
 *   GET    /api/cold-call-list/settings             → custom-list rules
 *   PATCH  /api/cold-call-list/settings             → update custom-list rules
 *   POST   /api/cold-call-list/custom/generate      → run custom rules now
 *   POST   /api/cold-call-list/custom/csv           → run + persist + CSV download
 *   GET    /api/cold-call-list/active-campaigns     → for the campaign-filter UI
 */

import { Request, Response } from 'express';
import { prisma } from '../index';
import { logger } from '../services/observabilityService';
import { getOrgId } from '../middleware/orgContext';
import {
    DEFAULT_CUSTOM_RULES,
    SYSTEM_LIST_RULES,
    ListRules,
    ProspectRow,
    generateProspectList,
    hydrateDailySnapshot,
    workspaceLocalDate,
    getWorkspaceTimezone,
    generateDailySnapshot,
} from '../services/coldCallListService';

// ─── Settings ────────────────────────────────────────────────────────────────

function settingsToRules(s: {
    min_opens: number;
    time_window_days: number;
    require_click: boolean;
    require_no_reply: boolean;
    exclude_recent_days: number;
    title_filter: string | null;
    campaign_filter: unknown;
    max_list_size: number;
}): ListRules {
    return {
        minOpens: s.min_opens,
        timeWindowDays: s.time_window_days,
        requireClick: s.require_click,
        requireNoReply: s.require_no_reply,
        excludeRecentDays: s.exclude_recent_days,
        titleFilter: s.title_filter,
        campaignFilter: Array.isArray(s.campaign_filter) ? (s.campaign_filter as string[]) : null,
        maxListSize: s.max_list_size,
    };
}

async function loadOrCreateSettings(orgId: string) {
    const existing = await prisma.coldCallListSettings.findUnique({ where: { organization_id: orgId } });
    if (existing) return existing;
    return prisma.coldCallListSettings.create({
        data: {
            organization_id: orgId,
            min_opens: DEFAULT_CUSTOM_RULES.minOpens,
            time_window_days: DEFAULT_CUSTOM_RULES.timeWindowDays,
            require_click: DEFAULT_CUSTOM_RULES.requireClick,
            require_no_reply: DEFAULT_CUSTOM_RULES.requireNoReply,
            exclude_recent_days: DEFAULT_CUSTOM_RULES.excludeRecentDays,
            title_filter: DEFAULT_CUSTOM_RULES.titleFilter,
            campaign_filter: DEFAULT_CUSTOM_RULES.campaignFilter ?? undefined,
            max_list_size: DEFAULT_CUSTOM_RULES.maxListSize,
        },
    });
}

export const getSettings = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const settings = await loadOrCreateSettings(orgId);
        return res.json({ success: true, settings });
    } catch (err) {
        logger.error('[COLD-CALL] getSettings failed', err instanceof Error ? err : new Error(String(err)));
        return res.status(500).json({ success: false, error: 'Failed to load settings' });
    }
};

export const updateSettings = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        await loadOrCreateSettings(orgId);
        const body = req.body ?? {};

        // Validate ranges per spec.
        const minOpens = clamp(toInt(body.min_opens, DEFAULT_CUSTOM_RULES.minOpens), 0, 100);
        const timeWindowDays = [1, 2, 7, 14, 30].includes(toInt(body.time_window_days, DEFAULT_CUSTOM_RULES.timeWindowDays))
            ? toInt(body.time_window_days, DEFAULT_CUSTOM_RULES.timeWindowDays)
            : DEFAULT_CUSTOM_RULES.timeWindowDays;
        const excludeRecentDays = clamp(toInt(body.exclude_recent_days, DEFAULT_CUSTOM_RULES.excludeRecentDays), 0, 90);
        const maxListSize = clamp(toInt(body.max_list_size, DEFAULT_CUSTOM_RULES.maxListSize), 10, 1000);
        const titleFilter = typeof body.title_filter === 'string' ? body.title_filter.trim().slice(0, 500) || null : null;

        let campaignFilter: string[] | null = null;
        if (Array.isArray(body.campaign_filter)) {
            const ids = body.campaign_filter.filter((s: unknown) => typeof s === 'string') as string[];
            campaignFilter = ids.length > 0 ? ids : null;
        }

        const updated = await prisma.coldCallListSettings.update({
            where: { organization_id: orgId },
            data: {
                min_opens: minOpens,
                time_window_days: timeWindowDays,
                require_click: !!body.require_click,
                require_no_reply: body.require_no_reply !== false,
                exclude_recent_days: excludeRecentDays,
                title_filter: titleFilter,
                campaign_filter: campaignFilter ?? undefined,
                max_list_size: maxListSize,
            },
        });
        return res.json({ success: true, settings: updated });
    } catch (err) {
        logger.error('[COLD-CALL] updateSettings failed', err instanceof Error ? err : new Error(String(err)));
        return res.status(500).json({ success: false, error: 'Failed to save settings' });
    }
};

// ─── Active campaigns (for filter UI) ────────────────────────────────────────

export const listActiveCampaigns = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const campaigns = await prisma.campaign.findMany({
            where: { organization_id: orgId, status: 'active' },
            select: { id: true, name: true },
            orderBy: { created_at: 'desc' },
        });
        return res.json({ success: true, campaigns });
    } catch (err) {
        logger.error('[COLD-CALL] listActiveCampaigns failed', err instanceof Error ? err : new Error(String(err)));
        return res.status(500).json({ success: false, error: 'Failed to load campaigns' });
    }
};

// ─── Daily system list ───────────────────────────────────────────────────────

export const getSystemList = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const tz = await getWorkspaceTimezone(orgId);
        const today = workspaceLocalDate(new Date(), tz);

        // If today's snapshot doesn't exist yet (e.g. cron hasn't fired or
        // workspace is in a tz where it's not 06:00 yet), return a placeholder
        // status so the UI can render the right empty state.
        const hydrated = await hydrateDailySnapshot(orgId, today);
        return res.json({
            success: true,
            snapshot_date: today.toISOString().slice(0, 10),
            timezone: tz,
            generated_at: hydrated.generatedAt,
            status: hydrated.status,
            error_message: hydrated.errorMessage,
            prospects: hydrated.prospects,
        });
    } catch (err) {
        logger.error('[COLD-CALL] getSystemList failed', err instanceof Error ? err : new Error(String(err)));
        return res.status(500).json({ success: false, error: 'Failed to load system list' });
    }
};

export const downloadSystemListCsv = async (req: Request, res: Response): Promise<Response | void> => {
    try {
        const orgId = getOrgId(req);
        const tz = await getWorkspaceTimezone(orgId);
        const today = workspaceLocalDate(new Date(), tz);
        const hydrated = await hydrateDailySnapshot(orgId, today);
        const dateStr = today.toISOString().slice(0, 10);
        const csv = buildCsv(hydrated.prospects, 'system_daily');
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="superkabe-daily-call-list-${dateStr}.csv"`);
        return res.send(csv);
    } catch (err) {
        logger.error('[COLD-CALL] downloadSystemListCsv failed', err instanceof Error ? err : new Error(String(err)));
        return res.status(500).json({ success: false, error: 'Failed to download CSV' });
    }
};

// ─── Custom list ─────────────────────────────────────────────────────────────

async function buildCustomExclusionSet(orgId: string, excludeRecentDays: number): Promise<Set<string>> {
    if (excludeRecentDays <= 0) return new Set();
    const since = new Date(Date.now() - excludeRecentDays * 86_400_000);
    const recent = await prisma.coldCallCustomSnapshot.findMany({
        where: { organization_id: orgId, downloaded_at: { gte: since } },
        select: { prospect_ids: true },
    });
    const set = new Set<string>();
    for (const r of recent) {
        if (Array.isArray(r.prospect_ids)) for (const id of r.prospect_ids as string[]) set.add(id);
    }
    return set;
}

export const generateCustomList = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const settings = await loadOrCreateSettings(orgId);
        const rules = settingsToRules(settings);
        const exclude = await buildCustomExclusionSet(orgId, rules.excludeRecentDays);
        const prospects = await generateProspectList({ organizationId: orgId, rules, excludeCampaignLeadIds: exclude });
        return res.json({ success: true, prospects, generated_at: new Date().toISOString() });
    } catch (err) {
        logger.error('[COLD-CALL] generateCustomList failed', err instanceof Error ? err : new Error(String(err)));
        return res.status(500).json({ success: false, error: 'Failed to generate custom list' });
    }
};

export const downloadCustomListCsv = async (req: Request, res: Response): Promise<Response | void> => {
    try {
        const orgId = getOrgId(req);
        const settings = await loadOrCreateSettings(orgId);
        const rules = settingsToRules(settings);
        const exclude = await buildCustomExclusionSet(orgId, rules.excludeRecentDays);
        const prospects = await generateProspectList({ organizationId: orgId, rules, excludeCampaignLeadIds: exclude });

        // Persist a custom snapshot so subsequent runs can dedup the user's
        // prior downloads (separate from system-list snapshots — a prospect
        // can appear on both list types independently).
        await prisma.coldCallCustomSnapshot.create({
            data: {
                organization_id: orgId,
                user_id: (req as Request & { orgContext?: { userId?: string } }).orgContext?.userId ?? null,
                prospect_ids: prospects.map((p) => p.campaign_lead_id),
                prospect_count: prospects.length,
                rule_snapshot: JSON.parse(JSON.stringify(rules)),
            },
        });

        const stamp = csvTimestamp(new Date());
        const csv = buildCsv(prospects, 'custom');
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="superkabe-custom-call-list-${stamp}.csv"`);
        return res.send(csv);
    } catch (err) {
        logger.error('[COLD-CALL] downloadCustomListCsv failed', err instanceof Error ? err : new Error(String(err)));
        return res.status(500).json({ success: false, error: 'Failed to download CSV' });
    }
};

// ─── Manual cron trigger (admin only) ────────────────────────────────────────
//
// Spec is explicit that users cannot regenerate the system list (it's "today's
// official list"). This endpoint exists for ops/staging seeding and is gated
// to admin-only callers; surfaced separately so the regular UI can't reach it.

export const triggerDailyForOrg = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const result = await generateDailySnapshot(orgId);
        return res.json({ success: true, ...result });
    } catch (err) {
        logger.error('[COLD-CALL] triggerDailyForOrg failed', err instanceof Error ? err : new Error(String(err)));
        return res.status(500).json({ success: false, error: 'Failed to trigger daily snapshot' });
    }
};

// ─── CSV builder ─────────────────────────────────────────────────────────────

const CSV_HEADERS = [
    'name',
    'email',
    'phone',
    'linkedin_url',
    'company',
    'title',
    'engagement_score',
    'total_opens',
    'total_clicks',
    'last_open_at',
    'last_click_at',
    'last_activity_at',
    'reply_status',
    'bounced',
    'unsubscribed',
    'subjects_sent',
    'last_email_sent_at',
    'reason_on_list',
    'campaign_name',
    'list_source',
];

function csvEscape(v: unknown): string {
    if (v === null || v === undefined) return '';
    let s = String(v);
    if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
        s = `"${s.replace(/"/g, '""')}"`;
    }
    return s;
}

function buildCsv(prospects: ProspectRow[], source: 'system_daily' | 'custom'): string {
    const lines = [CSV_HEADERS.join(',')];
    for (const p of prospects) {
        lines.push(
            [
                csvEscape(p.full_name ?? ''),
                csvEscape(p.email),
                csvEscape(p.phone ?? ''),
                csvEscape(p.linkedin_url ?? ''),
                csvEscape(p.company ?? ''),
                csvEscape(p.title ?? ''),
                csvEscape(p.score),
                csvEscape(p.total_opens),
                csvEscape(p.total_clicks),
                csvEscape(p.last_open_at ? p.last_open_at.toISOString() : ''),
                csvEscape(p.last_click_at ? p.last_click_at.toISOString() : ''),
                csvEscape(p.last_activity_at ? p.last_activity_at.toISOString() : ''),
                csvEscape(p.reply_status),
                csvEscape(p.bounced ? 'yes' : 'no'),
                csvEscape(p.unsubscribed ? 'yes' : 'no'),
                csvEscape(p.subjects_sent.join('; ')),
                csvEscape(p.last_email_sent_at ? p.last_email_sent_at.toISOString() : ''),
                csvEscape(p.reason),
                csvEscape(p.campaign_name),
                csvEscape(source),
            ].join(','),
        );
    }
    return lines.join('\n');
}

function csvTimestamp(d: Date): string {
    const pad = (n: number) => n.toString().padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function toInt(v: unknown, fallback: number): number {
    const n = typeof v === 'number' ? v : parseInt(String(v ?? ''), 10);
    return Number.isFinite(n) ? n : fallback;
}
function clamp(v: number, lo: number, hi: number): number {
    return Math.max(lo, Math.min(hi, v));
}

// Re-export for completeness (used by the worker).
export { SYSTEM_LIST_RULES };
