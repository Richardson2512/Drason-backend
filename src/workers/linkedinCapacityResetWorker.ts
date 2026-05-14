/**
 * LinkedIn account capacity-counter reset worker.
 *
 * The send pipeline maintains running counters per LinkedInAccount:
 *   invites_today, invites_this_week, messages_today, inmails_today,
 *   profile_views_today.
 *
 * Without a periodic reset they grow unbounded and the capacity-check
 * service would never let any campaign dispatch. This worker:
 *   - Resets *_today counters daily at the account's timezone midnight
 *     (approximated to UTC midnight for v1 — per-account TZ resets land
 *     in Phase 5 with the CampaignSender working-hours table).
 *   - Resets invites_this_week on Monday UTC midnight (LinkedIn's
 *     weekly cap rolls over on a 7-day window — close enough; the
 *     enforcement layer also tracks last_status_at for anomalies).
 *
 * Idempotent: only updates rows whose daily_reset_at / weekly_reset_at
 * is before the cutoff. Safe to run multiple times per minute.
 */

import { prisma } from '../prisma';
import { logger } from '../services/observabilityService';

const RUN_INTERVAL_MS = 30 * 60 * 1000; // 30min — granular enough to catch boundaries within a half-hour
const FIRST_RUN_DELAY_MS = 2 * 60 * 1000;

let scheduled: NodeJS.Timeout | null = null;
let totalRuns = 0;
let totalDailyReset = 0;
let totalWeeklyReset = 0;
let lastError: string | null = null;

/**
 * Compute the most recent UTC midnight as the daily reset cutoff.
 * Any account whose daily_reset_at is BEFORE this timestamp needs
 * its *_today counters zeroed and its daily_reset_at bumped to now.
 */
function todayStartUtc(): Date {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
}

/**
 * Most recent Monday UTC midnight — weekly cap rolls over here.
 */
function weekStartUtc(): Date {
    const t = todayStartUtc();
    const dayOfWeek = t.getUTCDay(); // 0 (Sun) ... 6 (Sat)
    const daysSinceMonday = (dayOfWeek + 6) % 7; // Mon = 0
    t.setUTCDate(t.getUTCDate() - daysSinceMonday);
    return t;
}

export async function runOnce(): Promise<{ daily: number; weekly: number }> {
    const dayCutoff = todayStartUtc();
    const weekCutoff = weekStartUtc();

    const dailyResult = await prisma.linkedInAccount.updateMany({
        where: { daily_reset_at: { lt: dayCutoff } },
        data: {
            invites_today: 0,
            messages_today: 0,
            inmails_today: 0,
            profile_views_today: 0,
            // Reset the watchlist/poller action budget alongside the
            // send-specific counters. LinkedIn's daily action budget
            // is a single ~100/day ceiling shared by all activity types,
            // so the natural reset point is the same UTC midnight.
            unipile_actions_today: 0,
            daily_reset_at: new Date(),
        },
    });

    const weeklyResult = await prisma.linkedInAccount.updateMany({
        where: { weekly_reset_at: { lt: weekCutoff } },
        data: {
            invites_this_week: 0,
            weekly_reset_at: new Date(),
        },
    });

    return { daily: dailyResult.count, weekly: weeklyResult.count };
}

async function tick(): Promise<void> {
    totalRuns += 1;
    try {
        const { daily, weekly } = await runOnce();
        totalDailyReset += daily;
        totalWeeklyReset += weekly;
        if (daily + weekly > 0) {
            logger.info('[LINKEDIN-CAPACITY-RESET] Counters rolled over', { daily, weekly });
        }
        lastError = null;
    } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        logger.error('[LINKEDIN-CAPACITY-RESET] Run failed', err instanceof Error ? err : new Error(lastError));
    }
}

export function scheduleLinkedInCapacityReset(): void {
    if (scheduled) return;
    setTimeout(() => {
        void tick();
        scheduled = setInterval(() => { void tick(); }, RUN_INTERVAL_MS);
    }, FIRST_RUN_DELAY_MS);
    logger.info('[LINKEDIN-CAPACITY-RESET] Scheduled', { intervalMs: RUN_INTERVAL_MS });
}

export function stopLinkedInCapacityReset(): void {
    if (scheduled) {
        clearInterval(scheduled);
        scheduled = null;
    }
}

export function getCapacityResetWorkerStatus() {
    return { totalRuns, totalDailyReset, totalWeeklyReset, lastError, scheduled: Boolean(scheduled) };
}
