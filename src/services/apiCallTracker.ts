/**
 * API Call Tracker
 *
 * Lightweight service to log every external platform API call.
 * Uses fire-and-forget DB writes — never blocks the actual API call.
 */

import { prisma } from '../index';
import { logger } from './observabilityService';

let writeQueue: Array<{
    organization_id: string;
    platform: string;
    endpoint: string;
    status_code?: number;
    duration_ms?: number;
    error?: string;
}> = [];

let flushTimer: NodeJS.Timeout | null = null;
const FLUSH_INTERVAL_MS = 5000; // Batch-write every 5 seconds
const MAX_QUEUE_SIZE = 500;

/**
 * Track an API call. Non-blocking — queues for batch insert.
 */
export function trackApiCall(
    organizationId: string,
    platform: string,
    endpoint: string,
    statusCode?: number,
    durationMs?: number,
    error?: string,
): void {
    writeQueue.push({
        organization_id: organizationId,
        platform,
        endpoint,
        status_code: statusCode,
        duration_ms: durationMs,
        error: error?.substring(0, 500),
    });

    // Flush if queue is large
    if (writeQueue.length >= MAX_QUEUE_SIZE) {
        flushQueue();
    }

    // Start flush timer if not running
    if (!flushTimer) {
        flushTimer = setTimeout(() => {
            flushTimer = null;
            flushQueue();
        }, FLUSH_INTERVAL_MS);
    }
}

/**
 * Flush queued API call logs to the database.
 */
async function flushQueue(): Promise<void> {
    if (writeQueue.length === 0) return;

    const batch = writeQueue.splice(0);

    try {
        await prisma.apiCallLog.createMany({ data: batch });
    } catch (err) {
        // Non-fatal — don't lose the batch, but don't retry forever
        logger.warn('[API_TRACKER] Failed to flush batch', {
            batchSize: batch.length,
            error: String(err),
        });
    }
}

/**
 * Get API call stats for admin dashboard.
 */
export async function getApiCallStats(organizationId?: string) {
    const where = organizationId ? { organization_id: organizationId } : {};

    const byPlatform = await prisma.apiCallLog.groupBy({
        by: ['platform'],
        where,
        _count: true,
    });

    const last24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const byPlatformLast24h = await prisma.apiCallLog.groupBy({
        by: ['platform'],
        where: { ...where, created_at: { gte: last24h } },
        _count: true,
    });

    const totalCalls = byPlatform.reduce((s, p) => s + p._count, 0);
    const totalLast24h = byPlatformLast24h.reduce((s, p) => s + p._count, 0);

    const errors = await prisma.apiCallLog.count({
        where: { ...where, error: { not: null } },
    });

    return {
        totalCalls,
        totalLast24h,
        errors,
        byPlatform: byPlatform.reduce((acc, p) => {
            acc[p.platform] = p._count;
            return acc;
        }, {} as Record<string, number>),
        byPlatformLast24h: byPlatformLast24h.reduce((acc, p) => {
            acc[p.platform] = p._count;
            return acc;
        }, {} as Record<string, number>),
    };
}

/**
 * Flush on shutdown.
 */
export async function shutdown(): Promise<void> {
    if (flushTimer) clearTimeout(flushTimer);
    await flushQueue();
}
