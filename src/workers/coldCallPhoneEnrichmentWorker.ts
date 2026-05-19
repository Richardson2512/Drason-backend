/**
 * Cold Call List - background phone enrichment.
 *
 * Goal (operator-requested): when a prospect on a cold-call list has no
 * phone number and the workspace has a BYOK enrichment provider connected,
 * fill Lead.phone via the existing enrichment waterfall so the SDR sees a
 * dialable number on the list instead of hunting it down.
 *
 * Deliberately conservative because every lookup spends the customer's own
 * provider credits (strict BYOK):
 *
 *   - OPT-IN: only workspaces with ColdCallListSettings
 *     .phone_enrichment_enabled = true are touched (default false).
 *   - SCOPE: only prospects that actually LANDED on a generated list (the
 *     most-recent successful daily snapshot + custom-list downloads in the
 *     last 7 days) - i.e. people an SDR will actually call.
 *   - SPEND GUARD: phone_enrichment_daily_cap lookups per workspace per
 *     UTC day, counted off the AgentRun ledger that runEnrichmentAgent
 *     already writes (trigger='cold_call_phone').
 *   - NEVER waste a lookup: shouldEnrichPhone() skips leads that already
 *     have a number or are hard-suppressed (bounced/unsubscribed/erased).
 *   - IDEMPOTENT per lead per day: a lead attempted today is not retried
 *     until tomorrow (the same AgentRun ledger), so an unresolvable lead
 *     can't burn the cap repeatedly.
 *
 * The Cold Call List live-joins Lead.phone at view time, so a number
 * filled here simply appears on the next refresh - the immutable snapshot
 * is never touched.
 *
 * Reuses runEnrichmentAgent (waterfall + agent-audit envelope). No new
 * enrichment plumbing.
 */

import { prisma } from '../prisma';
import { logger } from '../services/observabilityService';
import { runEnrichmentAgent } from '../services/agents/enrichmentAgent';
import { shouldEnrichPhone } from '../services/leadContactabilityService';

const RUN_INTERVAL_MS = 60 * 60 * 1000; // hourly - phone enrichment isn't time-critical
const FIRST_RUN_DELAY_MS = 5 * 60 * 1000; // 5 min after boot
const CUSTOM_SNAPSHOT_LOOKBACK_DAYS = 7;
const HARD_CAP_CEILING = 500; // defensive upper bound regardless of settings

let scheduled: NodeJS.Timeout | null = null;
let running = false;

function startOfUtcDay(now: Date): Date {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** Collect the CampaignLead ids that are on a CURRENT generated list for
 *  the org: the most-recent successful daily snapshot + custom-list
 *  downloads inside the lookback window. */
async function collectListedProspectIds(organizationId: string): Promise<string[]> {
    const sinceCustom = new Date(Date.now() - CUSTOM_SNAPSHOT_LOOKBACK_DAYS * 86_400_000);
    const [daily, customs] = await Promise.all([
        prisma.coldCallDailySnapshot.findFirst({
            where: { organization_id: organizationId, status: 'success' },
            orderBy: { generated_at: 'desc' },
            select: { prospect_ids: true },
        }),
        prisma.coldCallCustomSnapshot.findMany({
            where: { organization_id: organizationId, downloaded_at: { gte: sinceCustom } },
            select: { prospect_ids: true },
        }),
    ]);

    const ids = new Set<string>();
    const pushAll = (raw: unknown) => {
        if (Array.isArray(raw)) for (const v of raw) if (typeof v === 'string') ids.add(v);
    };
    if (daily) pushAll(daily.prospect_ids);
    for (const c of customs) pushAll(c.prospect_ids);
    return Array.from(ids);
}

async function enrichOrg(organizationId: string, dailyCap: number): Promise<{ attempted: number; filled: number }> {
    const now = new Date();
    const todayStart = startOfUtcDay(now);
    const cap = Math.max(0, Math.min(dailyCap, HARD_CAP_CEILING));
    if (cap === 0) return { attempted: 0, filled: 0 };

    // Provider pre-check: skip entirely when no enrichment tool is wired,
    // so we don't create no-op AgentRun rows or consume the cap.
    const providerCount = await prisma.enrichmentProvider.count({
        where: { organization_id: organizationId, enabled: true },
    });
    if (providerCount === 0) return { attempted: 0, filled: 0 };

    // Daily spend guard - count today's cold-call phone lookups (the
    // AgentRun ledger runEnrichmentAgent writes).
    const usedToday = await prisma.agentRun.count({
        where: {
            organization_id: organizationId,
            agent_name: 'enrichment',
            trigger: 'cold_call_phone',
            created_at: { gte: todayStart },
        },
    });
    const remaining = cap - usedToday;
    if (remaining <= 0) return { attempted: 0, filled: 0 };

    const listedIds = await collectListedProspectIds(organizationId);
    if (listedIds.length === 0) return { attempted: 0, filled: 0 };

    // Resolve CampaignLead -> Lead (org-scoped), keep only contactable
    // prospects with no usable phone.
    const campaignLeads = await prisma.campaignLead.findMany({
        where: { id: { in: listedIds }, campaign: { organization_id: organizationId } },
        select: {
            id: true, email: true, first_name: true, last_name: true,
            company: true, status: true, bounced_at: true, unsubscribed_at: true,
        },
    });
    if (campaignLeads.length === 0) return { attempted: 0, filled: 0 };

    const emails = Array.from(new Set(campaignLeads.map(cl => cl.email.toLowerCase())));
    const leads = await prisma.lead.findMany({
        where: { organization_id: organizationId, email: { in: emails } },
        select: { id: true, email: true, phone: true, full_name: true, company: true, linkedin_url: true },
    });
    const leadByEmail = new Map(leads.map(l => [l.email.toLowerCase(), l]));

    // De-dupe to one entry per Lead (a lead can sit behind several
    // CampaignLead rows / both snapshot types); first occurrence wins.
    const targets = new Map<string, { lead: (typeof leads)[number]; cl: (typeof campaignLeads)[number] }>();
    for (const cl of campaignLeads) {
        const lead = leadByEmail.get(cl.email.toLowerCase());
        if (!lead) continue;
        if (targets.has(lead.id)) continue;
        const contactable = shouldEnrichPhone({
            status: cl.status,
            bounced_at: cl.bounced_at,
            unsubscribed_at: cl.unsubscribed_at,
            email: cl.email,
            phone: lead.phone,
        });
        if (contactable) targets.set(lead.id, { lead, cl });
    }
    if (targets.size === 0) return { attempted: 0, filled: 0 };

    // Per-lead-per-day idempotency: drop leads already attempted today.
    const candidateLeadIds = Array.from(targets.keys());
    const attemptedToday = await prisma.agentRun.findMany({
        where: {
            organization_id: organizationId,
            agent_name: 'enrichment',
            trigger: 'cold_call_phone',
            created_at: { gte: todayStart },
            trigger_ref_id: { in: candidateLeadIds },
        },
        select: { trigger_ref_id: true },
    });
    const attemptedSet = new Set(attemptedToday.map(a => a.trigger_ref_id));

    const queue = candidateLeadIds
        .filter(id => !attemptedSet.has(id))
        .slice(0, remaining);

    let attempted = 0;
    let filled = 0;
    for (const leadId of queue) {
        const t = targets.get(leadId);
        if (!t) continue;
        const { lead, cl } = t;
        attempted++;
        try {
            const fullName =
                lead.full_name ||
                [cl.first_name, cl.last_name].filter(Boolean).join(' ').trim() ||
                undefined;
            const result = await runEnrichmentAgent({
                organization_id: organizationId,
                lead_id: lead.id,
                profile: {
                    full_name: fullName,
                    company_name: lead.company || cl.company || undefined,
                    email_hint: lead.email,
                    linkedin_url: lead.linkedin_url || undefined,
                },
                trigger: 'cold_call_phone',
                required_fields: ['phone'],
            });
            const phone = result.final_fields.phone;
            if (typeof phone === 'string' && phone.trim().length > 0) {
                // Guarded write: only fill when still empty so we never
                // overwrite a user-supplied / concurrently-set number.
                const upd = await prisma.lead.updateMany({
                    where: {
                        id: lead.id,
                        organization_id: organizationId,
                        OR: [{ phone: null }, { phone: '' }],
                    },
                    data: { phone: phone.trim(), last_activity_at: new Date() },
                });
                if (upd.count > 0) filled++;
            }
        } catch (err) {
            logger.error(
                '[COLD-CALL-PHONE] lead enrichment failed',
                err instanceof Error ? err : new Error(String(err)),
                { organizationId, leadId },
            );
        }
    }
    return { attempted, filled };
}

export async function runColdCallPhoneEnrichmentTick(): Promise<{
    orgs: number;
    attempted: number;
    filled: number;
}> {
    // Only opted-in workspaces - cheap up-front filter, no scan of orgs
    // that never enabled the feature.
    const optedIn = await prisma.coldCallListSettings.findMany({
        where: { phone_enrichment_enabled: true },
        select: { organization_id: true, phone_enrichment_daily_cap: true },
    });

    let attempted = 0;
    let filled = 0;
    for (const s of optedIn) {
        try {
            const r = await enrichOrg(s.organization_id, s.phone_enrichment_daily_cap);
            attempted += r.attempted;
            filled += r.filled;
        } catch (err) {
            logger.error(
                '[COLD-CALL-PHONE] org enrichment failed',
                err instanceof Error ? err : new Error(String(err)),
                { organizationId: s.organization_id },
            );
        }
    }
    return { orgs: optedIn.length, attempted, filled };
}

export function scheduleColdCallPhoneEnrichment(): void {
    if (scheduled) return;
    logger.info('[COLD-CALL-PHONE] Scheduling background phone-enrichment worker (hourly tick)');

    const tick = async () => {
        if (running) return; // never overlap a slow tick with the next one
        running = true;
        try {
            const r = await runColdCallPhoneEnrichmentTick();
            if (r.attempted > 0) logger.info('[COLD-CALL-PHONE] Tick complete', r);
        } catch (err) {
            logger.error('[COLD-CALL-PHONE] Tick failed', err instanceof Error ? err : new Error(String(err)));
        } finally {
            running = false;
        }
    };

    setTimeout(() => {
        void tick();
        scheduled = setInterval(() => { void tick(); }, RUN_INTERVAL_MS);
    }, FIRST_RUN_DELAY_MS);
}

export function stopColdCallPhoneEnrichment(): void {
    if (scheduled) {
        clearInterval(scheduled);
        scheduled = null;
    }
}
