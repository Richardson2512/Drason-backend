/**
 * Shared control primitives for the polling job workers (lead-source import,
 * Outreach export, JustCall export). Two concerns, one home so the policy
 * can't drift between workers:
 *
 *  1. withWorkerLock - a distributed, TTL-expiring lock so only ONE backend
 *     instance runs a given worker's tick at a time. Without it, every
 *     instance's tick selects the same `pending`/`running` jobs (the in-process
 *     `running` boolean is per-process) and double-processes them - duplicate
 *     external API calls and inflated counters. Same primitive the send
 *     dispatcher and held-lead processor already use.
 *
 *  2. MAX_JOB_RETRIES - the give-up ceiling for retryable errors. Previously a
 *     retryable error bumped error_count and left the job `running` forever, so
 *     a persistently-failing provider (sustained 429/5xx) retried every tick
 *     indefinitely. After this many retryable failures the worker marks the job
 *     failed instead of looping.
 */

import { acquireLock, releaseLock } from './redis';
import { logger } from '../services/observabilityService';

/** Retryable-error give-up ceiling, shared across all job workers. */
export const MAX_JOB_RETRIES = 5;

/**
 * Run `fn` only if this process can claim `lockKey`; otherwise skip the tick
 * (another instance/run holds it). Always releases on completion; the TTL is
 * the backstop if the process dies mid-tick.
 */
export async function withWorkerLock(
    lockKey: string,
    ttlSeconds: number,
    fn: () => Promise<void>,
): Promise<void> {
    const acquired = await acquireLock(lockKey, ttlSeconds);
    if (!acquired) {
        logger.info(`[WORKER_LOCK] ${lockKey} held elsewhere - skipping this tick`);
        return;
    }
    try {
        await fn();
    } finally {
        await releaseLock(lockKey).catch((err: any) =>
            logger.warn(`[WORKER_LOCK] failed to release ${lockKey} (will TTL-expire)`, { error: err?.message }),
        );
    }
}
