/**
 * Trial Worker
 *
 * Background worker that monitors trial expirations and sends notifications.
 * Runs on an hourly schedule to:
 * - Send 3-day warning notifications
 * - Expire trials that have ended
 * - Clean up expired trial organizations
 */

import { prisma } from '../index';
import { logger } from './observabilityService';
import * as notificationService from './notificationService';
import * as auditLogService from './auditLogService';

// ============================================================================
// CONSTANTS
// ============================================================================

const WARNING_DAYS = 3; // Send warning when 3 days remain
const CHECK_INTERVAL_MS = 60 * 60 * 1000; // Run every hour

// ============================================================================
// TRIAL WORKER
// ============================================================================

let workerInterval: NodeJS.Timeout | null = null;

/**
 * Start the trial expiration worker.
 */
export function startTrialWorker(): void {
    if (workerInterval) {
        logger.warn('[TRIAL-WORKER] Worker already running');
        return;
    }

    logger.info('[TRIAL-WORKER] Starting trial expiration worker');

    // Run immediately on startup
    runTrialCheck().catch(error => {
        logger.error('[TRIAL-WORKER] Initial check failed', error instanceof Error ? error : new Error(String(error)));
    });

    // Then run on interval
    workerInterval = setInterval(async () => {
        try {
            await runTrialCheck();
        } catch (error) {
            logger.error('[TRIAL-WORKER] Check cycle failed', error instanceof Error ? error : new Error(String(error)));
        }
    }, CHECK_INTERVAL_MS);

    logger.info('[TRIAL-WORKER] Worker started successfully');
}

/**
 * Stop the trial expiration worker.
 */
export function stopTrialWorker(): void {
    if (workerInterval) {
        clearInterval(workerInterval);
        workerInterval = null;
        logger.info('[TRIAL-WORKER] Worker stopped');
    }
}

/**
 * Run a single trial expiration check cycle.
 */
async function runTrialCheck(): Promise<void> {
    logger.info('[TRIAL-WORKER] Running trial expiration check');

    const now = new Date();
    const warningThreshold = new Date(now.getTime() + WARNING_DAYS * 24 * 60 * 60 * 1000);

    // Find trials expiring soon (3-day warning)
    await sendExpirationWarnings(warningThreshold);

    // Find expired trials
    await expireTrials(now);

    logger.info('[TRIAL-WORKER] Check cycle completed');
}

// ============================================================================
// EXPIRATION WARNINGS
// ============================================================================

/**
 * Send warnings to organizations whose trials are expiring soon.
 */
async function sendExpirationWarnings(warningThreshold: Date): Promise<void> {
    const orgsNeedingWarning = await prisma.organization.findMany({
        where: {
            subscription_status: 'trialing',
            trial_ends_at: {
                lte: warningThreshold,
                gt: new Date() // Not yet expired
            }
        },
        select: {
            id: true,
            name: true,
            trial_ends_at: true,
            notifications: {
                where: {
                    type: 'WARNING',
                    title: 'Trial Expiring Soon',
                    created_at: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } // Last 24 hours
                },
                take: 1
            }
        }
    });

    logger.info(`[TRIAL-WORKER] Found ${orgsNeedingWarning.length} organizations needing warnings`);

    for (const org of orgsNeedingWarning) {
        // Skip if already sent warning in last 24 hours
        if (org.notifications.length > 0) {
            continue;
        }

        const daysRemaining = Math.ceil(
            (org.trial_ends_at!.getTime() - Date.now()) / (24 * 60 * 60 * 1000)
        );

        try {
            await notificationService.createNotification(org.id, {
                type: 'WARNING',
                title: 'Trial Expiring Soon',
                message: `Your trial expires in ${daysRemaining} day${daysRemaining !== 1 ? 's' : ''}. Upgrade now to continue using Superkabe without interruption.`
            });

            await auditLogService.logAction({
                organizationId: org.id,
                entity: 'subscription',
                entityId: org.id,
                trigger: 'trial_worker',
                action: 'warning_sent',
                details: `Trial expiration warning sent (${daysRemaining} days remaining)`
            });

            logger.info(`[TRIAL-WORKER] Sent warning to ${org.name} (${org.id})`);
        } catch (error) {
            logger.error(`[TRIAL-WORKER] Failed to send warning to ${org.id}`, error instanceof Error ? error : new Error(String(error)));
        }
    }
}

// ============================================================================
// TRIAL EXPIRATION
// ============================================================================

/**
 * Expire trials that have ended.
 */
async function expireTrials(now: Date): Promise<void> {
    const expiredOrgs = await prisma.organization.findMany({
        where: {
            subscription_status: 'trialing',
            trial_ends_at: { lte: now }
        },
        select: {
            id: true,
            name: true,
            trial_ends_at: true
        }
    });

    logger.info(`[TRIAL-WORKER] Found ${expiredOrgs.length} expired trials`);

    for (const org of expiredOrgs) {
        try {
            await prisma.organization.update({
                where: { id: org.id },
                data: {
                    subscription_status: 'expired',
                    subscription_tier: 'free' // Downgrade to free tier (blocks all operations)
                }
            });

            await notificationService.createNotification(org.id, {
                type: 'ERROR',
                title: 'Trial Expired',
                message: 'Your trial has ended. Upgrade to a paid plan to continue using Superkabe.'
            });

            await auditLogService.logAction({
                organizationId: org.id,
                entity: 'subscription',
                entityId: org.id,
                trigger: 'trial_worker',
                action: 'expired',
                details: 'Trial expired automatically'
            });

            logger.info(`[TRIAL-WORKER] Expired trial for ${org.name} (${org.id})`);
        } catch (error) {
            logger.error(`[TRIAL-WORKER] Failed to expire trial for ${org.id}`, error instanceof Error ? error : new Error(String(error)));
        }
    }
}

// ============================================================================
// MANUAL TRIAL MANAGEMENT
// ============================================================================

/**
 * Extend a trial by a specified number of days.
 * Useful for customer support scenarios.
 */
export async function extendTrial(orgId: string, additionalDays: number): Promise<void> {
    const org = await prisma.organization.findUnique({
        where: { id: orgId },
        select: { trial_ends_at: true, subscription_status: true }
    });

    if (!org) {
        throw new Error(`Organization not found: ${orgId}`);
    }

    if (org.subscription_status !== 'trialing' && org.subscription_status !== 'expired') {
        throw new Error('Cannot extend trial for non-trial organizations');
    }

    const currentEndDate = org.trial_ends_at || new Date();
    const newEndDate = new Date(currentEndDate.getTime() + additionalDays * 24 * 60 * 60 * 1000);

    await prisma.organization.update({
        where: { id: orgId },
        data: {
            trial_ends_at: newEndDate,
            subscription_status: 'trialing' // Reactivate if expired
        }
    });

    await auditLogService.logAction({
        organizationId: orgId,
        entity: 'subscription',
        entityId: orgId,
        trigger: 'manual',
        action: 'trial_extended',
        details: `Trial extended by ${additionalDays} days`
    });

    logger.info(`[TRIAL-WORKER] Extended trial for ${orgId} by ${additionalDays} days`);
}
