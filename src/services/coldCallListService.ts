/**
 * Cold Call List service
 *
 * Surfaces high-intent prospects for SDR outreach. Two modes share a single
 * scoring engine:
 *
 *   1. Daily System List — cron-generated at 06:00 workspace-local time with
 *      hard-coded rules. Top 100, fresh-list rotation via 5-day exclusion.
 *   2. Custom List       — workspace-configured rules generated on demand,
 *      capped by the user's max_list_size (default 200, range 10–1000).
 *
 * Driven by EmailOpenEvent / EmailClickEvent — opens and clicks captured by
 * the native sequencer's tracking pixel + click handler.
 *
 * Scoring weights live in a single place (computeScore) so both list types
 * stay consistent. The list-generation pipeline is also shared — only the
 * filter rules differ between system + custom.
 */

import { prisma } from '../index';
import { logger } from './observabilityService';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ListRules {
    minOpens: number;
    timeWindowDays: number;
    requireClick: boolean;
    requireNoReply: boolean;
    excludeRecentDays: number;
    titleFilter: string | null;
    campaignFilter: string[] | null;
    maxListSize: number;
}

export const SYSTEM_LIST_RULES: ListRules = {
    minOpens: 3,
    timeWindowDays: 7,
    requireClick: false, // OR-logic: a click alone qualifies (handled in scoring)
    requireNoReply: true,
    excludeRecentDays: 5,
    titleFilter: null,
    campaignFilter: null,
    maxListSize: 100,
};

export const DEFAULT_CUSTOM_RULES: ListRules = {
    minOpens: 3,
    timeWindowDays: 7,
    requireClick: false,
    requireNoReply: true,
    excludeRecentDays: 7,
    titleFilter: null,
    campaignFilter: null,
    maxListSize: 200,
};

export interface ProspectRow {
    campaign_lead_id: string;
    email: string;
    full_name: string | null;
    company: string | null;
    title: string | null;
    phone: string | null;
    linkedin_url: string | null;
    score: number;
    total_opens: number;
    total_clicks: number;
    last_open_at: Date | null;
    last_click_at: Date | null;
    last_activity_at: Date | null;
    reply_status: 'none' | 'replied';
    bounced: boolean;
    unsubscribed: boolean;
    campaign_id: string;
    campaign_name: string;
    last_email_sent_at: Date | null;
    subjects_sent: string[];
    reason: string;
}

// ─── Scoring ─────────────────────────────────────────────────────────────────

interface OpenSignal {
    opened_at: Date;
    ms_since_send: number | null;
}
interface ClickSignal {
    clicked_at: Date;
}

/**
 * Per-prospect engagement score. Inputs are pre-filtered open + click events
 * within the rules' time window. Cap final score at 100.
 *
 * Weights (per spec):
 *   - Each open: +1, capped at 5 points total to prevent MPP/scanner inflation
 *   - Each unique click: +5 (no cap — clicks are high-intent)
 *   - 1-hour window with multiple opens: +2 bonus (suggests human re-reading)
 *   - Recency multiplier: ≤24h → 1.5x, ≤48h → 1.25x, beyond → 1x
 *   - MPP/scanner: opens within 30s of send → 0.25x weight
 *   - Dedup: opens within a 5s window from same prospect → keep first only
 */
export function computeScore(opens: OpenSignal[], clicks: ClickSignal[]): number {
    if (opens.length === 0 && clicks.length === 0) return 0;

    const sorted = [...opens].sort((a, b) => a.opened_at.getTime() - b.opened_at.getTime());

    // 1) Dedup opens within 5s windows (scanner re-fetches).
    const deduped: OpenSignal[] = [];
    for (const ev of sorted) {
        const last = deduped[deduped.length - 1];
        if (!last || ev.opened_at.getTime() - last.opened_at.getTime() > 5_000) {
            deduped.push(ev);
        }
    }

    // 2) Per-event open contribution (with MPP weight + recency multiplier),
    //    then cap the *open* contribution at 5 points BEFORE click adds.
    const now = Date.now();
    let openContribution = 0;
    for (const ev of deduped) {
        const ageMs = now - ev.opened_at.getTime();
        const recencyMult = ageMs <= 86_400_000 ? 1.5 : ageMs <= 172_800_000 ? 1.25 : 1;
        const mppWeight = ev.ms_since_send !== null && ev.ms_since_send <= 30_000 ? 0.25 : 1;
        openContribution += 1 * mppWeight * recencyMult;
    }
    openContribution = Math.min(openContribution, 5);

    // 3) 1-hour-window bonus: any pair of opens within the same hour.
    let hourBonus = 0;
    for (let i = 1; i < deduped.length; i++) {
        if (deduped[i].opened_at.getTime() - deduped[i - 1].opened_at.getTime() <= 3_600_000) {
            hourBonus = 2;
            break;
        }
    }

    // 4) Click contribution: +5 each, with recency multiplier.
    let clickContribution = 0;
    for (const c of clicks) {
        const ageMs = now - c.clicked_at.getTime();
        const recencyMult = ageMs <= 86_400_000 ? 1.5 : ageMs <= 172_800_000 ? 1.25 : 1;
        clickContribution += 5 * recencyMult;
    }

    return Math.round(Math.min(100, openContribution + hourBonus + clickContribution));
}

// ─── List generation ─────────────────────────────────────────────────────────

interface ScoringContext {
    organizationId: string;
    rules: ListRules;
    /** Excluded CampaignLead IDs (recent system-list snapshots, recent custom-list downloads, etc.) */
    excludeCampaignLeadIds: Set<string>;
}

interface AggregateRow {
    campaign_lead_id: string;
    campaign_id: string;
    email: string;
    title: string | null;
    company: string | null;
    first_name: string | null;
    last_name: string | null;
    replied_at: Date | null;
    bounced_at: Date | null;
    unsubscribed_at: Date | null;
    status: string;
    last_sent_at: Date | null;
    campaign_name: string;
}

/**
 * Run a list-generation pass and return ranked prospect rows.
 * Centralised so system + custom lists never drift.
 */
export async function generateProspectList(ctx: ScoringContext): Promise<ProspectRow[]> {
    const { organizationId, rules, excludeCampaignLeadIds } = ctx;
    const windowStart = new Date(Date.now() - rules.timeWindowDays * 86_400_000);
    // Click window matches spec: "1 link click in last 14 days" — but only
    // when the user *narrowed* their open window. We use max(timeWindow, 14)
    // so the system list's 7d open window doesn't accidentally hide a click
    // from day 8–14 that should still qualify.
    const clickWindowStart = new Date(Date.now() - Math.max(rules.timeWindowDays, 14) * 86_400_000);

    // Step 1: fetch sequencer campaigns in scope.
    const activeCampaigns = await prisma.campaign.findMany({
        where: {
            organization_id: organizationId,
                        status: 'active',
            ...(rules.campaignFilter && rules.campaignFilter.length > 0
                ? { id: { in: rules.campaignFilter } }
                : {}),
        },
        select: { id: true, name: true },
    });
    if (activeCampaigns.length === 0) return [];
    const campaignIds = activeCampaigns.map((c) => c.id);
    const campaignNameById = new Map(activeCampaigns.map((c) => [c.id, c.name]));

    // Step 2: pull all open + click events in window for those campaigns.
    // We pull broad and aggregate in JS — postgres GROUP BY would force us
    // to drop per-event timestamps needed for MPP filtering and 1h bonus.
    const [opens, clicks] = await Promise.all([
        prisma.emailOpenEvent.findMany({
            where: {
                organization_id: organizationId,
                campaign_id: { in: campaignIds },
                opened_at: { gte: windowStart },
            },
            select: { campaign_lead_id: true, opened_at: true, ms_since_send: true },
        }),
        prisma.emailClickEvent.findMany({
            where: {
                organization_id: organizationId,
                campaign_id: { in: campaignIds },
                clicked_at: { gte: clickWindowStart },
            },
            select: { campaign_lead_id: true, clicked_at: true },
        }),
    ]);

    // Step 3: bucket per campaign_lead_id and find candidates.
    const opensByLead = new Map<string, OpenSignal[]>();
    for (const o of opens) {
        const list = opensByLead.get(o.campaign_lead_id) ?? [];
        list.push({ opened_at: o.opened_at, ms_since_send: o.ms_since_send });
        opensByLead.set(o.campaign_lead_id, list);
    }
    const clicksByLead = new Map<string, ClickSignal[]>();
    for (const c of clicks) {
        const list = clicksByLead.get(c.campaign_lead_id) ?? [];
        list.push({ clicked_at: c.clicked_at });
        clicksByLead.set(c.campaign_lead_id, list);
    }

    const candidateIds = new Set<string>([...opensByLead.keys(), ...clicksByLead.keys()]);
    if (candidateIds.size === 0) return [];

    // Step 4: load CampaignLead + parent campaign metadata for each candidate.
    const campaignLeads = await prisma.campaignLead.findMany({
        where: {
            id: { in: Array.from(candidateIds) },
            campaign_id: { in: campaignIds },
        },
        select: {
            id: true,
            campaign_id: true,
            email: true,
            first_name: true,
            last_name: true,
            company: true,
            title: true,
            replied_at: true,
            bounced_at: true,
            unsubscribed_at: true,
            status: true,
            last_sent_at: true,
        },
    });

    // Step 5: build aggregate rows and apply filtering.
    const aggregates: AggregateRow[] = campaignLeads.map((cl) => ({
        campaign_lead_id: cl.id,
        campaign_id: cl.campaign_id,
        email: cl.email,
        first_name: cl.first_name,
        last_name: cl.last_name,
        company: cl.company,
        title: cl.title,
        replied_at: cl.replied_at,
        bounced_at: cl.bounced_at,
        unsubscribed_at: cl.unsubscribed_at,
        status: cl.status,
        last_sent_at: cl.last_sent_at,
        campaign_name: campaignNameById.get(cl.campaign_id) ?? '',
    }));

    const titleNeedles = rules.titleFilter
        ? rules.titleFilter
              .split(',')
              .map((s) => s.trim().toLowerCase())
              .filter(Boolean)
        : null;

    const filtered: { row: AggregateRow; opens: OpenSignal[]; clicks: ClickSignal[]; score: number }[] = [];
    for (const row of aggregates) {
        if (excludeCampaignLeadIds.has(row.campaign_lead_id)) continue;

        // Suppression — locked on, both lists.
        if (row.bounced_at !== null) continue;
        if (row.unsubscribed_at !== null) continue;
        if (row.status === 'bounced' || row.status === 'unsubscribed') continue;

        if (rules.requireNoReply && row.replied_at !== null) continue;

        const oList = opensByLead.get(row.campaign_lead_id) ?? [];
        const cList = clicksByLead.get(row.campaign_lead_id) ?? [];

        // Open / click qualification. Spec semantics:
        //   System list: ≥ minOpens opens in N days OR ≥1 click in 14 days.
        //   Custom list: ≥ minOpens opens AND (requireClick ? ≥1 click : true).
        // We collapse to: count distinct opens in window (pre-MPP-filter for
        // qualification — MPP is a *scoring* discount, not a hard cut), and
        // require_click is the only binary toggle.
        const opensInWindow = oList.length;
        const clicksInWindow = cList.length;
        const passesOpenThreshold = opensInWindow >= rules.minOpens;
        const passesClickGate = rules.requireClick ? clicksInWindow >= 1 : true;

        // System list semantics: requireClick=false BUT a single click alone
        // qualifies even when opens < minOpens. Express as: require BOTH
        // (opens-threshold) AND (click-gate) — except for the "1 click in 14d"
        // OR-fallback when neither gate is required.
        const passesQualification = rules.requireClick
            ? passesOpenThreshold && passesClickGate
            : passesOpenThreshold || clicksInWindow >= 1;

        if (!passesQualification) continue;

        if (titleNeedles && titleNeedles.length > 0) {
            const t = (row.title ?? '').toLowerCase();
            if (!titleNeedles.some((n) => t.includes(n))) continue;
        }

        filtered.push({
            row,
            opens: oList,
            clicks: cList,
            score: computeScore(oList, cList),
        });
    }

    // Step 6: rank by score desc, cap at maxListSize.
    filtered.sort((a, b) => b.score - a.score);
    const capped = filtered.slice(0, rules.maxListSize);

    if (capped.length === 0) return [];

    // Step 7: enrich with subjects-sent (for CSV) and Protection-Lead phone/linkedin.
    const cappedCampaignLeadIds = capped.map((x) => x.row.campaign_lead_id);
    const cappedEmails = Array.from(new Set(capped.map((x) => x.row.email)));

    // Subjects sent so far — last 5 unique step subjects per CampaignLead.
    const sendsForSubjects = await prisma.sendEvent.findMany({
        where: {
            organization_id: organizationId,
            campaign_id: { in: campaignIds },
            recipient_email: { in: cappedEmails },
        },
        orderBy: { sent_at: 'desc' },
        select: { recipient_email: true, campaign_id: true, sent_at: true },
        take: cappedEmails.length * 10,
    });
    const lastSentByKey = new Map<string, Date>();
    for (const s of sendsForSubjects) {
        const k = `${s.campaign_id}::${s.recipient_email.toLowerCase()}`;
        if (!lastSentByKey.has(k)) lastSentByKey.set(k, s.sent_at);
    }

    // Pull subject text from SequenceStep + CampaignLead.current_step.
    const stepRows = await prisma.sequenceStep.findMany({
        where: { campaign_id: { in: campaignIds } },
        select: { campaign_id: true, step_number: true, subject: true },
        orderBy: [{ campaign_id: 'asc' }, { step_number: 'asc' }],
    });
    const subjectsByCampaign = new Map<string, string[]>();
    for (const s of stepRows) {
        const arr = subjectsByCampaign.get(s.campaign_id) ?? [];
        arr.push(s.subject);
        subjectsByCampaign.set(s.campaign_id, arr);
    }

    // Pull Protection-layer Lead enrichment (phone, linkedin_url, full_name).
    const leadEnrich = await prisma.lead.findMany({
        where: { organization_id: organizationId, email: { in: cappedEmails } },
        select: { email: true, phone: true, linkedin_url: true, full_name: true, last_activity_at: true },
    });
    const enrichByEmail = new Map<string, (typeof leadEnrich)[number]>();
    for (const l of leadEnrich) enrichByEmail.set(l.email.toLowerCase(), l);

    return capped.map(({ row, opens: oList, clicks: cList, score }) => {
        const enrich = enrichByEmail.get(row.email.toLowerCase());
        const lastOpen = oList.length > 0 ? oList[oList.length - 1].opened_at : null;
        const lastClick = cList.length > 0 ? cList[cList.length - 1].clicked_at : null;
        const subjects = subjectsByCampaign.get(row.campaign_id) ?? [];
        const sentKey = `${row.campaign_id}::${row.email.toLowerCase()}`;
        const lastEmailSentAt = lastSentByKey.get(sentKey) ?? row.last_sent_at ?? null;

        const reason = describeReason(oList.length, cList.length, lastOpen, lastClick);

        return {
            campaign_lead_id: row.campaign_lead_id,
            email: row.email,
            full_name:
                enrich?.full_name ||
                [row.first_name, row.last_name].filter(Boolean).join(' ') ||
                null,
            company: row.company,
            title: row.title,
            phone: enrich?.phone ?? null,
            linkedin_url: enrich?.linkedin_url ?? null,
            score,
            total_opens: oList.length,
            total_clicks: cList.length,
            last_open_at: lastOpen,
            last_click_at: lastClick,
            last_activity_at: enrich?.last_activity_at ?? null,
            reply_status: row.replied_at ? 'replied' : 'none',
            bounced: row.bounced_at !== null,
            unsubscribed: row.unsubscribed_at !== null,
            campaign_id: row.campaign_id,
            campaign_name: row.campaign_name,
            last_email_sent_at: lastEmailSentAt,
            subjects_sent: subjects,
            reason,
        };
    });
}

// ─── Reason text for UI + CSV ────────────────────────────────────────────────

function describeReason(
    opens: number,
    clicks: number,
    lastOpen: Date | null,
    lastClick: Date | null,
): string {
    const lastSignal = [lastOpen, lastClick].filter(Boolean).sort((a, b) => b!.getTime() - a!.getTime())[0];
    const ageHours = lastSignal ? Math.round((Date.now() - lastSignal.getTime()) / 3_600_000) : null;
    const ageStr = ageHours === null ? '' : ageHours < 48 ? `${ageHours}h` : `${Math.round(ageHours / 24)}d`;
    if (clicks > 0 && opens > 0) {
        return `Opened ${opens}× and clicked ${clicks}× — last activity ${ageStr} ago`;
    }
    if (clicks > 0) {
        return `Clicked ${clicks} link${clicks === 1 ? '' : 's'} — last click ${ageStr} ago`;
    }
    return `Opened ${opens} time${opens === 1 ? '' : 's'} — last open ${ageStr} ago`;
}

// ─── Snapshot helpers ────────────────────────────────────────────────────────

/**
 * Resolve workspace timezone with UTC fallback. SequencerSettings is the
 * source of truth — falls back to UTC when the org has never opened the
 * Sequencer settings page.
 */
export async function getWorkspaceTimezone(organizationId: string): Promise<string> {
    const settings = await prisma.sequencerSettings.findUnique({
        where: { organization_id: organizationId },
        select: { default_timezone: true },
    });
    return settings?.default_timezone || 'UTC';
}

/**
 * Today's date in workspace local time, as a YYYY-MM-DD string. Used to
 * key ColdCallDailySnapshot rows. Never throws on bad timezone — falls back
 * to UTC silently and logs a warning.
 */
export function workspaceLocalDate(now: Date, timezone: string): Date {
    try {
        const fmt = new Intl.DateTimeFormat('en-CA', {
            timeZone: timezone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
        });
        const parts = fmt.format(now); // YYYY-MM-DD
        // Anchor at midnight UTC so the @db.Date column round-trips cleanly.
        return new Date(`${parts}T00:00:00.000Z`);
    } catch (err) {
        logger.warn('[COLD-CALL] Bad timezone, falling back to UTC', { timezone, error: (err as Error).message });
        const utc = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
        return new Date(`${utc}T00:00:00.000Z`);
    }
}

/**
 * Hour-of-day in the workspace's timezone for a given Date. Used by the cron
 * to decide "is it 06:00 here yet?".
 */
export function workspaceLocalHour(now: Date, timezone: string): number {
    try {
        const fmt = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', hour12: false });
        const parts = fmt.formatToParts(now);
        const hour = parts.find((p) => p.type === 'hour')?.value;
        return hour ? parseInt(hour, 10) : 0;
    } catch {
        return now.getUTCHours();
    }
}

/**
 * Generate today's system list snapshot for one organization. Idempotent —
 * does nothing if today's row already exists. Returns the persisted snapshot
 * so the caller can log status.
 */
export async function generateDailySnapshot(organizationId: string): Promise<{
    skipped: boolean;
    status: 'success' | 'no_campaigns' | 'no_engagement' | 'error';
    prospectCount: number;
}> {
    const tz = await getWorkspaceTimezone(organizationId);
    const todayLocal = workspaceLocalDate(new Date(), tz);

    const existing = await prisma.coldCallDailySnapshot.findUnique({
        where: { organization_id_snapshot_date: { organization_id: organizationId, snapshot_date: todayLocal } },
    });
    if (existing) return { skipped: true, status: existing.status as 'success' | 'no_campaigns' | 'no_engagement' | 'error', prospectCount: existing.prospect_count };

    // Build exclusion set: any prospect on this org's last 5 days of system snapshots.
    const recentSince = new Date(todayLocal);
    recentSince.setUTCDate(recentSince.getUTCDate() - SYSTEM_LIST_RULES.excludeRecentDays);
    const recentSnapshots = await prisma.coldCallDailySnapshot.findMany({
        where: { organization_id: organizationId, snapshot_date: { gte: recentSince, lt: todayLocal } },
        select: { prospect_ids: true },
    });
    const excluded = new Set<string>();
    for (const s of recentSnapshots) {
        if (Array.isArray(s.prospect_ids)) for (const id of s.prospect_ids as string[]) excluded.add(id);
    }

    // Pre-flight: any active sequencer campaigns?
    const activeCampaignCount = await prisma.campaign.count({
        where: { organization_id: organizationId, status: 'active' },
    });
    if (activeCampaignCount === 0) {
        await prisma.coldCallDailySnapshot.create({
            data: {
                organization_id: organizationId,
                snapshot_date: todayLocal,
                prospect_ids: [],
                prospect_count: 0,
                status: 'no_campaigns',
            },
        });
        return { skipped: false, status: 'no_campaigns', prospectCount: 0 };
    }

    let rows: ProspectRow[] = [];
    try {
        rows = await generateProspectList({
            organizationId,
            rules: SYSTEM_LIST_RULES,
            excludeCampaignLeadIds: excluded,
        });
    } catch (err) {
        logger.error('[COLD-CALL] Daily snapshot generation failed', err instanceof Error ? err : new Error(String(err)), { organizationId });
        await prisma.coldCallDailySnapshot.create({
            data: {
                organization_id: organizationId,
                snapshot_date: todayLocal,
                prospect_ids: [],
                prospect_count: 0,
                status: 'error',
                error_message: (err as Error).message?.slice(0, 500) ?? 'unknown',
            },
        });
        return { skipped: false, status: 'error', prospectCount: 0 };
    }

    const status: 'success' | 'no_engagement' = rows.length > 0 ? 'success' : 'no_engagement';

    await prisma.coldCallDailySnapshot.create({
        data: {
            organization_id: organizationId,
            snapshot_date: todayLocal,
            prospect_ids: rows.map((r) => r.campaign_lead_id),
            prospect_count: rows.length,
            status,
        },
    });
    return { skipped: false, status, prospectCount: rows.length };
}

/**
 * Hydrate a stored daily snapshot back into ProspectRow[] for the page.
 * Re-fetches current Lead status (replied / bounced / unsubscribed) so the
 * UI can flag prospects whose state changed AFTER the snapshot — the
 * snapshot itself is immutable.
 */
export async function hydrateDailySnapshot(organizationId: string, snapshotDate: Date): Promise<{
    prospects: ProspectRow[];
    status: string;
    generatedAt: Date | null;
    errorMessage: string | null;
}> {
    const snap = await prisma.coldCallDailySnapshot.findUnique({
        where: { organization_id_snapshot_date: { organization_id: organizationId, snapshot_date: snapshotDate } },
    });
    if (!snap) return { prospects: [], status: 'missing', generatedAt: null, errorMessage: null };
    const ids = (snap.prospect_ids as string[]) ?? [];
    if (ids.length === 0) {
        return { prospects: [], status: snap.status, generatedAt: snap.generated_at, errorMessage: snap.error_message };
    }
    const prospects = await materializeFromIds(organizationId, ids);
    return { prospects, status: snap.status, generatedAt: snap.generated_at, errorMessage: snap.error_message };
}

/**
 * Re-hydrate ProspectRow[] from a fixed list of campaign_lead_ids. Used by
 * the snapshot reader and CSV download path. Order is preserved per input.
 */
async function materializeFromIds(organizationId: string, ids: string[]): Promise<ProspectRow[]> {
    if (ids.length === 0) return [];

    // Pull Cold Call List columns the same way generateProspectList does so
    // both paths produce identical-shaped rows.
    const campaignLeads = await prisma.campaignLead.findMany({
        where: { id: { in: ids } },
        select: {
            id: true,
            campaign_id: true,
            email: true,
            first_name: true,
            last_name: true,
            company: true,
            title: true,
            replied_at: true,
            bounced_at: true,
            unsubscribed_at: true,
            status: true,
            last_sent_at: true,
            campaign: { select: { name: true, organization_id: true } },
        },
    });
    const validLeads = campaignLeads.filter((cl) => cl.campaign.organization_id === organizationId);
    const validIdSet = new Set(validLeads.map((cl) => cl.id));
    const orderedLeads = ids.map((id) => validLeads.find((cl) => cl.id === id)).filter((x): x is NonNullable<typeof x> => !!x);

    const campaignIds = Array.from(new Set(orderedLeads.map((cl) => cl.campaign_id)));
    const cappedEmails = Array.from(new Set(orderedLeads.map((cl) => cl.email)));

    // Recompute scores from current event log so the displayed score reflects
    // the data we have today (not a frozen score). This stays consistent
    // whether the user views at 06:01 or 23:59 the same day.
    const since = new Date(Date.now() - 30 * 86_400_000); // 30d catchall
    const [opens, clicks] = await Promise.all([
        prisma.emailOpenEvent.findMany({
            where: {
                organization_id: organizationId,
                campaign_lead_id: { in: ids },
                opened_at: { gte: since },
            },
            select: { campaign_lead_id: true, opened_at: true, ms_since_send: true },
        }),
        prisma.emailClickEvent.findMany({
            where: {
                organization_id: organizationId,
                campaign_lead_id: { in: ids },
                clicked_at: { gte: since },
            },
            select: { campaign_lead_id: true, clicked_at: true },
        }),
    ]);
    const opensByLead = new Map<string, OpenSignal[]>();
    for (const o of opens) {
        if (!validIdSet.has(o.campaign_lead_id)) continue;
        const list = opensByLead.get(o.campaign_lead_id) ?? [];
        list.push({ opened_at: o.opened_at, ms_since_send: o.ms_since_send });
        opensByLead.set(o.campaign_lead_id, list);
    }
    const clicksByLead = new Map<string, ClickSignal[]>();
    for (const c of clicks) {
        if (!validIdSet.has(c.campaign_lead_id)) continue;
        const list = clicksByLead.get(c.campaign_lead_id) ?? [];
        list.push({ clicked_at: c.clicked_at });
        clicksByLead.set(c.campaign_lead_id, list);
    }

    const stepRows = await prisma.sequenceStep.findMany({
        where: { campaign_id: { in: campaignIds } },
        select: { campaign_id: true, step_number: true, subject: true },
        orderBy: [{ campaign_id: 'asc' }, { step_number: 'asc' }],
    });
    const subjectsByCampaign = new Map<string, string[]>();
    for (const s of stepRows) {
        const arr = subjectsByCampaign.get(s.campaign_id) ?? [];
        arr.push(s.subject);
        subjectsByCampaign.set(s.campaign_id, arr);
    }

    const leadEnrich = await prisma.lead.findMany({
        where: { organization_id: organizationId, email: { in: cappedEmails } },
        select: { email: true, phone: true, linkedin_url: true, full_name: true, last_activity_at: true },
    });
    const enrichByEmail = new Map<string, (typeof leadEnrich)[number]>();
    for (const l of leadEnrich) enrichByEmail.set(l.email.toLowerCase(), l);

    const sends = await prisma.sendEvent.findMany({
        where: { organization_id: organizationId, campaign_id: { in: campaignIds }, recipient_email: { in: cappedEmails } },
        orderBy: { sent_at: 'desc' },
        select: { recipient_email: true, campaign_id: true, sent_at: true },
        take: cappedEmails.length * 10,
    });
    const lastSentByKey = new Map<string, Date>();
    for (const s of sends) {
        const k = `${s.campaign_id}::${s.recipient_email.toLowerCase()}`;
        if (!lastSentByKey.has(k)) lastSentByKey.set(k, s.sent_at);
    }

    return orderedLeads.map((cl) => {
        const oList = opensByLead.get(cl.id) ?? [];
        const cList = clicksByLead.get(cl.id) ?? [];
        const score = computeScore(oList, cList);
        const enrich = enrichByEmail.get(cl.email.toLowerCase());
        const lastOpen = oList.length > 0 ? oList.sort((a, b) => a.opened_at.getTime() - b.opened_at.getTime())[oList.length - 1].opened_at : null;
        const lastClick = cList.length > 0 ? cList.sort((a, b) => a.clicked_at.getTime() - b.clicked_at.getTime())[cList.length - 1].clicked_at : null;
        const sentKey = `${cl.campaign_id}::${cl.email.toLowerCase()}`;
        return {
            campaign_lead_id: cl.id,
            email: cl.email,
            full_name: enrich?.full_name || [cl.first_name, cl.last_name].filter(Boolean).join(' ') || null,
            company: cl.company,
            title: cl.title,
            phone: enrich?.phone ?? null,
            linkedin_url: enrich?.linkedin_url ?? null,
            score,
            total_opens: oList.length,
            total_clicks: cList.length,
            last_open_at: lastOpen,
            last_click_at: lastClick,
            last_activity_at: enrich?.last_activity_at ?? null,
            reply_status: cl.replied_at ? 'replied' : 'none',
            bounced: cl.bounced_at !== null,
            unsubscribed: cl.unsubscribed_at !== null,
            campaign_id: cl.campaign_id,
            campaign_name: cl.campaign.name,
            last_email_sent_at: lastSentByKey.get(sentKey) ?? cl.last_sent_at ?? null,
            subjects_sent: subjectsByCampaign.get(cl.campaign_id) ?? [],
            reason: describeReason(oList.length, cList.length, lastOpen, lastClick),
        };
    });
}
