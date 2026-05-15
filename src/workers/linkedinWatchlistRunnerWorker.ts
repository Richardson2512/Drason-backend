/**
 * Topics watchlist runner - picks up due SignalWatchlist rows and runs
 * a scan against each via runWatchlistScan().
 *
 * Cadence:
 *   - Tick every 5 minutes.
 *   - A watchlist is due when `next_run_at <= now()` AND `enabled = true`.
 *   - After a scan completes, runWatchlistScan() bumps next_run_at by
 *     +1h, so a steady-state watchlist runs hourly.
 *
 * Concurrency:
 *   - Watchlists run serially within a tick to keep Unipile call rates
 *     predictable. Each scan is bounded by daily_signal_budget +
 *     min_reaction_count + the per-keyword cap, so a single watchlist's
 *     wall-clock stays in the 20-60s envelope.
 *
 * Failure handling:
 *   - Per-watchlist try/catch: a failing scan doesn't stop the tick.
 *   - On failure we still set next_run_at forward (+15m) so we don't
 *     hot-loop on a broken watchlist; the error is logged with the
 *     watchlist id for triage.
 */

import { prisma } from '../prisma';
import { logger } from '../services/observabilityService';
import { runWatchlistScan } from '../services/linkedin/topicsWatchlistService';

const TICK_INTERVAL_MS = 5 * 60 * 1000;
const FIRST_RUN_DELAY_MS = 90 * 1000;
const RETRY_BACKOFF_MS = 15 * 60 * 1000;
const MAX_PER_TICK = 20;

let scheduled: NodeJS.Timeout | null = null;
let totalTicks = 0;
let totalScans = 0;
let totalErrors = 0;
let lastTickAt: Date | null = null;
let lastError: string | null = null;

export async function runOnce(): Promise<{ scanned: number; errored: number }> {
    const now = new Date();
    // Pull due watchlists in one shot. Ordered by next_run_at so the
    // oldest-due watchlist runs first when there's a backlog.
    const due = await prisma.signalWatchlist.findMany({
        where: {
            enabled: true,
            next_run_at: { lte: now },
        },
        orderBy: { next_run_at: 'asc' },
        take: MAX_PER_TICK,
        select: { id: true, organization_id: true, name: true },
    }) as Array<{ id: string; organization_id: string; name: string }>;

    let scanned = 0;
    let errored = 0;
    for (const wl of due) {
        try {
            await runWatchlistScan(wl.id);
            scanned += 1;
        } catch (err) {
            errored += 1;
            const msg = err instanceof Error ? err.message : String(err);
            logger.error('[WATCHLIST-RUNNER] Scan failed', err instanceof Error ? err : new Error(msg), {
                watchlist_id: wl.id, organization_id: wl.organization_id, name: wl.name,
            });
            // Back off - don't hot-loop on a broken watchlist.
            try {
                await prisma.signalWatchlist.update({
                    where: { id: wl.id },
                    data: { next_run_at: new Date(Date.now() + RETRY_BACKOFF_MS) },
                });
            } catch (bumpErr) {
                logger.error('[WATCHLIST-RUNNER] Failed to bump next_run_at after error',
                    bumpErr instanceof Error ? bumpErr : new Error(String(bumpErr)),
                    { watchlist_id: wl.id });
            }
        }
    }
    return { scanned, errored };
}

async function tick(): Promise<void> {
    totalTicks += 1;
    lastTickAt = new Date();
    try {
        const { scanned, errored } = await runOnce();
        totalScans += scanned;
        totalErrors += errored;
        if (scanned + errored > 0) {
            logger.info('[WATCHLIST-RUNNER] Tick complete', { scanned, errored });
        }
        lastError = null;
    } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        logger.error('[WATCHLIST-RUNNER] Tick failed', err instanceof Error ? err : new Error(lastError));
    }
}

export function scheduleLinkedInWatchlistRunner(): void {
    if (scheduled) return;
    setTimeout(() => {
        void tick();
        scheduled = setInterval(() => { void tick(); }, TICK_INTERVAL_MS);
    }, FIRST_RUN_DELAY_MS);
    logger.info('[WATCHLIST-RUNNER] Scheduled', { intervalMs: TICK_INTERVAL_MS });
}

export function stopLinkedInWatchlistRunner(): void {
    if (scheduled) {
        clearInterval(scheduled);
        scheduled = null;
    }
}

export function getWatchlistRunnerStatus() {
    return { totalTicks, totalScans, totalErrors, lastTickAt, lastError, scheduled: Boolean(scheduled) };
}
