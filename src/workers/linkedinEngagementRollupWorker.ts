/**
 * Nightly maintenance sweep for the LinkedInProfile engagement rollup
 * cache. Recomputes engagement_count_30d, distinct_posts_engaged_30d,
 * last_engaged_at, and engagement_score from the canonical EngagementEvent
 * rows for every profile that has any engagement in the trailing 30-day
 * window. Profiles that have aged past 30 days since their last
 * engagement get their counters cleared so the rollup decays correctly
 * even without new traffic.
 *
 * Why nightly: the signal poller updates these counters on every event
 * insert, but cache drift is still possible from worker crashes, missed
 * increments, or the moving window edge. One pass per day brings the
 * cache back to ground truth.
 *
 * Schedule: 03:00 UTC ± 30 minutes of jitter to spread load across
 * multi-instance deployments.
 */

import { logger } from '../services/observabilityService';
import { recomputeProfileRollups } from '../services/linkedin/engagementRollupService';

const RUN_INTERVAL_MS = 24 * 60 * 60 * 1000;
const JITTER_MS = 30 * 60 * 1000;

let scheduled: NodeJS.Timeout | null = null;
let totalRuns = 0;
let totalProfilesUpdated = 0;
let totalProfilesDecayed = 0;
let lastError: string | null = null;
let lastRunAt: Date | null = null;

function msUntilNext3amUtc(): number {
    const now = new Date();
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 3, 0, 0));
    if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
    return next.getTime() - now.getTime() + Math.floor((Math.random() - 0.5) * JITTER_MS * 2);
}

async function tick(): Promise<void> {
    totalRuns += 1;
    lastRunAt = new Date();
    const startedAt = Date.now();
    try {
        const { profilesUpdated, profilesDecayed } = await recomputeProfileRollups();
        totalProfilesUpdated += profilesUpdated;
        totalProfilesDecayed += profilesDecayed;
        lastError = null;
        logger.info('[LINKEDIN-ROLLUP] Cycle complete', {
            profilesUpdated,
            profilesDecayed,
            latencyMs: Date.now() - startedAt,
        });
    } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        logger.error('[LINKEDIN-ROLLUP] Cycle failed', err instanceof Error ? err : new Error(lastError));
    }
}

export function scheduleLinkedInEngagementRollup(): void {
    if (scheduled) return;
    const firstDelay = msUntilNext3amUtc();
    setTimeout(() => {
        void tick();
        scheduled = setInterval(() => { void tick(); }, RUN_INTERVAL_MS);
    }, firstDelay);
    logger.info('[LINKEDIN-ROLLUP] Scheduled', { firstDelayMs: firstDelay, intervalMs: RUN_INTERVAL_MS });
}

export function stopLinkedInEngagementRollup(): void {
    if (scheduled) {
        clearInterval(scheduled);
        scheduled = null;
    }
}

export function getLinkedInEngagementRollupStatus() {
    return {
        totalRuns,
        totalProfilesUpdated,
        totalProfilesDecayed,
        lastError,
        lastRunAt: lastRunAt?.toISOString() ?? null,
        scheduled: Boolean(scheduled),
    };
}
