/**
 * Postmaster Tools Worker
 *
 * Daily job that fetches per-domain reputation from Google Postmaster Tools
 * for every Org that has completed the OAuth connection. Runs at 03:00 UTC
 * to give Google's data the full 24-48h propagation buffer.
 *
 * Idempotent: each fetch upserts on (domain_id, source, date) — running
 * twice on the same day just overwrites with fresh data.
 *
 * Rate limit: Postmaster API is generous (1000 reads/day at the project
 * level). Per-org we issue 1 listDomains + N getTrafficStats. Even at
 * 100 domains/org × 10 orgs that's well under quota.
 */

import { prisma } from '../index';
import { logger } from '../services/observabilityService';
import { fetchAllForOrg } from '../services/postmasterToolsService';

const RUN_HOUR_UTC = 3;
let scheduled: NodeJS.Timeout | null = null;
let lastRunAt: Date | null = null;
let lastError: string | null = null;
let totalRuns = 0;

interface RunResult {
    orgsAttempted: number;
    orgsSucceeded: number;
    domainsFound: number;
    rowsWritten: number;
    errors: number;
}

/**
 * Run the worker once across all orgs that have an active connection.
 * Exported so it can be triggered manually (admin button, cron-on-deploy, tests).
 */
export const runPostmasterFetch = async (): Promise<RunResult> => {
    const result: RunResult = {
        orgsAttempted: 0,
        orgsSucceeded: 0,
        domainsFound: 0,
        rowsWritten: 0,
        errors: 0,
    };

    const connectedOrgs = await prisma.organization.findMany({
        where: { postmaster_refresh_token: { not: null } },
        select: { id: true, name: true },
    });

    logger.info(`[POSTMASTER-WORKER] Starting fetch across ${connectedOrgs.length} connected orgs`);

    for (const org of connectedOrgs) {
        result.orgsAttempted++;
        try {
            const orgResult = await fetchAllForOrg(org.id);
            result.domainsFound += orgResult.domainsFound;
            result.rowsWritten += orgResult.rowsWritten;
            result.errors += orgResult.errors;
            if (orgResult.errors === 0) result.orgsSucceeded++;
            logger.info('[POSTMASTER-WORKER] Org fetch complete', {
                orgId: org.id,
                orgName: org.name,
                ...orgResult,
            });
        } catch (err: any) {
            result.errors++;
            logger.error('[POSTMASTER-WORKER] Org fetch failed', err, { orgId: org.id });
        }
    }

    lastRunAt = new Date();
    lastError = result.errors > 0 ? `${result.errors} errors across ${result.orgsAttempted} orgs` : null;
    totalRuns++;

    logger.info('[POSTMASTER-WORKER] Run complete', result);
    return result;
};

function msUntilNextRun(): number {
    const now = new Date();
    const next = new Date(Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate(),
        RUN_HOUR_UTC, 0, 0, 0,
    ));
    if (next.getTime() <= now.getTime()) {
        // Already past today's run time — schedule for tomorrow.
        next.setUTCDate(next.getUTCDate() + 1);
    }
    return next.getTime() - now.getTime();
}

/**
 * Schedule the daily Postmaster fetch. Returns the active timer handle.
 * Call once at server startup. Self-reschedules after each run.
 */
export const schedulePostmasterFetch = (): void => {
    const tick = async () => {
        try {
            await runPostmasterFetch();
        } catch (err: any) {
            logger.error('[POSTMASTER-WORKER] Top-level run error', err);
            lastError = err.message?.slice(0, 200) || 'unknown';
        }
        scheduled = setTimeout(tick, msUntilNextRun());
    };
    scheduled = setTimeout(tick, msUntilNextRun());
    logger.info(`[POSTMASTER-WORKER] Scheduled — next run at ${new Date(Date.now() + msUntilNextRun()).toISOString()}`);
};

export const stopPostmasterFetch = (): void => {
    if (scheduled) {
        clearTimeout(scheduled);
        scheduled = null;
        logger.info('[POSTMASTER-WORKER] Stopped');
    }
};

export const getPostmasterWorkerStatus = () => ({
    lastRunAt,
    lastError,
    totalRuns,
    nextRunAt: scheduled ? new Date(Date.now() + msUntilNextRun()).toISOString() : null,
});
