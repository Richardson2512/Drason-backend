/**
 * Cold Call List daily snapshot worker.
 *
 * Runs every hour (matching the existing setInterval pattern used by
 * warmupTrackingWorker / espPerformanceWorker). For each organization, the
 * worker checks: is it currently 06:00 in this org's local timezone AND has
 * a snapshot not yet been created for today's local date? If both, generate
 * the snapshot. Idempotent — re-running for an org that's already snapshotted
 * today is a no-op (handled inside generateDailySnapshot).
 *
 * One worker, one interval, all orgs. Same shape as scheduleWarmupTracking.
 */

import { prisma } from '../index';
import { logger } from '../services/observabilityService';
import {
    generateDailySnapshot,
    getWorkspaceTimezone,
    workspaceLocalDate,
    workspaceLocalHour,
} from '../services/coldCallListService';

const TARGET_HOUR = 6; // 06:00 local — matches spec
const RUN_INTERVAL_MS = 60 * 60 * 1000; // hourly

/**
 * Single tick: walk all orgs, snapshot each one whose local hour is the
 * target hour and which doesn't yet have a row for today's local date.
 */
export async function runColdCallListTick(): Promise<{
    processed: number;
    skipped: number;
    failed: number;
}> {
    const orgs = await prisma.organization.findMany({ select: { id: true } });
    const now = new Date();
    let processed = 0;
    let skipped = 0;
    let failed = 0;

    for (const org of orgs) {
        try {
            const tz = await getWorkspaceTimezone(org.id);
            const localHour = workspaceLocalHour(now, tz);
            if (localHour !== TARGET_HOUR) {
                skipped++;
                continue;
            }
            const todayLocal = workspaceLocalDate(now, tz);
            const existing = await prisma.coldCallDailySnapshot.findUnique({
                where: { organization_id_snapshot_date: { organization_id: org.id, snapshot_date: todayLocal } },
            });
            if (existing) {
                skipped++;
                continue;
            }
            await generateDailySnapshot(org.id);
            processed++;
        } catch (err) {
            failed++;
            logger.error(
                '[COLD-CALL-WORKER] Snapshot generation failed for org',
                err instanceof Error ? err : new Error(String(err)),
                { organizationId: org.id },
            );
        }
    }

    return { processed, skipped, failed };
}

/**
 * Schedule the hourly Cold Call List worker. Call this on server startup
 * alongside the other scheduleX() calls in index.ts.
 */
export function scheduleColdCallListSnapshots(): NodeJS.Timeout {
    logger.info('[COLD-CALL-WORKER] Scheduling daily snapshot worker (hourly tick)');

    // Run once immediately on startup so a freshly-deployed server can fill
    // in the current hour's eligible workspaces without waiting an hour.
    runColdCallListTick()
        .then((r) => logger.info('[COLD-CALL-WORKER] Initial tick', r))
        .catch((err) => logger.error('[COLD-CALL-WORKER] Initial tick failed', err instanceof Error ? err : new Error(String(err))));

    const interval = setInterval(() => {
        runColdCallListTick()
            .then((r) => logger.info('[COLD-CALL-WORKER] Hourly tick', r))
            .catch((err) => logger.error('[COLD-CALL-WORKER] Hourly tick failed', err instanceof Error ? err : new Error(String(err))));
    }, RUN_INTERVAL_MS);

    return interval;
}
