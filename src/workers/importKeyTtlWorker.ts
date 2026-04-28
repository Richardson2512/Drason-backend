/**
 * Import Key TTL Worker
 *
 * Sweeps every 15 minutes for expired one-time-import API keys and wipes them.
 * Belt-and-suspenders for `getDecryptedImportKey()`'s read-time expiry check —
 * makes sure we don't sit on plaintext-recoverable keys past their TTL even
 * if nobody happens to read them.
 *
 * The actual sweep logic lives in importJobService.sweepExpiredKeys() so it
 * can be exercised from tests and admin tooling without scheduling.
 */

import { logger } from '../services/observabilityService';
import { sweepExpiredKeys } from '../services/importJobService';

const INTERVAL_MS = 15 * 60 * 1000;
let scheduled: NodeJS.Timeout | null = null;
let lastRunAt: Date | null = null;
let lastError: string | null = null;
let totalRuns = 0;
let totalKeysWiped = 0;

export const runImportKeyTtlSweep = async (): Promise<number> => {
    const wiped = await sweepExpiredKeys();
    lastRunAt = new Date();
    totalRuns++;
    totalKeysWiped += wiped;
    return wiped;
};

export const scheduleImportKeyTtlSweep = (): void => {
    const tick = async () => {
        try {
            await runImportKeyTtlSweep();
            lastError = null;
        } catch (err: any) {
            lastError = err.message?.slice(0, 200) || 'unknown';
            logger.error('[IMPORT-KEY-TTL] Sweep error', err);
        }
        scheduled = setTimeout(tick, INTERVAL_MS);
    };

    // First run after a short delay so server boot isn't blocked.
    scheduled = setTimeout(tick, 30 * 1000);
    logger.info(`[IMPORT-KEY-TTL] Scheduled — sweep every ${INTERVAL_MS / 60000}m`);
};

export const stopImportKeyTtlSweep = (): void => {
    if (scheduled) {
        clearTimeout(scheduled);
        scheduled = null;
        logger.info('[IMPORT-KEY-TTL] Stopped');
    }
};

export const getImportKeyTtlStatus = () => ({
    lastRunAt,
    lastError,
    totalRuns,
    totalKeysWiped,
    intervalMinutes: INTERVAL_MS / 60000,
});
