/**
 * Warmup Service
 *
 * Manages Smartlead warmup integration for automated mailbox recovery.
 * Warmup is used instead of healing campaigns for simpler, more effective recovery.
 */

import { prisma } from '../index';
import { logger } from './observabilityService';
import * as smartleadClient from './smartleadClient';
import * as notificationService from './notificationService';
import { RecoveryPhase } from '../types';

/**
 * Warmup configuration for each recovery phase
 */
const WARMUP_CONFIG = {
    [RecoveryPhase.RESTRICTED_SEND]: {
        total_warmup_per_day: 10,       // Conservative start
        daily_rampup: 0,                 // Flat volume (no increase)
        reply_rate_percentage: 30,       // Target 30% engagement
        targetSends: 15,                 // First offense requirement
        targetSendsRepeat: 25            // Repeat offense requirement
    },
    [RecoveryPhase.WARM_RECOVERY]: {
        total_warmup_per_day: 50,        // Higher volume
        daily_rampup: 5,                 // Increase 5 emails/day
        reply_rate_percentage: 40,       // Target 40% engagement
        targetSends: 50,                 // Clean send requirement
        minDays: 3                       // Minimum 3 days in phase
    }
};

/**
 * Enable warmup for a mailbox entering recovery phase.
 *
 * @param organizationId - Organization ID
 * @param mailboxId - Mailbox ID
 * @param recoveryPhase - Current recovery phase (restricted_send or warm_recovery)
 */
export const enableWarmupForRecovery = async (
    organizationId: string,
    mailboxId: string,
    recoveryPhase: RecoveryPhase
): Promise<{
    success: boolean;
    warmupEnabled: boolean;
}> => {
    try {
        // Get mailbox with Smartlead email account ID
        const mailbox = await prisma.mailbox.findUnique({
            where: { id: mailboxId },
            select: {
                email: true,
                smartlead_email_account_id: true,
                consecutive_pauses: true
            }
        });

        if (!mailbox) {
            throw new Error(`Mailbox ${mailboxId} not found`);
        }

        if (!mailbox.smartlead_email_account_id) {
            logger.warn('[WARMUP] Cannot enable warmup - no Smartlead email account ID', {
                organizationId,
                mailboxId,
                mailboxEmail: mailbox.email
            });
            return { success: false, warmupEnabled: false };
        }

        // Get warmup config for this phase
        const config = WARMUP_CONFIG[recoveryPhase];
        if (!config) {
            throw new Error(`Invalid recovery phase: ${recoveryPhase}`);
        }

        logger.info('[WARMUP] Enabling warmup for recovery', {
            organizationId,
            mailboxId,
            mailboxEmail: mailbox.email,
            recoveryPhase,
            warmupPerDay: config.total_warmup_per_day,
            dailyRampup: config.daily_rampup
        });

        // Enable warmup via Smartlead API
        const result = await smartleadClient.updateMailboxWarmup(
            organizationId,
            mailbox.smartlead_email_account_id,
            {
                warmup_enabled: true,
                total_warmup_per_day: config.total_warmup_per_day,
                daily_rampup: config.daily_rampup,
                reply_rate_percentage: config.reply_rate_percentage
            }
        );

        // Reset phase tracking counters
        await prisma.mailbox.update({
            where: { id: mailboxId },
            data: {
                phase_clean_sends: 0,
                phase_bounces: 0,
                phase_entered_at: new Date()
            }
        });

        // Notify user
        const targetSends = mailbox.consecutive_pauses && mailbox.consecutive_pauses > 1
            ? config.targetSendsRepeat || config.targetSends
            : config.targetSends;

        await notificationService.createNotification(organizationId, {
            type: 'INFO',
            title: 'Automated Recovery Started',
            message: `Warmup enabled for ${mailbox.email}. System will automatically send ${targetSends} clean emails via Smartlead's warmup network at ${config.total_warmup_per_day}/day.`
        });

        logger.info('[WARMUP] Successfully enabled warmup', {
            organizationId,
            mailboxId,
            warmupKey: result.warmupKey,
            recoveryPhase
        });

        return {
            success: true,
            warmupEnabled: true
        };

    } catch (error: any) {
        logger.error('[WARMUP] Failed to enable warmup', error, {
            organizationId,
            mailboxId,
            recoveryPhase
        });
        return {
            success: false,
            warmupEnabled: false
        };
    }
};

/**
 * Update warmup volume when mailbox progresses to next recovery phase.
 */
export const updateWarmupForPhaseTransition = async (
    organizationId: string,
    mailboxId: string,
    newPhase: RecoveryPhase
): Promise<{
    success: boolean;
}> => {
    try {
        const mailbox = await prisma.mailbox.findUnique({
            where: { id: mailboxId },
            select: {
                email: true,
                smartlead_email_account_id: true
            }
        });

        if (!mailbox || !mailbox.smartlead_email_account_id) {
            logger.warn('[WARMUP] Cannot update warmup - mailbox or email account ID not found', {
                organizationId,
                mailboxId
            });
            return { success: false };
        }

        const config = WARMUP_CONFIG[newPhase];
        if (!config) {
            logger.warn('[WARMUP] Invalid phase for warmup update', {
                organizationId,
                mailboxId,
                newPhase
            });
            return { success: false };
        }

        logger.info('[WARMUP] Updating warmup for phase transition', {
            organizationId,
            mailboxId,
            mailboxEmail: mailbox.email,
            newPhase,
            newWarmupPerDay: config.total_warmup_per_day,
            newDailyRampup: config.daily_rampup
        });

        // Update warmup settings
        await smartleadClient.updateMailboxWarmup(
            organizationId,
            mailbox.smartlead_email_account_id,
            {
                warmup_enabled: true,
                total_warmup_per_day: config.total_warmup_per_day,
                daily_rampup: config.daily_rampup,
                reply_rate_percentage: config.reply_rate_percentage
            }
        );

        // Reset phase tracking
        await prisma.mailbox.update({
            where: { id: mailboxId },
            data: {
                phase_clean_sends: 0,
                phase_bounces: 0,
                phase_entered_at: new Date()
            }
        });

        await notificationService.createNotification(organizationId, {
            type: 'SUCCESS',
            title: 'Recovery Progressing',
            message: `${mailbox.email} moved to ${newPhase}. Warmup increased to ${config.total_warmup_per_day}/day.`
        });

        logger.info('[WARMUP] Successfully updated warmup', {
            organizationId,
            mailboxId,
            newPhase
        });

        return { success: true };

    } catch (error: any) {
        logger.error('[WARMUP] Failed to update warmup', error, {
            organizationId,
            mailboxId,
            newPhase
        });
        return { success: false };
    }
};

/**
 * Disable warmup when mailbox reaches HEALTHY phase.
 * Option to keep warmup active at low volume for maintenance.
 */
export const disableWarmup = async (
    organizationId: string,
    mailboxId: string,
    keepMaintenanceWarmup: boolean = false
): Promise<{
    success: boolean;
}> => {
    try {
        const mailbox = await prisma.mailbox.findUnique({
            where: { id: mailboxId },
            select: {
                email: true,
                smartlead_email_account_id: true
            }
        });

        if (!mailbox || !mailbox.smartlead_email_account_id) {
            logger.warn('[WARMUP] Cannot disable warmup - mailbox or email account ID not found', {
                organizationId,
                mailboxId
            });
            return { success: false };
        }

        logger.info('[WARMUP] Disabling warmup after recovery', {
            organizationId,
            mailboxId,
            mailboxEmail: mailbox.email,
            keepMaintenance: keepMaintenanceWarmup
        });

        if (keepMaintenanceWarmup) {
            // Keep low-volume warmup for ongoing maintenance
            await smartleadClient.updateMailboxWarmup(
                organizationId,
                mailbox.smartlead_email_account_id,
                {
                    warmup_enabled: true,
                    total_warmup_per_day: 10,
                    daily_rampup: 0,
                    reply_rate_percentage: 30
                }
            );

            logger.info('[WARMUP] Switched to maintenance warmup (10/day)', {
                organizationId,
                mailboxId
            });
        } else {
            // Fully disable warmup
            await smartleadClient.updateMailboxWarmup(
                organizationId,
                mailbox.smartlead_email_account_id,
                {
                    warmup_enabled: false
                }
            );

            logger.info('[WARMUP] Warmup fully disabled', {
                organizationId,
                mailboxId
            });
        }

        return { success: true };

    } catch (error: any) {
        logger.error('[WARMUP] Failed to disable warmup', error, {
            organizationId,
            mailboxId
        });
        return { success: false };
    }
};

/**
 * Check if mailbox is ready to graduate based on warmup progress.
 * Called by warmup tracking worker.
 */
export const checkGraduationCriteria = async (
    mailboxId: string
): Promise<{
    readyForGraduation: boolean;
    currentSends: number;
    targetSends: number;
    daysInPhase: number;
    reason?: string;
}> => {
    const mailbox = await prisma.mailbox.findUnique({
        where: { id: mailboxId },
        select: {
            recovery_phase: true,
            phase_clean_sends: true,
            phase_bounces: true,
            phase_entered_at: true,
            consecutive_pauses: true,
            smartlead_email_account_id: true,
            organization_id: true
        }
    });

    if (!mailbox || !mailbox.smartlead_email_account_id) {
        return {
            readyForGraduation: false,
            currentSends: 0,
            targetSends: 0,
            daysInPhase: 0,
            reason: 'Mailbox or email account ID not found'
        };
    }

    // Get warmup stats from Smartlead
    const stats = await smartleadClient.getEmailAccountDetails(
        mailbox.organization_id,
        mailbox.smartlead_email_account_id
    );

    const totalSent = stats.warmup_details.total_sent_count;
    const totalSpam = stats.warmup_details.total_spam_count;
    const warmupReputation = stats.warmup_details.warmup_reputation;

    // Calculate days in current phase
    const daysInPhase = mailbox.phase_entered_at
        ? Math.floor((Date.now() - mailbox.phase_entered_at.getTime()) / (1000 * 60 * 60 * 24))
        : 0;

    // Check graduation criteria based on phase
    if (mailbox.recovery_phase === RecoveryPhase.RESTRICTED_SEND) {
        const config = WARMUP_CONFIG[RecoveryPhase.RESTRICTED_SEND];
        const targetSends = mailbox.consecutive_pauses && mailbox.consecutive_pauses > 1
            ? (config.targetSendsRepeat || 25)
            : (config.targetSends || 15);

        const readyForGraduation = totalSent >= targetSends && totalSpam === 0;

        return {
            readyForGraduation,
            currentSends: totalSent,
            targetSends,
            daysInPhase,
            reason: readyForGraduation
                ? `Met criteria: ${totalSent} sends, 0 spam, ${warmupReputation} reputation`
                : `Need ${targetSends - totalSent} more sends (0 spam tolerance)`
        };

    } else if (mailbox.recovery_phase === RecoveryPhase.WARM_RECOVERY) {
        const config = WARMUP_CONFIG[RecoveryPhase.WARM_RECOVERY];
        const minDays = config.minDays || 3;
        const targetSends = config.targetSends || 50;
        const readyForGraduation =
            totalSent >= targetSends &&
            totalSpam === 0 &&
            daysInPhase >= minDays;

        return {
            readyForGraduation,
            currentSends: totalSent,
            targetSends,
            daysInPhase,
            reason: readyForGraduation
                ? `Met criteria: ${totalSent} sends, 0 spam, ${daysInPhase} days, ${warmupReputation} reputation`
                : `Need: ${Math.max(0, targetSends - totalSent)} more sends, ${Math.max(0, minDays - daysInPhase)} more days`
        };
    }

    return {
        readyForGraduation: false,
        currentSends: totalSent,
        targetSends: 0,
        daysInPhase,
        reason: 'Not in recovery phase'
    };
};
