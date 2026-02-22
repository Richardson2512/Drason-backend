/**
 * Platform Sync Worker
 *
 * Unified sync worker that discovers all configured platforms per organization
 * and syncs each one independently. Replaces the Smartlead-specific sync worker.
 *
 * Key features:
 * - Runs every 20 minutes to keep data fresh
 * - Discovers all configured platforms per org via PlatformRegistry
 * - Syncs each platform with independent Redis locks (failure isolation)
 * - Triggers infrastructure assessment after sync
 * - Tracks per-platform sync health
 */

import { prisma } from '../index';
import { logger } from './observabilityService';
import { getActiveAdaptersForOrg } from '../adapters/platformRegistry';
import * as auditLogService from './auditLogService';
import { acquireLock, releaseLock } from '../utils/redis';

// ============================================================================
// TYPES
// ============================================================================

interface WorkerStatus {
    lastRunAt: Date | null;
    lastError: string | null;
    totalSyncs: number;
    totalOrganizationsSynced: number;
    lastSyncDurationMs: number;
    consecutiveFailures: number;
}

interface PlatformSyncResult {
    platform: string;
    organizationId: string;
    organizationName: string;
    success: boolean;
    campaigns: number;
    mailboxes: number;
    leads: number;
    error?: string;
    durationMs: number;
}

// ============================================================================
// STATE
// ============================================================================

let workerInterval: NodeJS.Timeout | null = null;
let workerStatus: WorkerStatus = {
    lastRunAt: null,
    lastError: null,
    totalSyncs: 0,
    totalOrganizationsSynced: 0,
    lastSyncDurationMs: 0,
    consecutiveFailures: 0,
};

// Run every 20 minutes (1200000ms)
const SYNC_INTERVAL_MS = 20 * 60 * 1000;

// Maximum consecutive failures before alerting
const MAX_CONSECUTIVE_FAILURES = 3;

// ============================================================================
// WORKER LIFECYCLE
// ============================================================================

/**
 * Start the platform sync worker.
 * Runs the first sync after 2 minutes (server warmup), then every 20 minutes.
 */
export function startPlatformSyncWorker(): void {
    if (workerInterval) {
        logger.warn('[PLATFORM-SYNC-WORKER] Worker already running');
        return;
    }

    // First run after 2 minutes (let the server warm up)
    setTimeout(runSync, 2 * 60 * 1000);

    // Then every 20 minutes
    workerInterval = setInterval(runSync, SYNC_INTERVAL_MS);

    logger.info('[PLATFORM-SYNC-WORKER] Started (20min interval, first run in 2min)');
}

/**
 * Stop the platform sync worker.
 */
export function stopPlatformSyncWorker(): void {
    if (workerInterval) {
        clearInterval(workerInterval);
        workerInterval = null;
        logger.info('[PLATFORM-SYNC-WORKER] Stopped');
    }
}

/**
 * Get worker status for health checks.
 */
export function getPlatformSyncWorkerStatus(): WorkerStatus {
    return { ...workerStatus };
}

// Legacy aliases for backward compat
export const startSmartleadSyncWorker = startPlatformSyncWorker;
export const stopSmartleadSyncWorker = stopPlatformSyncWorker;
export const getSmartleadSyncWorkerStatus = getPlatformSyncWorkerStatus;

// ============================================================================
// SYNC LOGIC
// ============================================================================

/**
 * Run a full sync cycle for all organizations across all configured platforms.
 */
async function runSync(): Promise<void> {
    const lockKey = 'worker:lock:platform_sync';
    const acquired = await acquireLock(lockKey, 20 * 60); // 20 mins TTL

    if (!acquired) {
        logger.info('[PLATFORM-SYNC-WORKER] Sync already in progress by another instance. Skipping.');
        return;
    }

    const startTime = Date.now();
    logger.info('[PLATFORM-SYNC-WORKER] Starting sync cycle');

    try {
        // Get all organizations (we'll discover their platforms dynamically)
        const organizations = await prisma.organization.findMany({
            where: {
                subscription_status: {
                    notIn: ['expired', 'past_due', 'canceled']
                }
            },
            select: {
                id: true,
                name: true,
                subscription_status: true,
            },
        });

        if (organizations.length === 0) {
            logger.info('[PLATFORM-SYNC-WORKER] No active organizations found, skipping sync');
            workerStatus = {
                lastRunAt: new Date(),
                lastError: null,
                totalSyncs: workerStatus.totalSyncs + 1,
                totalOrganizationsSynced: workerStatus.totalOrganizationsSynced,
                lastSyncDurationMs: Date.now() - startTime,
                consecutiveFailures: 0,
            };
            return;
        }

        const results: PlatformSyncResult[] = [];
        let orgsWithPlatforms = 0;

        // Sync each organization
        for (const org of organizations) {
            const orgId = org.id;
            const orgName = org.name;

            // Discover all configured platforms for this org
            const adapters = await getActiveAdaptersForOrg(orgId);

            if (adapters.length === 0) {
                continue; // No platforms configured for this org
            }

            orgsWithPlatforms++;

            // Sync each platform independently (failure isolation)
            for (const { adapter } of adapters) {
                const platformLockKey = `worker:lock:sync:${orgId}:${adapter.platform}`;
                const platformLockAcquired = await acquireLock(platformLockKey, 10 * 60); // 10 min TTL per platform

                if (!platformLockAcquired) {
                    logger.info(`[PLATFORM-SYNC-WORKER] ${adapter.platform} sync for ${orgId} already in progress, skipping`);
                    continue;
                }

                const platformSyncStart = Date.now();

                try {
                    logger.info(`[PLATFORM-SYNC-WORKER] Syncing ${adapter.platform} for ${orgName}`, {
                        organizationId: orgId,
                        platform: adapter.platform,
                    });

                    const syncResult = await adapter.sync(orgId);
                    const durationMs = Date.now() - platformSyncStart;

                    results.push({
                        platform: adapter.platform,
                        organizationId: orgId,
                        organizationName: orgName,
                        success: true,
                        campaigns: syncResult.campaigns,
                        mailboxes: syncResult.mailboxes,
                        leads: syncResult.leads,
                        durationMs,
                    });

                    logger.info(`[PLATFORM-SYNC-WORKER] Successfully synced ${adapter.platform} for ${orgName}`, {
                        organizationId: orgId,
                        platform: adapter.platform,
                        campaigns: syncResult.campaigns,
                        mailboxes: syncResult.mailboxes,
                        leads: syncResult.leads,
                        durationMs,
                    });

                    // Small delay between platform syncs to be respectful to APIs
                    await new Promise((resolve) => setTimeout(resolve, 2000));

                } catch (error: any) {
                    const durationMs = Date.now() - platformSyncStart;

                    logger.error(`[PLATFORM-SYNC-WORKER] Failed to sync ${adapter.platform} for ${orgName}`, error, {
                        organizationId: orgId,
                        platform: adapter.platform,
                        durationMs,
                    });

                    results.push({
                        platform: adapter.platform,
                        organizationId: orgId,
                        organizationName: orgName,
                        success: false,
                        campaigns: 0,
                        mailboxes: 0,
                        leads: 0,
                        error: error.message,
                        durationMs,
                    });

                    // Log audit event for failed sync
                    await auditLogService.logAction({
                        organizationId: orgId,
                        entity: 'system',
                        trigger: 'automatic_sync',
                        action: `${adapter.platform}_sync_failed`,
                        details: `Automated ${adapter.platform} sync failed: ${error.message}`,
                    });
                } finally {
                    await releaseLock(platformLockKey);
                }
            }
        }

        // Calculate summary
        const successCount = results.filter((r) => r.success).length;
        const failureCount = results.filter((r) => !r.success).length;
        const totalCampaigns = results.reduce((sum, r) => sum + r.campaigns, 0);
        const totalMailboxes = results.reduce((sum, r) => sum + r.mailboxes, 0);
        const totalLeads = results.reduce((sum, r) => sum + r.leads, 0);
        const totalDurationMs = Date.now() - startTime;

        // Update worker status
        workerStatus = {
            lastRunAt: new Date(),
            lastError: failureCount > 0 ? `${failureCount} platform syncs failed` : null,
            totalSyncs: workerStatus.totalSyncs + 1,
            totalOrganizationsSynced: workerStatus.totalOrganizationsSynced + orgsWithPlatforms,
            lastSyncDurationMs: totalDurationMs,
            consecutiveFailures: results.length > 0 && successCount === 0
                ? workerStatus.consecutiveFailures + 1
                : 0,
        };

        logger.info('[PLATFORM-SYNC-WORKER] Sync cycle complete', {
            totalOrganizations: orgsWithPlatforms,
            totalPlatformSyncs: results.length,
            successCount,
            failureCount,
            totalCampaigns,
            totalMailboxes,
            totalLeads,
            durationMs: totalDurationMs,
        });

        // Alert if too many consecutive failures
        if (workerStatus.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            logger.error('[PLATFORM-SYNC-WORKER] CRITICAL: Too many consecutive sync failures', new Error('Too many consecutive failures'), {
                consecutiveFailures: workerStatus.consecutiveFailures,
                maxAllowed: MAX_CONSECUTIVE_FAILURES,
            });
        }
    } catch (error: any) {
        workerStatus.lastError = error.message;
        workerStatus.lastRunAt = new Date();
        workerStatus.consecutiveFailures++;
        workerStatus.lastSyncDurationMs = Date.now() - startTime;

        logger.error('[PLATFORM-SYNC-WORKER] Sync cycle failed', error);
    } finally {
        await releaseLock('worker:lock:platform_sync');
    }
}

/**
 * Manually trigger a sync cycle (for testing or manual refresh).
 */
export async function triggerManualSync(): Promise<WorkerStatus> {
    logger.info('[PLATFORM-SYNC-WORKER] Manual sync triggered');
    await runSync();
    return getPlatformSyncWorkerStatus();
}
