/**
 * Warmup Service
 *
 * Manages warmup-phase tracking for automated mailbox recovery during the
 * 5-phase healing pipeline. Native sending uses SendEvent and BounceEvent
 * counts directly — no upstream platform API.
 *
 * Volume control: this service writes Mailbox.warmup_limit during recovery.
 * The dispatcher (sendQueueService) honors warmup_limit > 0 as a per-mailbox
 * daily cap (smaller of warmup_limit and ConnectedAccount.daily_send_limit
 * wins). The execution gate (executionGateService) honors the same field
 * for lead-admission decisions. On graduation, warmup_limit is set back to 0
 * which restores the normal cap.
 *
 * KNOWN GAP — active engagement: in the previous platform-driven flow,
 * Smartlead/Lemwarm/Instantly's warmup networks sent synthetic engagement
 * emails (auto-opens, auto-replies, mark-not-spam) that ACTIVELY rebuilt
 * sender reputation during recovery. With native sending, no such network
 * exists. The replacement is reading authoritative reputation data from
 * Google Postmaster Tools, Microsoft SNDS, and ARF feedback loops (see
 * docs/middleware-removal/03-new-build-specs.md). Until those ship,
 * recovery is "wait it out under reduced volume" without an active
 * reputation-rebuild leg. Phase tracking + auto-pause + volume throttling
 * still work; reputation regeneration is slower than the platform path was.
 */

import { prisma } from '../index';
import { logger } from './observabilityService';
import * as notificationService from './notificationService';
import { RecoveryPhase, GRADUATION_CRITERIA, MONITORING_THRESHOLDS } from '../types';

/**
 * Native equivalent of the platform's `getMailboxDetails(..)` — counts real
 * SendEvent and BounceEvent rows for this mailbox. Returns the same shape
 * the rest of this service expects.
 */
async function getMailboxNativeStats(mailboxId: string): Promise<{
    dailySentCount: number;
    spamCount: number;
    warmupSentCount: number;
    warmupSpamCount: number;
    warmupReputation: string;
    warmupEnabled: boolean;
}> {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [sent, bounced] = await Promise.all([
        prisma.sendEvent.count({ where: { mailbox_id: mailboxId, sent_at: { gte: since } } }),
        prisma.bounceEvent.count({ where: { mailbox_id: mailboxId, bounced_at: { gte: since } } }),
    ]);
    return {
        dailySentCount: sent,
        spamCount: bounced,
        warmupSentCount: 0,
        warmupSpamCount: 0,
        warmupReputation: '—',
        warmupEnabled: false,
    };
}

/**
 * Warmup configuration for each recovery phase
 */
const WARMUP_CONFIG: Record<RecoveryPhase.RESTRICTED_SEND | RecoveryPhase.WARM_RECOVERY, {
    total_warmup_per_day: number;
    daily_rampup: number;
    reply_rate_percentage: number;
    targetSends?: number;
    targetSendsRepeat?: number;
    minDays?: number;
}> = {
    [RecoveryPhase.RESTRICTED_SEND]: {
        total_warmup_per_day: 10,       // Conservative start
        daily_rampup: 0,                 // Flat volume (no increase)
        reply_rate_percentage: 30,       // Target 30% engagement
        targetSends: 15,                 // First offense requirement
        targetSendsRepeat: 25            // Repeat offense requirement
    },
    [RecoveryPhase.WARM_RECOVERY]: {
        total_warmup_per_day: 50,        // Higher volume — aligns with SendGrid/AWS SES post-warmup baselines
        daily_rampup: 5,                 // Increase 5 emails/day
        reply_rate_percentage: 40,       // Target 40% engagement
        targetSends: 50,                 // Clean send requirement
        minDays: 7                       // Minimum 7 days in phase — Microsoft reputation lag
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
        // Get mailbox with external account ID
        const mailbox = await prisma.mailbox.findUnique({
            where: { id: mailboxId },
            select: {
                email: true,
                                consecutive_pauses: true
            }
        });

        if (!mailbox) {
            throw new Error(`Mailbox ${mailboxId} not found`);
        }

        // Get warmup config for this phase
        const config = WARMUP_CONFIG[recoveryPhase as RecoveryPhase.RESTRICTED_SEND | RecoveryPhase.WARM_RECOVERY];
        if (!config) {
            throw new Error(`Invalid recovery phase for warmup: ${recoveryPhase}`);
        }

        // Native sending — use real SendEvent / BounceEvent counts as the
        // baseline. Volume during recovery is controlled by lowering
        // Mailbox.daily_send_limit; the dispatcher honors that cap.
        const stats = await getMailboxNativeStats(mailboxId);
        const baselineSends = stats.dailySentCount;
        const baselineSpam = stats.spamCount;

        logger.info('[WARMUP] Entering recovery phase', {
            organizationId,
            mailboxId,
            mailboxEmail: mailbox.email,
            recoveryPhase,
            warmupPerDay: config.total_warmup_per_day,
            dailyRampup: config.daily_rampup
        });

        await prisma.mailbox.update({
            where: { id: mailboxId },
            data: {
                phase_clean_sends: baselineSends,
                phase_bounces: baselineSpam,
                phase_entered_at: new Date(),
                warmup_limit: config.total_warmup_per_day
            }
        });
        const result: any = { ok: true };

        // Notify user
        const targetSends = mailbox.consecutive_pauses && mailbox.consecutive_pauses > 1
            ? config.targetSendsRepeat || config.targetSends
            : config.targetSends;

        await notificationService.createNotification(organizationId, {
            type: 'INFO',
            title: 'Automated Recovery Started',
            message: `Warmup enabled for ${mailbox.email}. System will automatically send ${targetSends} clean emails via warmup network at ${config.total_warmup_per_day}/day.`
        });

        logger.info('[WARMUP] Successfully enabled warmup', {
            organizationId,
            mailboxId,
            ok: result.ok,
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
                            }
        });

        if (!mailbox) {
            logger.warn('[WARMUP] Cannot update warmup - mailbox not found', {
                organizationId,
                mailboxId
            });
            return { success: false };
        }

        const config = WARMUP_CONFIG[newPhase as RecoveryPhase.RESTRICTED_SEND | RecoveryPhase.WARM_RECOVERY];
        if (!config) {
            logger.warn('[WARMUP] Invalid phase for warmup update', {
                organizationId,
                mailboxId,
                newPhase
            });
            return { success: false };
        }

        // Native sending — fresh baseline from SendEvent / BounceEvent counts.
        const stats = await getMailboxNativeStats(mailboxId);
        const baselineSends = stats.dailySentCount;
        const baselineSpam = stats.spamCount;

        logger.info('[WARMUP] Updating warmup for phase transition', {
            organizationId,
            mailboxId,
            mailboxEmail: mailbox.email,
            newPhase,
            newWarmupPerDay: config.total_warmup_per_day,
            newDailyRampup: config.daily_rampup
        });

        await prisma.mailbox.update({
            where: { id: mailboxId },
            data: {
                phase_clean_sends: baselineSends,
                phase_bounces: baselineSpam,
                phase_entered_at: new Date(),
                warmup_limit: config.total_warmup_per_day
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
                            }
        });

        if (!mailbox) {
            logger.warn('[WARMUP] Cannot disable warmup - mailbox not found', {
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

        // Native sending — graduating to HEALTHY removes the warmup-imposed
        // volume cap on the Mailbox. The dispatcher then sends at the
        // ConnectedAccount's daily_send_limit instead of warmup_limit.
        await prisma.mailbox.update({
            where: { id: mailboxId },
            data: {
                warmup_limit: keepMaintenanceWarmup ? 10 : 0
            }
        });

        logger.info(
            keepMaintenanceWarmup
                ? '[WARMUP] Switched to maintenance volume (10/day)'
                : '[WARMUP] Warmup volume cap lifted',
            { organizationId, mailboxId }
        );

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
            manual_intervention_required: true,
            domain_id: true,
            organization_id: true
        }
    });

    if (!mailbox) {
        return {
            readyForGraduation: false,
            currentSends: 0,
            targetSends: 0,
            daysInPhase: 0,
            reason: 'Mailbox not found'
        };
    }

    // Manual intervention gate — block graduation when an operator must review
    if (mailbox.manual_intervention_required) {
        return {
            readyForGraduation: false,
            currentSends: 0,
            targetSends: 0,
            daysInPhase: 0,
            reason: 'Manual intervention required — graduation blocked until operator clears flag'
        };
    }

    // Native sending — graduation is computed from real SendEvent /
    // BounceEvent counts since phase_entered_at, comparing against the
    // baselines stored when the mailbox entered this phase.
    const phaseStart = mailbox.phase_entered_at || new Date(0);
    const [phaseSends, phaseBounces] = await Promise.all([
        prisma.sendEvent.count({ where: { mailbox_id: mailboxId, sent_at: { gte: phaseStart } } }),
        prisma.bounceEvent.count({ where: { mailbox_id: mailboxId, bounced_at: { gte: phaseStart }, bounce_type: 'hard_bounce' } }),
    ]);
    const totalSent = phaseSends;
    const totalSpam = phaseBounces;
    const warmupReputation = '—';

    // Calculate days in current phase
    const daysInPhase = mailbox.phase_entered_at
        ? Math.floor((Date.now() - mailbox.phase_entered_at.getTime()) / (1000 * 60 * 60 * 24))
        : 0;

    const isRepeat = (mailbox.consecutive_pauses || 0) > 1;

    // Check graduation criteria based on phase
    if (mailbox.recovery_phase === RecoveryPhase.RESTRICTED_SEND) {
        const config = WARMUP_CONFIG[RecoveryPhase.RESTRICTED_SEND];
        const targetSends = isRepeat
            ? (config.targetSendsRepeat || 25)
            : (config.targetSends || 15);

        // Time floor — prevents same-day burst graduation. Anchored in Spamhaus
        // 2-4 week guidance + Microsoft reputation-lag patterns.
        const minDays = isRepeat
            ? GRADUATION_CRITERIA.restricted_to_warm.repeatMinDays
            : GRADUATION_CRITERIA.restricted_to_warm.firstOffenseMinDays;

        const readyForGraduation =
            totalSent >= targetSends &&
            totalSpam === 0 &&
            daysInPhase >= minDays;

        const reasonParts: string[] = [];
        if (totalSent < targetSends) reasonParts.push(`${targetSends - totalSent} more sends`);
        if (totalSpam > 0) reasonParts.push('hard bounce — relapse path will fire');
        if (daysInPhase < minDays) reasonParts.push(`${minDays - daysInPhase} more days`);

        return {
            readyForGraduation,
            currentSends: totalSent,
            targetSends,
            daysInPhase,
            reason: readyForGraduation
                ? `Met criteria: ${totalSent} sends, 0 hard bounces, ${daysInPhase} days, ${warmupReputation} reputation`
                : `Need: ${reasonParts.join(', ')}`
        };

    } else if (mailbox.recovery_phase === RecoveryPhase.WARM_RECOVERY) {
        const targetSends = GRADUATION_CRITERIA.warm_to_healthy.minSends;
        const minDays = isRepeat
            ? GRADUATION_CRITERIA.warm_to_healthy.repeatMinDays
            : GRADUATION_CRITERIA.warm_to_healthy.firstOffenseMinDays;

        // Bounce-rate gate (industry standard: <2%)
        const bounceRate = totalSent > 0 ? totalSpam / totalSent : 0;
        const bounceRateOk = bounceRate <= GRADUATION_CRITERIA.warm_to_healthy.maxBounceRate;

        // Complaint-rate gate (Gmail/Yahoo: <0.1% target). Read DomainReputation
        // (populated by postmasterToolsWorker) for the domain's spam_rate. Only
        // applies once the domain has accumulated enough lifetime sends to be
        // statistically meaningful (per COMPLAINT_RATE_MIN_SENDS).
        let complaintRateOk = true;
        let complaintRate: number | null = null;
        if (mailbox.domain_id) {
            const domain = await prisma.domain.findUnique({
                where: { id: mailbox.domain_id },
                select: { total_sent_lifetime: true }
            });
            if (domain && domain.total_sent_lifetime >= MONITORING_THRESHOLDS.COMPLAINT_RATE_MIN_SENDS) {
                const latestRep = await prisma.domainReputation.findFirst({
                    where: { domain_id: mailbox.domain_id, spam_rate: { not: null } },
                    orderBy: { date: 'desc' },
                    select: { spam_rate: true }
                });
                if (latestRep?.spam_rate != null) {
                    complaintRate = latestRep.spam_rate;
                    complaintRateOk = complaintRate <= GRADUATION_CRITERIA.warm_to_healthy.maxComplaintRate;
                }
            }
        }

        const readyForGraduation =
            totalSent >= targetSends &&
            daysInPhase >= minDays &&
            bounceRateOk &&
            complaintRateOk;

        const reasonParts: string[] = [];
        if (totalSent < targetSends) reasonParts.push(`${targetSends - totalSent} more sends`);
        if (daysInPhase < minDays) reasonParts.push(`${minDays - daysInPhase} more days`);
        if (!bounceRateOk) reasonParts.push(`bounce rate ${(bounceRate * 100).toFixed(2)}% > 2%`);
        if (!complaintRateOk && complaintRate != null) reasonParts.push(`complaint rate ${(complaintRate * 100).toFixed(2)}% > 0.1%`);

        return {
            readyForGraduation,
            currentSends: totalSent,
            targetSends,
            daysInPhase,
            reason: readyForGraduation
                ? `Met criteria: ${totalSent} sends, ${(bounceRate * 100).toFixed(2)}% bounce rate, ${daysInPhase} days`
                : `Need: ${reasonParts.join(', ')}`
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
