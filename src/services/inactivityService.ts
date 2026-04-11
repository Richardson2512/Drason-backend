/**
 * Inactivity & Recovery Intelligence Service (Layer 7)
 *
 * 1. Inactivity Watchdog — detects domains/mailboxes that have gone cold (30+ days inactive)
 * 2. Recovery Timeline Estimator — predicts recovery duration based on damage severity
 * 3. Provider Volume Caps — enforces Gmail/Microsoft/Yahoo daily sending limits
 */

import { prisma } from '../index';
import * as entityStateService from './entityStateService';
import * as notificationService from './notificationService';
import * as auditLogService from './auditLogService';
import logger from '../utils/logger';
import { RecoveryPhase, TriggerType, MailboxState } from '../types';

// ─── Constants ──────────────────────────────────────────────────────────────

/** Domains/mailboxes with no sends for this many days are flagged as cold */
const INACTIVITY_THRESHOLD_DAYS = 30;

/** Provider daily sending limits (conservative — below actual limits for safety margin) */
const PROVIDER_VOLUME_CAPS: Record<string, { dailyLimit: number; label: string }> = {
    google_workspace: { dailyLimit: 1800, label: 'Google Workspace' },     // Actual: 2000, 10% safety margin
    google_free: { dailyLimit: 400, label: 'Gmail (Free)' },               // Actual: 500
    microsoft_365: { dailyLimit: 9000, label: 'Microsoft 365' },           // Actual: 10000 recipients
    outlook_free: { dailyLimit: 250, label: 'Outlook.com (Free)' },        // Actual: 300
    yahoo: { dailyLimit: 400, label: 'Yahoo Mail' },                       // Actual: ~500
    unknown: { dailyLimit: 500, label: 'Unknown Provider' },               // Conservative default
};

/** Recovery timeline estimates (in days) by damage severity */
const RECOVERY_ESTIMATES = {
    minor: { minDays: 14, maxDays: 28, label: 'Minor', description: 'Single bounce spike or brief listing on minor blacklist' },
    moderate: { minDays: 42, maxDays: 84, label: 'Moderate', description: 'Sustained high bounce rate, major blacklist listing, or complaint spike' },
    severe: { minDays: 90, maxDays: 180, label: 'Severe', description: 'Multiple blacklist listings, sustained complaints, or repeated relapses' },
    critical: { minDays: 180, maxDays: 365, label: 'Critical', description: 'Domain-wide reputation damage across multiple ISPs' },
};

// ─── Inactivity Watchdog ────────────────────────────────────────────────────

export interface InactivityReport {
    coldMailboxes: Array<{ id: string; email: string; lastActivityAt: Date; daysSinceActivity: number }>;
    coldDomains: Array<{ id: string; domain: string; lastSentAt: Date | null; daysSinceActivity: number }>;
    totalColdMailboxes: number;
    totalColdDomains: number;
}

/**
 * Check for inactive mailboxes and domains that need re-warmup.
 * Called by metricsWorker on each cycle.
 */
export async function checkInactivity(organizationId: string): Promise<InactivityReport> {
    const thresholdDate = new Date();
    thresholdDate.setDate(thresholdDate.getDate() - INACTIVITY_THRESHOLD_DAYS);

    // Find mailboxes with no activity in 30+ days that are still "healthy"
    const coldMailboxes = await prisma.mailbox.findMany({
        where: {
            organization_id: organizationId,
            status: 'healthy',
            recovery_phase: 'healthy',
            last_activity_at: { lt: thresholdDate },
        },
        select: { id: true, email: true, last_activity_at: true },
    });

    // Find domains with no sends in 30+ days that are still "healthy"
    const coldDomains = await prisma.domain.findMany({
        where: {
            organization_id: organizationId,
            status: 'healthy',
            OR: [
                { last_sent_at: { lt: thresholdDate } },
                { last_sent_at: null, created_at: { lt: thresholdDate } },
            ],
        },
        select: { id: true, domain: true, last_sent_at: true, created_at: true },
    });

    const now = new Date();
    const report: InactivityReport = {
        coldMailboxes: coldMailboxes.map(mb => ({
            id: mb.id,
            email: mb.email,
            lastActivityAt: mb.last_activity_at,
            daysSinceActivity: Math.floor((now.getTime() - mb.last_activity_at.getTime()) / (1000 * 60 * 60 * 24)),
        })),
        coldDomains: coldDomains.map(d => {
            const lastDate = d.last_sent_at || d.created_at;
            return {
                id: d.id,
                domain: d.domain,
                lastSentAt: d.last_sent_at,
                daysSinceActivity: Math.floor((now.getTime() - lastDate.getTime()) / (1000 * 60 * 60 * 24)),
            };
        }),
        totalColdMailboxes: coldMailboxes.length,
        totalColdDomains: coldDomains.length,
    };

    if (report.totalColdMailboxes > 0 || report.totalColdDomains > 0) {
        logger.info('[INACTIVITY] Cold entities detected', {
            organizationId,
            coldMailboxes: report.totalColdMailboxes,
            coldDomains: report.totalColdDomains,
        });
    }

    return report;
}

/**
 * Flag cold entities and create notifications.
 * Transitions cold mailboxes to restricted_send (warmup required before full sends).
 */
export async function flagColdEntities(
    organizationId: string,
    report: InactivityReport,
    systemMode: string
): Promise<void> {
    if (report.totalColdMailboxes === 0 && report.totalColdDomains === 0) return;

    // Notify about cold entities
    if (report.totalColdMailboxes > 0) {
        const emailList = report.coldMailboxes.slice(0, 5).map(m => m.email).join(', ');
        const suffix = report.totalColdMailboxes > 5 ? ` and ${report.totalColdMailboxes - 5} more` : '';

        await notificationService.createNotification(organizationId, {
            type: 'WARNING',
            title: 'Inactive Mailboxes Detected',
            message: `${report.totalColdMailboxes} mailbox(es) have had no activity for 30+ days and need re-warmup before sending: ${emailList}${suffix}`,
        });
    }

    if (report.totalColdDomains > 0) {
        const domainList = report.coldDomains.slice(0, 5).map(d => d.domain).join(', ');
        const suffix = report.totalColdDomains > 5 ? ` and ${report.totalColdDomains - 5} more` : '';

        await notificationService.createNotification(organizationId, {
            type: 'WARNING',
            title: 'Inactive Domains Detected',
            message: `${report.totalColdDomains} domain(s) have had no sends for 30+ days and are considered cold: ${domainList}${suffix}. Mailboxes under these domains need re-warmup.`,
        });
    }

    // In ENFORCE mode, transition cold mailboxes to restricted_send (requires warmup)
    if (systemMode === 'enforce') {
        for (const mb of report.coldMailboxes) {
            try {
                await entityStateService.transitionMailbox(
                    organizationId,
                    mb.id,
                    MailboxState.WARNING,
                    `Inactive for ${mb.daysSinceActivity} days — needs re-warmup before resuming full sends`,
                    TriggerType.SYSTEM
                );

                await auditLogService.logAction({
                    organizationId,
                    entity: 'mailbox',
                    entityId: mb.id,
                    trigger: 'inactivity_watchdog',
                    action: 'cold_detected',
                    details: `Mailbox ${mb.email} inactive for ${mb.daysSinceActivity} days. Flagged for re-warmup.`,
                });
            } catch (err: any) {
                logger.warn('[INACTIVITY] Failed to flag cold mailbox', {
                    mailboxId: mb.id,
                    error: err?.message,
                });
            }
        }
    }
}

// ─── Recovery Timeline Estimator ────────────────────────────────────────────

export interface RecoveryEstimate {
    severity: 'minor' | 'moderate' | 'severe' | 'critical';
    label: string;
    description: string;
    estimatedMinDays: number;
    estimatedMaxDays: number;
    estimatedRecoveryDate: { earliest: Date; latest: Date };
    factors: string[];
}

/**
 * Estimate recovery timeline for a mailbox or domain based on current damage signals.
 */
export function estimateRecoveryTimeline(entity: {
    resilience_score: number;
    consecutive_pauses: number;
    relapse_count: number;
    recovery_phase: string;
    phase_entered_at: Date | null;
    blacklist_score?: number;
}): RecoveryEstimate {
    const factors: string[] = [];
    let severityScore = 0;

    // Factor 1: Resilience score
    if (entity.resilience_score <= 20) {
        severityScore += 3;
        factors.push(`Very low resilience score (${entity.resilience_score}/100)`);
    } else if (entity.resilience_score <= 40) {
        severityScore += 2;
        factors.push(`Low resilience score (${entity.resilience_score}/100)`);
    } else if (entity.resilience_score <= 60) {
        severityScore += 1;
        factors.push(`Moderate resilience score (${entity.resilience_score}/100)`);
    }

    // Factor 2: Consecutive pauses (relapse indicator)
    if (entity.consecutive_pauses >= 3) {
        severityScore += 3;
        factors.push(`${entity.consecutive_pauses} consecutive pauses (repeated failures)`);
    } else if (entity.consecutive_pauses >= 2) {
        severityScore += 2;
        factors.push(`${entity.consecutive_pauses} consecutive pauses`);
    } else if (entity.consecutive_pauses >= 1) {
        severityScore += 1;
        factors.push('1 previous pause');
    }

    // Factor 3: Total relapses
    if (entity.relapse_count >= 3) {
        severityScore += 3;
        factors.push(`${entity.relapse_count} total relapses (chronic instability)`);
    } else if (entity.relapse_count >= 1) {
        severityScore += 1;
        factors.push(`${entity.relapse_count} relapse(s)`);
    }

    // Factor 4: Current phase depth
    if (entity.recovery_phase === 'paused') {
        severityScore += 1;
        factors.push('Currently paused');
    } else if (entity.recovery_phase === 'quarantine') {
        severityScore += 2;
        factors.push('In quarantine (requires DNS pass)');
    }

    // Factor 5: Blacklist penalty (if available)
    if (entity.blacklist_score !== undefined && entity.blacklist_score < -30) {
        severityScore += 2;
        factors.push(`High blacklist penalty (${entity.blacklist_score})`);
    } else if (entity.blacklist_score !== undefined && entity.blacklist_score < -10) {
        severityScore += 1;
        factors.push(`Moderate blacklist penalty (${entity.blacklist_score})`);
    }

    // Map score to severity
    let severity: RecoveryEstimate['severity'];
    if (severityScore >= 8) severity = 'critical';
    else if (severityScore >= 5) severity = 'severe';
    else if (severityScore >= 3) severity = 'moderate';
    else severity = 'minor';

    const estimate = RECOVERY_ESTIMATES[severity];
    const now = new Date();

    return {
        severity,
        label: estimate.label,
        description: estimate.description,
        estimatedMinDays: estimate.minDays,
        estimatedMaxDays: estimate.maxDays,
        estimatedRecoveryDate: {
            earliest: new Date(now.getTime() + estimate.minDays * 86400000),
            latest: new Date(now.getTime() + estimate.maxDays * 86400000),
        },
        factors,
    };
}

// ─── Provider Volume Caps ───────────────────────────────────────────────────

/**
 * Detect email provider from mailbox email address.
 */
export function detectProvider(email: string): string {
    const domain = email.split('@')[1]?.toLowerCase() || '';

    // Google
    if (domain === 'gmail.com') return 'google_free';
    if (domain.endsWith('.google.com') || domain === 'googlemail.com') return 'google_workspace';

    // Microsoft
    if (['outlook.com', 'hotmail.com', 'live.com', 'msn.com'].includes(domain)) return 'outlook_free';

    // Yahoo
    if (['yahoo.com', 'yahoo.co.uk', 'yahoo.co.in', 'ymail.com', 'aol.com'].includes(domain)) return 'yahoo';

    // For custom domains, assume Google Workspace or Microsoft 365 (most common for business)
    // The actual provider detection would need MX record lookup, but for sending caps
    // we use a conservative default since custom domains go through Google/Microsoft hosting
    return 'google_workspace'; // Conservative default — Google Workspace is most common for cold email
}

/**
 * Get the daily sending limit for a mailbox based on its email provider.
 */
export function getProviderDailyLimit(email: string): { dailyLimit: number; provider: string; label: string } {
    const provider = detectProvider(email);
    const cap = PROVIDER_VOLUME_CAPS[provider] || PROVIDER_VOLUME_CAPS.unknown;
    return { dailyLimit: cap.dailyLimit, provider, label: cap.label };
}

/**
 * Check if a mailbox has exceeded its provider daily sending limit.
 * Returns remaining capacity (0 = at limit, negative = over limit).
 */
export function checkProviderCapacity(
    email: string,
    todaySentCount: number
): { atLimit: boolean; remaining: number; dailyLimit: number; provider: string } {
    const { dailyLimit, provider } = getProviderDailyLimit(email);
    const remaining = dailyLimit - todaySentCount;
    return {
        atLimit: remaining <= 0,
        remaining: Math.max(0, remaining),
        dailyLimit,
        provider,
    };
}

// ─── Domain Last Sent Tracking ──────────────────────────────────────────────

/**
 * Update domain.last_sent_at when a send occurs through any of its mailboxes.
 * Called from bounceProcessingService / monitoringService after recording a send.
 */
export async function updateDomainLastSent(domainId: string): Promise<void> {
    try {
        await prisma.domain.update({
            where: { id: domainId },
            data: { last_sent_at: new Date() },
        });
    } catch {
        // Non-critical — don't block sends if this fails
    }
}
