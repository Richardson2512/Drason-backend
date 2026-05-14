/**
 * Lead Enrichment Worker
 *
 * Walks Lead rows that need a LeadProfile (no row yet, or stale) and
 * enriches them in the background via leadProfileService.enrichLead.
 *
 * Why a worker, not a hook on lead create:
 *   - Jina Reader can be slow (1-3s/URL); blocking lead import on it
 *     would tank UX for CSV bulk imports of thousands of rows.
 *   - Failures (LinkedIn blocked, site down) shouldn't fail the import.
 *   - Re-enrichment on TTL is naturally a periodic job.
 *
 * Pacing:
 *   - One Jina call every JINA_THROTTLE_MS to stay polite (Jina free
 *     tier has soft limits; we don't want to get rate-limited).
 *   - BATCH_PER_TICK leads per worker tick → bounded burst.
 *   - 60s tick → at default pacing the worker handles ~10 leads/min.
 */

import { prisma } from '../prisma';
import { logger } from '../services/observabilityService';
import { enrichLead } from '../services/leadProfileService';

const POLL_INTERVAL_MS = 60_000;
const BATCH_PER_TICK = 10;
const JINA_THROTTLE_MS = 2_000;
const TTL_DAYS = parseInt(process.env.LEAD_PROFILE_TTL_DAYS || '60', 10);

let running = false;
let stopped = false;
let timer: NodeJS.Timeout | null = null;

async function findCandidates(): Promise<string[]> {
    const ttlCutoff = new Date(Date.now() - TTL_DAYS * 24 * 60 * 60 * 1000);

    // Candidates:
    //  (a) Leads with company_linkedin_url or website but no LeadProfile row at all
    //  (b) Leads with a 'ready' LeadProfile that's older than TTL
    //
    // Skipped/failed rows are intentionally NOT auto-retried — the
    // operator must touch the lead's source URLs to clear them. That
    // prevents a worker spin-loop on permanently-broken pages.
    const missing = await prisma.lead.findMany({
        where: {
            OR: [
                { company_linkedin_url: { not: null } },
                { website: { not: null } },
            ],
            leadProfile: null,
        },
        select: { id: true },
        take: BATCH_PER_TICK,
    });

    const stale = await prisma.leadProfile.findMany({
        where: {
            status: 'ready',
            extracted_at: { lt: ttlCutoff },
        },
        select: { lead_id: true },
        orderBy: { extracted_at: 'asc' },
        take: Math.max(0, BATCH_PER_TICK - missing.length),
    });

    return [
        ...missing.map(l => l.id),
        ...stale.map(l => l.lead_id),
    ];
}

async function tick(): Promise<void> {
    if (running || stopped) return;
    running = true;
    try {
        const leadIds = await findCandidates();
        if (leadIds.length === 0) return;

        logger.info('[LEAD_ENRICHMENT] Picked up batch', { count: leadIds.length });

        for (const id of leadIds) {
            if (stopped) break;
            try {
                const result = await enrichLead(id);
                if (result.status === 'failed') {
                    logger.warn('[LEAD_ENRICHMENT] enrichLead failed', { leadId: id, error: result.error });
                }
            } catch (err) {
                logger.error(
                    '[LEAD_ENRICHMENT] enrichLead crashed',
                    err instanceof Error ? err : new Error(String(err)),
                    { leadId: id },
                );
            }
            // Throttle between leads so Jina doesn't see a burst from us.
            // Last lead in batch doesn't need to wait — next tick handles pacing.
            if (id !== leadIds[leadIds.length - 1] && !stopped) {
                await new Promise(resolve => setTimeout(resolve, JINA_THROTTLE_MS));
            }
        }
    } finally {
        running = false;
    }
}

export function startLeadEnrichmentWorker(): void {
    if (timer) return;
    stopped = false;
    timer = setInterval(() => { tick().catch(() => undefined); }, POLL_INTERVAL_MS);
    logger.info('[LEAD_ENRICHMENT_WORKER] started');
}

export function stopLeadEnrichmentWorker(): void {
    stopped = true;
    if (timer) {
        clearInterval(timer);
        timer = null;
        logger.info('[LEAD_ENRICHMENT_WORKER] stopped');
    }
}
