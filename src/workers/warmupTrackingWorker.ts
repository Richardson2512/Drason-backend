/**
 * Warmup Tracking Worker
 *
 * Periodically checks warmup progress for recovering mailboxes
 * and auto-graduates them through recovery phases.
 *
 * Run frequency: Every 24 hours (or can be triggered manually)
 */

import { prisma } from '../index';
import { logger } from '../services/observabilityService';
import * as warmupService from '../services/warmupService';
import * as healingService from '../services/healingService';
import { RecoveryPhase } from '../types';

/**
 * Main warmup tracking function.
 * Checks all mailboxes in recovery phases and auto-graduates when criteria met.
 */
export const checkWarmupProgress = async (): Promise<{
    checked: number;
    graduated: number;
    errors: number;
}> => {
    logger.info('[WARMUP-WORKER] Starting warmup progress check');

    let checked = 0;
    let graduated = 0;
    let errors = 0;

    try {
        // Get all mailboxes in recovery phases with warmup enabled
        const recoveringMailboxes = await prisma.mailbox.findMany({
            where: {
                recovery_phase: {
                    in: [RecoveryPhase.RESTRICTED_SEND, RecoveryPhase.WARM_RECOVERY]
                },
                smartlead_email_account_id: {
                    not: null
                }
            },
            select: {
                id: true,
                email: true,
                organization_id: true,
                recovery_phase: true,
                consecutive_pauses: true,
                smartlead_email_account_id: true
            }
        });

        logger.info('[WARMUP-WORKER] Found mailboxes in recovery', {
            total: recoveringMailboxes.length,
            restricted: recoveringMailboxes.filter(m => m.recovery_phase === RecoveryPhase.RESTRICTED_SEND).length,
            warmRecovery: recoveringMailboxes.filter(m => m.recovery_phase === RecoveryPhase.WARM_RECOVERY).length
        });

        // Check each mailbox for graduation criteria
        for (const mailbox of recoveringMailboxes) {
            try {
                checked++;

                const result = await warmupService.checkGraduationCriteria(mailbox.id);

                logger.info('[WARMUP-WORKER] Checked graduation criteria', {
                    mailboxId: mailbox.id,
                    mailboxEmail: mailbox.email,
                    recoveryPhase: mailbox.recovery_phase,
                    currentSends: result.currentSends,
                    targetSends: result.targetSends,
                    daysInPhase: result.daysInPhase,
                    readyForGraduation: result.readyForGraduation,
                    reason: result.reason
                });

                // Auto-graduate if criteria met
                if (result.readyForGraduation) {
                    const nextPhase = mailbox.recovery_phase === RecoveryPhase.RESTRICTED_SEND
                        ? RecoveryPhase.WARM_RECOVERY
                        : RecoveryPhase.HEALTHY;

                    logger.info('[WARMUP-WORKER] Auto-graduating mailbox', {
                        mailboxId: mailbox.id,
                        mailboxEmail: mailbox.email,
                        fromPhase: mailbox.recovery_phase,
                        toPhase: nextPhase,
                        reason: result.reason
                    });

                    await healingService.transitionPhase(
                        'mailbox',
                        mailbox.id,
                        mailbox.organization_id,
                        mailbox.recovery_phase as RecoveryPhase,
                        nextPhase,
                        `Auto-graduated by warmup worker: ${result.reason}`,
                        mailbox.resilience_score || 50
                    );

                    graduated++;
                }

            } catch (mailboxError: any) {
                errors++;
                logger.error('[WARMUP-WORKER] Error checking mailbox', mailboxError, {
                    mailboxId: mailbox.id,
                    mailboxEmail: mailbox.email
                });
            }
        }

        logger.info('[WARMUP-WORKER] Warmup progress check completed', {
            checked,
            graduated,
            errors
        });

        return { checked, graduated, errors };

    } catch (error: any) {
        logger.error('[WARMUP-WORKER] Warmup worker failed', error);
        throw error;
    }
};

/**
 * Schedule warmup tracking worker to run daily.
 * Call this function on server startup.
 */
export const scheduleWarmupTracking = (): NodeJS.Timeout => {
    const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;

    logger.info('[WARMUP-WORKER] Scheduling warmup tracking (every 24 hours)');

    // Run immediately on startup
    checkWarmupProgress().catch(error => {
        logger.error('[WARMUP-WORKER] Initial run failed', error);
    });

    // Then run every 24 hours
    const interval = setInterval(() => {
        checkWarmupProgress().catch(error => {
            logger.error('[WARMUP-WORKER] Scheduled run failed', error);
        });
    }, TWENTY_FOUR_HOURS);

    return interval;
};

/**
 * Get warmup status summary for dashboard display.
 */
export const getWarmupStatusSummary = async (
    organizationId: string
): Promise<{
    totalRecovering: number;
    restrictedSend: number;
    warmRecovery: number;
    avgDaysInRecovery: number;
    estimatedGraduations: Array<{
        mailboxId: string;
        mailboxEmail: string;
        recoveryPhase: string;
        currentProgress: number;
        targetProgress: number;
        estimatedDays: number;
    }>;
}> => {
    const recoveringMailboxes = await prisma.mailbox.findMany({
        where: {
            organization_id: organizationId,
            recovery_phase: {
                in: [RecoveryPhase.RESTRICTED_SEND, RecoveryPhase.WARM_RECOVERY]
            },
            smartlead_email_account_id: {
                not: null
            }
        },
        select: {
            id: true,
            email: true,
            recovery_phase: true,
            phase_entered_at: true,
            smartlead_email_account_id: true
        }
    });

    const estimatedGraduations = [];

    for (const mailbox of recoveringMailboxes) {
        try {
            const result = await warmupService.checkGraduationCriteria(mailbox.id);

            const remaining = result.targetSends - result.currentSends;
            const warmupPerDay = mailbox.recovery_phase === RecoveryPhase.RESTRICTED_SEND ? 10 : 50;
            const estimatedDays = Math.ceil(remaining / warmupPerDay);

            estimatedGraduations.push({
                mailboxId: mailbox.id,
                mailboxEmail: mailbox.email,
                recoveryPhase: mailbox.recovery_phase,
                currentProgress: result.currentSends,
                targetProgress: result.targetSends,
                estimatedDays
            });
        } catch (error: any) {
            logger.error('[WARMUP-WORKER] Failed to get graduation estimate', error, {
                mailboxId: mailbox.id
            });
        }
    }

    // Calculate average days in recovery
    const totalDays = recoveringMailboxes.reduce((sum, m) => {
        if (m.phase_entered_at) {
            const days = Math.floor((Date.now() - m.phase_entered_at.getTime()) / (1000 * 60 * 60 * 24));
            return sum + days;
        }
        return sum;
    }, 0);

    const avgDaysInRecovery = recoveringMailboxes.length > 0
        ? Math.round(totalDays / recoveringMailboxes.length)
        : 0;

    return {
        totalRecovering: recoveringMailboxes.length,
        restrictedSend: recoveringMailboxes.filter(m => m.recovery_phase === RecoveryPhase.RESTRICTED_SEND).length,
        warmRecovery: recoveringMailboxes.filter(m => m.recovery_phase === RecoveryPhase.WARM_RECOVERY).length,
        avgDaysInRecovery,
        estimatedGraduations
    };
};
