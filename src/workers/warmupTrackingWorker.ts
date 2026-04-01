/**
 * Warmup Tracking Worker
 *
 * Periodically checks warmup progress for recovering mailboxes
 * and auto-graduates them through recovery phases.
 *
 * Run frequency: Every 4 hours (or can be triggered manually)
 */

import { prisma } from '../index';
import { logger } from '../services/observabilityService';
import * as warmupService from '../services/warmupService';
import * as healingService from '../services/healingService';
import { RecoveryPhase } from '../types';

/**
 * Main healing/warmup tracking function.
 * Manages the FULL 5-phase healing pipeline for all mailboxes AND domains:
 *
 *   QUARANTINE → RESTRICTED_SEND → WARM_RECOVERY → HEALTHY
 *
 * Phase-specific graduation criteria:
 *   - QUARANTINE → RESTRICTED_SEND: DNS/blacklist checks pass (healingService)
 *   - RESTRICTED_SEND → WARM_RECOVERY: N clean sends, 0 bounces (warmupService)
 *   - WARM_RECOVERY → HEALTHY: M sends over K days below threshold (warmupService)
 *
 * Note: PAUSED → QUARANTINE is handled by metricsWorker (cooldown expiry check).
 */
export const checkWarmupProgress = async (orgId?: string): Promise<{
    checked: number;
    graduated: number;
    errors: number;
}> => {
    logger.info('[WARMUP-WORKER] Starting healing pipeline check', { orgId: orgId || 'all' });

    let checked = 0;
    let graduated = 0;
    let errors = 0;

    try {
        // ── MAILBOX HEALING: All phases ──────────────────────────────────

        // Phase 1: QUARANTINE mailboxes — check DNS/blacklist for promotion to RESTRICTED_SEND
        const quarantinedMailboxes = await prisma.mailbox.findMany({
            where: {
                recovery_phase: RecoveryPhase.QUARANTINE,
                status: 'quarantine',
                ...(orgId ? { organization_id: orgId } : {}),
            },
            select: {
                id: true,
                email: true,
                organization_id: true,
                recovery_phase: true,
                resilience_score: true,
                healing_origin: true,
                consecutive_pauses: true,
                domain_id: true
            }
        });

        // Phase 2+3: RESTRICTED_SEND and WARM_RECOVERY — check send counts for graduation
        const warmupMailboxes = await prisma.mailbox.findMany({
            where: {
                recovery_phase: {
                    in: [RecoveryPhase.RESTRICTED_SEND, RecoveryPhase.WARM_RECOVERY]
                },
                external_email_account_id: {
                    not: null
                },
                ...(orgId ? { organization_id: orgId } : {}),
            },
            select: {
                id: true,
                email: true,
                organization_id: true,
                recovery_phase: true,
                consecutive_pauses: true,
                external_email_account_id: true,
                resilience_score: true
            }
        });

        logger.info('[WARMUP-WORKER] Found mailboxes in healing pipeline', {
            quarantine: quarantinedMailboxes.length,
            restricted: warmupMailboxes.filter(m => m.recovery_phase === RecoveryPhase.RESTRICTED_SEND).length,
            warmRecovery: warmupMailboxes.filter(m => m.recovery_phase === RecoveryPhase.WARM_RECOVERY).length,
            total: quarantinedMailboxes.length + warmupMailboxes.length
        });

        // ── Process QUARANTINE mailboxes (DNS/blacklist gate) ──
        for (const mailbox of quarantinedMailboxes) {
            try {
                checked++;
                const result = await healingService.checkMailboxGraduation(mailbox.id);

                if (result && result.transitioned) {
                    graduated++;
                    logger.info('[WARMUP-WORKER] Mailbox graduated from QUARANTINE', {
                        mailboxId: mailbox.id,
                        mailboxEmail: mailbox.email,
                        toPhase: result.toPhase,
                        reason: result.reason
                    });
                } else {
                    logger.debug('[WARMUP-WORKER] Mailbox remains in QUARANTINE (DNS not ready)', {
                        mailboxId: mailbox.id,
                        mailboxEmail: mailbox.email
                    });
                }
            } catch (mailboxError: any) {
                errors++;
                logger.error('[WARMUP-WORKER] Error checking quarantine mailbox', mailboxError, {
                    mailboxId: mailbox.id
                });
            }
        }

        // ── Process RESTRICTED_SEND + WARM_RECOVERY mailboxes (send count gate) ──
        for (const mailbox of warmupMailboxes) {
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

        // ── DOMAIN HEALING: QUARANTINE → RESTRICTED_SEND → WARM_RECOVERY → HEALTHY ──
        const recoveringDomains = await prisma.domain.findMany({
            where: {
                recovery_phase: {
                    in: [RecoveryPhase.QUARANTINE, RecoveryPhase.RESTRICTED_SEND, RecoveryPhase.WARM_RECOVERY]
                }
            },
            select: {
                id: true,
                domain: true,
                organization_id: true,
                recovery_phase: true,
                resilience_score: true,
                spf_valid: true,
                dkim_valid: true,
                blacklist_results: true,
                clean_sends_since_phase: true,
                phase_entered_at: true,
                healing_origin: true,
                consecutive_pauses: true
            }
        });

        if (recoveringDomains.length > 0) {
            logger.info('[WARMUP-WORKER] Found domains in healing pipeline', {
                total: recoveringDomains.length,
                quarantine: recoveringDomains.filter(d => d.recovery_phase === RecoveryPhase.QUARANTINE).length,
                restricted: recoveringDomains.filter(d => d.recovery_phase === RecoveryPhase.RESTRICTED_SEND).length,
                warmRecovery: recoveringDomains.filter(d => d.recovery_phase === RecoveryPhase.WARM_RECOVERY).length
            });
        }

        for (const domain of recoveringDomains) {
            try {
                checked++;
                const domainResult = await checkDomainGraduation(domain);

                if (domainResult) {
                    graduated++;
                    logger.info('[WARMUP-WORKER] Domain graduated', {
                        domainId: domain.id,
                        domainName: domain.domain,
                        fromPhase: domainResult.fromPhase,
                        toPhase: domainResult.toPhase,
                        reason: domainResult.reason
                    });
                }
            } catch (domainError: any) {
                errors++;
                logger.error('[WARMUP-WORKER] Error checking domain', domainError, {
                    domainId: domain.id
                });
            }
        }

        logger.info('[WARMUP-WORKER] Healing pipeline check completed', {
            checked,
            graduated,
            errors
        });

        return { checked, graduated, errors };

    } catch (error: any) {
        logger.error('[WARMUP-WORKER] Healing worker failed', error);
        throw error;
    }
};

/**
 * Check if a domain should graduate to the next recovery phase.
 * Domain graduation criteria:
 *   - QUARANTINE → RESTRICTED_SEND: SPF+DKIM valid, no blacklistings
 *   - RESTRICTED_SEND → WARM_RECOVERY: All child mailboxes past restricted phase
 *   - WARM_RECOVERY → HEALTHY: All child mailboxes healthy, sustained period
 */
async function checkDomainGraduation(domain: {
    id: string;
    domain: string;
    organization_id: string;
    recovery_phase: string;
    resilience_score: number | null;
    spf_valid: boolean | null;
    dkim_valid: boolean | null;
    blacklist_results: any;
    clean_sends_since_phase: number;
    phase_entered_at: Date | null;
    healing_origin: string | null;
    consecutive_pauses: number;
}): Promise<{ fromPhase: string; toPhase: string; reason: string } | null> {
    const phase = domain.recovery_phase as RecoveryPhase;

    if (phase === RecoveryPhase.QUARANTINE) {
        // DNS must be healthy: SPF + DKIM valid, no blacklists
        const dnsHealthy = domain.spf_valid === true
            && domain.dkim_valid === true
            && !isBlacklisted(domain.blacklist_results);

        if (!dnsHealthy) return null;

        const result = await healingService.transitionPhase(
            'domain', domain.id, domain.organization_id,
            RecoveryPhase.QUARANTINE, RecoveryPhase.RESTRICTED_SEND,
            'DNS checks passed — domain entering restricted send mode',
            domain.resilience_score || 50
        );
        return result.transitioned ? { fromPhase: 'quarantine', toPhase: 'restricted_send', reason: result.reason } : null;
    }

    if (phase === RecoveryPhase.RESTRICTED_SEND) {
        // All child mailboxes must be past the restricted phase (warm_recovery or healthy)
        const childMailboxes = await prisma.mailbox.findMany({
            where: { domain_id: domain.id },
            select: { recovery_phase: true, status: true }
        });

        if (childMailboxes.length === 0) return null;

        const allPastRestricted = childMailboxes.every(m =>
            m.recovery_phase === RecoveryPhase.WARM_RECOVERY ||
            m.recovery_phase === RecoveryPhase.HEALTHY ||
            m.status === 'healthy'
        );

        if (!allPastRestricted) return null;

        const result = await healingService.transitionPhase(
            'domain', domain.id, domain.organization_id,
            RecoveryPhase.RESTRICTED_SEND, RecoveryPhase.WARM_RECOVERY,
            `All ${childMailboxes.length} child mailboxes past restricted phase — domain entering warm recovery`,
            domain.resilience_score || 50
        );
        return result.transitioned ? { fromPhase: 'restricted_send', toPhase: 'warm_recovery', reason: result.reason } : null;
    }

    if (phase === RecoveryPhase.WARM_RECOVERY) {
        // All child mailboxes must be healthy + minimum time in phase
        const childMailboxes = await prisma.mailbox.findMany({
            where: { domain_id: domain.id },
            select: { status: true, recovery_phase: true }
        });

        if (childMailboxes.length === 0) return null;

        const allHealthy = childMailboxes.every(m =>
            m.status === 'healthy' && m.recovery_phase === RecoveryPhase.HEALTHY
        );

        if (!allHealthy) return null;

        // Minimum 3 days in warm recovery
        const minDaysMs = 3 * 86400000;
        if (domain.phase_entered_at) {
            const timeInPhase = Date.now() - domain.phase_entered_at.getTime();
            if (timeInPhase < minDaysMs) return null;
        }

        const result = await healingService.transitionPhase(
            'domain', domain.id, domain.organization_id,
            RecoveryPhase.WARM_RECOVERY, RecoveryPhase.HEALTHY,
            `All child mailboxes healthy for 3+ days — domain fully recovered`,
            domain.resilience_score || 50
        );
        return result.transitioned ? { fromPhase: 'warm_recovery', toPhase: 'healthy', reason: result.reason } : null;
    }

    return null;
}

/**
 * Check if any blacklist result is CONFIRMED (listed).
 */
function isBlacklisted(blacklistResults: any): boolean {
    if (!blacklistResults || typeof blacklistResults !== 'object') return false;
    return Object.values(blacklistResults).some((result) => result === 'CONFIRMED');
}

/**
 * Schedule warmup tracking worker to run daily.
 * Call this function on server startup.
 */
export const scheduleWarmupTracking = (): NodeJS.Timeout => {
    const RUN_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours

    logger.info('[WARMUP-WORKER] Scheduling warmup tracking (every 4 hours)');

    // Run immediately on startup
    checkWarmupProgress().catch(error => {
        logger.error('[WARMUP-WORKER] Initial run failed', error);
    });

    // Then run every 4 hours
    const interval = setInterval(() => {
        checkWarmupProgress().catch(error => {
            logger.error('[WARMUP-WORKER] Scheduled run failed', error);
        });
    }, RUN_INTERVAL_MS);

    return interval;
};

/**
 * Get warmup status summary for dashboard display.
 */
export const getWarmupStatusSummary = async (
    organizationId: string
): Promise<{
    totalRecovering: number;
    quarantine: number;
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
                in: [RecoveryPhase.QUARANTINE, RecoveryPhase.RESTRICTED_SEND, RecoveryPhase.WARM_RECOVERY]
            }
        },
        select: {
            id: true,
            email: true,
            recovery_phase: true,
            phase_entered_at: true,
            external_email_account_id: true
        }
    });

    const estimatedGraduations = [];

    for (const mailbox of recoveringMailboxes) {
        try {
            if (mailbox.recovery_phase === RecoveryPhase.QUARANTINE) {
                // Quarantine graduation depends on DNS, not send count — show as "waiting for DNS"
                const daysInPhase = mailbox.phase_entered_at
                    ? Math.floor((Date.now() - mailbox.phase_entered_at.getTime()) / (1000 * 60 * 60 * 24))
                    : 0;
                estimatedGraduations.push({
                    mailboxId: mailbox.id,
                    mailboxEmail: mailbox.email,
                    recoveryPhase: mailbox.recovery_phase,
                    currentProgress: 0,
                    targetProgress: 1,  // DNS check pass = 1
                    estimatedDays: daysInPhase < 1 ? 1 : 0  // At least 1 day if just entered
                });
                continue;
            }

            if (!mailbox.external_email_account_id) continue;

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
        quarantine: recoveringMailboxes.filter(m => m.recovery_phase === RecoveryPhase.QUARANTINE).length,
        restrictedSend: recoveringMailboxes.filter(m => m.recovery_phase === RecoveryPhase.RESTRICTED_SEND).length,
        warmRecovery: recoveringMailboxes.filter(m => m.recovery_phase === RecoveryPhase.WARM_RECOVERY).length,
        avgDaysInRecovery,
        estimatedGraduations
    };
};
