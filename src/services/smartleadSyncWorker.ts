/**
 * Smartlead Sync Worker
 *
 * Automatically syncs campaigns, mailboxes, and leads from Smartlead every 20 minutes.
 * Essential for 24/7 infrastructure monitoring and auto-healing capabilities.
 *
 * Key features:
 * - Runs every 20 minutes to keep data fresh
 * - Syncs all organizations with Smartlead API keys
 * - Triggers infrastructure assessment after each sync
 * - Monitors sync health and tracks failures
 * - Enables real-time health degradation detection
 */

import { prisma } from '../index';
import { logger } from './observabilityService';
import * as smartleadClient from './smartleadClient';
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

interface SyncResult {
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
 * Start the Smartlead sync worker.
 * Runs the first sync after 2 minutes (server warmup), then every 20 minutes.
 */
export function startSmartleadSyncWorker(): void {
    if (workerInterval) {
        logger.warn('[SMARTLEAD-SYNC-WORKER] Worker already running');
        return;
    }

    // First run after 2 minutes (let the server warm up and other workers initialize)
    setTimeout(runSync, 2 * 60 * 1000);

    // Then every 20 minutes
    workerInterval = setInterval(runSync, SYNC_INTERVAL_MS);

    logger.info('[SMARTLEAD-SYNC-WORKER] Started (20min interval, first run in 2min)');
}

/**
 * Stop the Smartlead sync worker.
 */
export function stopSmartleadSyncWorker(): void {
    if (workerInterval) {
        clearInterval(workerInterval);
        workerInterval = null;
        logger.info('[SMARTLEAD-SYNC-WORKER] Stopped');
    }
}

/**
 * Get worker status for health checks.
 */
export function getSmartleadSyncWorkerStatus(): WorkerStatus {
    return { ...workerStatus };
}

// ============================================================================
// SYNC LOGIC
// ============================================================================

/**
 * Run a full sync cycle for all organizations with Smartlead configured.
 */
async function runSync(): Promise<void> {
    const lockKey = 'worker:lock:smartlead_sync';
    const acquired = await acquireLock(lockKey, 20 * 60); // 20 mins TTL

    if (!acquired) {
        logger.info('[SMARTLEAD-SYNC-WORKER] Sync already in progress by another instance. Skipping.');
        return;
    }

    const startTime = Date.now();
    logger.info('[SMARTLEAD-SYNC-WORKER] Starting sync cycle');

    try {
        // Get all organizations that have Smartlead API keys configured
        const orgsWithSmartlead = await prisma.organizationSetting.findMany({
            where: {
                key: 'SMARTLEAD_API_KEY',
                NOT: {
                    value: ''
                }
            },
            include: {
                organization: {
                    select: {
                        name: true,
                        subscription_status: true,
                    },
                },
            },
        });

        if (orgsWithSmartlead.length === 0) {
            logger.info('[SMARTLEAD-SYNC-WORKER] No organizations with Smartlead configured, skipping sync');
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

        logger.info('[SMARTLEAD-SYNC-WORKER] Found organizations with Smartlead', {
            count: orgsWithSmartlead.length,
        });

        const results: SyncResult[] = [];

        // Sync each organization sequentially (avoid overwhelming Smartlead API)
        for (const orgSetting of orgsWithSmartlead) {
            const orgId = orgSetting.organization_id;
            const orgName = orgSetting.organization.name;
            const subscriptionStatus = orgSetting.organization.subscription_status;

            // Skip organizations with blocked subscription statuses
            const blockedStatuses = ['expired', 'past_due', 'canceled'];
            if (blockedStatuses.includes(subscriptionStatus)) {
                logger.info('[SMARTLEAD-SYNC-WORKER] Skipping org with blocked subscription', {
                    organizationId: orgId,
                    organizationName: orgName,
                    status: subscriptionStatus,
                });
                results.push({
                    organizationId: orgId,
                    organizationName: orgName,
                    success: false,
                    campaigns: 0,
                    mailboxes: 0,
                    leads: 0,
                    error: `Subscription ${subscriptionStatus}`,
                    durationMs: 0,
                });
                continue;
            }

            const orgSyncStart = Date.now();

            try {
                logger.info('[SMARTLEAD-SYNC-WORKER] Syncing organization', {
                    organizationId: orgId,
                    organizationName: orgName,
                });

                const syncResult = await smartleadClient.syncSmartlead(orgId);

                const orgSyncDuration = Date.now() - orgSyncStart;

                results.push({
                    organizationId: orgId,
                    organizationName: orgName,
                    success: true,
                    campaigns: syncResult.campaigns,
                    mailboxes: syncResult.mailboxes,
                    leads: syncResult.leads,
                    durationMs: orgSyncDuration,
                });

                logger.info('[SMARTLEAD-SYNC-WORKER] Successfully synced organization', {
                    organizationId: orgId,
                    organizationName: orgName,
                    campaigns: syncResult.campaigns,
                    mailboxes: syncResult.mailboxes,
                    leads: syncResult.leads,
                    durationMs: orgSyncDuration,
                });

                // Small delay between organizations to be respectful to Smartlead API
                await new Promise((resolve) => setTimeout(resolve, 2000));
            } catch (error: any) {
                const orgSyncDuration = Date.now() - orgSyncStart;

                logger.error('[SMARTLEAD-SYNC-WORKER] Failed to sync organization', error, {
                    organizationId: orgId,
                    organizationName: orgName,
                    durationMs: orgSyncDuration,
                });

                results.push({
                    organizationId: orgId,
                    organizationName: orgName,
                    success: false,
                    campaigns: 0,
                    mailboxes: 0,
                    leads: 0,
                    error: error.message,
                    durationMs: orgSyncDuration,
                });

                // Log audit event for failed sync
                await auditLogService.logAction({
                    organizationId: orgId,
                    entity: 'system',
                    trigger: 'automatic_sync',
                    action: 'smartlead_sync_failed',
                    details: `Automated sync failed: ${error.message}`,
                });
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
            lastError: failureCount > 0 ? `${failureCount} organizations failed` : null,
            totalSyncs: workerStatus.totalSyncs + 1,
            totalOrganizationsSynced: workerStatus.totalOrganizationsSynced + successCount,
            lastSyncDurationMs: totalDurationMs,
            consecutiveFailures: failureCount === orgsWithSmartlead.length ? workerStatus.consecutiveFailures + 1 : 0,
        };

        logger.info('[SMARTLEAD-SYNC-WORKER] Sync cycle complete', {
            totalOrganizations: orgsWithSmartlead.length,
            successCount,
            failureCount,
            totalCampaigns,
            totalMailboxes,
            totalLeads,
            durationMs: totalDurationMs,
        });

        // Alert if too many consecutive failures
        if (workerStatus.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            logger.error('[SMARTLEAD-SYNC-WORKER] CRITICAL: Too many consecutive sync failures', new Error('Too many consecutive failures'), {
                consecutiveFailures: workerStatus.consecutiveFailures,
                maxAllowed: MAX_CONSECUTIVE_FAILURES,
            });
        }
    } catch (error: any) {
        workerStatus.lastError = error.message;
        workerStatus.lastRunAt = new Date();
        workerStatus.consecutiveFailures++;
        workerStatus.lastSyncDurationMs = Date.now() - startTime;

        logger.error('[SMARTLEAD-SYNC-WORKER] Sync cycle failed', error);
    } finally {
        await releaseLock('worker:lock:smartlead_sync');
    }
}

/**
 * Manually trigger a sync cycle (for testing or manual refresh).
 */
export async function triggerManualSync(): Promise<WorkerStatus> {
    logger.info('[SMARTLEAD-SYNC-WORKER] Manual sync triggered');
    await runSync();
    return getSmartleadSyncWorkerStatus();
}
