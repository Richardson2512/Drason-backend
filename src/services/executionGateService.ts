/**
 * Execution Gate Service
 * 
 * Section 9 of Audit: Execution Gate Logic (Full Model)
 * Section 10 of Audit: System Modes
 * 
 * Gate allows execution only if ALL conditions are met:
 * - Campaign active
 * - Domain not paused
 * - Mailbox available and not in cooldown
 * - Risk score below threshold
 * - System mode permits enforcement
 */

import { prisma } from '../prisma';
import * as auditLogService from './auditLogService';
import * as healingService from './healingService';
import * as notificationService from './notificationService';
import * as inactivityService from './inactivityService';
import * as recipientDomainStats from './recipientDomainStatsService';
import { logger } from './observabilityService';
import {
    SystemMode,
    GateResult,
    FailureType,
    RecoveryPhase,
    MONITORING_THRESHOLDS
} from '../types';

const {
    HARD_RISK_CRITICAL,     // Hard signals block (bounce-based)
    SOFT_RISK_HIGH,         // Soft signals just log (velocity-based)
    SOFT_RISK_DEFER_THRESHOLD,
    RISK_SCORE_CRITICAL,    // For display/logging
    YELLOW_LEAD_MAX_STEP,
    YELLOW_LEAD_PER_MAILBOX_WINDOW_SIZE,
    YELLOW_LEAD_PER_MAILBOX_WINDOW_LIMIT,
    RECIPIENT_DOMAIN_COMPLAINT_THRESHOLD,
    RECIPIENT_DOMAIN_THROTTLE_THRESHOLD
} = MONITORING_THRESHOLDS;

/**
 * Check if a lead can be executed (pushed to campaign).
 * Returns detailed gate result including recommendations.
 */
export const canExecuteLead = async (
    organizationId: string,
    campaignId: string,
    leadId: string
): Promise<GateResult> => {
    // Get organization to check system mode and assessment status
    const org = await prisma.organization.findUnique({
        where: { id: organizationId }
    });

    const systemMode = (org?.system_mode as SystemMode) || SystemMode.OBSERVE;

    // The infrastructure assessment (DNS / DNSBL / mailbox-health snapshot)
    // runs in the background and no longer gates execution. Real-time
    // protection is enforced below + at send time via canSendNow():
    // mailbox.status, mailbox.recovery_phase, domain.status, bounce rate,
    // recipient-domain complaints, healing aggregate caps. The assessment
    // is informational baseline; it shouldn't stop sending.

    // ── TRANSITION GATE: Phase 0 → Phase 1 check ──
    const transitionResult = await healingService.checkTransitionGate(organizationId);
    if (!transitionResult.canTransition) {
        return {
            allowed: false,
            reason: transitionResult.message,
            riskScore: 100,
            mode: systemMode,
            failureType: FailureType.HEALTH_ISSUE,
            checks: {
                campaignActive: false,
                domainHealthy: false,
                mailboxAvailable: false,
                belowCapacity: false,
                riskAcceptable: false
            },
            recommendations: transitionResult.requiresAcknowledgment
                ? [`Acknowledge infrastructure risks (score: ${transitionResult.overallScore}/100) to proceed`]
                : ['Resolve infrastructure issues before executing leads']
        };
    }

    const recommendations: string[] = [];

    // Initialize check results
    const checks = {
        campaignActive: false,
        domainHealthy: false,
        mailboxAvailable: false,
        belowCapacity: true,
        riskAcceptable: true
    };

    // 1. Validate Campaign
    const campaign = await prisma.campaign.findUnique({
        where: { id: campaignId }
    });

    if (!campaign) {
        await auditLogService.logAction({
            organizationId,
            entity: 'lead',
            entityId: leadId,
            trigger: 'gate_check',
            action: 'gate_failed',
            details: `Campaign ${campaignId} not found`
        });
        return {
            allowed: false,
            reason: `Campaign ${campaignId} not found`,
            riskScore: 0,
            recommendations: ['Verify campaign exists in Smartlead and sync'],
            mode: systemMode,
            checks,
            // FAILURE CLASSIFICATION: Sync issue - campaign not synced
            failureType: FailureType.SYNC_ISSUE,
            retryable: false,
            deferrable: true  // Can queue and retry after sync
        };
    }

    if (campaign.status !== 'active') {
        recommendations.push(`Campaign is ${campaign.status}. Activate to proceed.`);
        await auditLogService.logAction({
            organizationId,
            entity: 'lead',
            entityId: leadId,
            trigger: 'gate_check',
            action: 'gate_failed',
            details: `Campaign ${campaignId} is ${campaign.status}`
        });
        return {
            allowed: false,
            reason: `Campaign ${campaignId} is ${campaign.status}`,
            riskScore: 0,
            recommendations,
            mode: systemMode,
            checks,
            // FAILURE CLASSIFICATION: Sync/config issue
            failureType: FailureType.SYNC_ISSUE,
            retryable: false,
            deferrable: true
        };
    }
    checks.campaignActive = true;

    // 2. Find healthy mailboxes with healthy domains
    const healthyMailboxes = await prisma.mailbox.findMany({
        where: {
            organization_id: organizationId,
            status: 'healthy',
            OR: [
                { cooldown_until: null },
                { cooldown_until: { lt: new Date() } }
            ],
            domain: {
                status: 'healthy'
            }
        },
        include: {
            domain: true,
            metrics: true
        }
    });

    // Filter out mailboxes that have hit their warmup/recovery daily send cap.
    // warmup_limit > 0 means a daily cap is configured (set by warmupService
    // during 5-phase recovery); window_sent_count tracks today's sends.
    // Honored unconditionally for native sending — there is no upstream
    // warmup engine, so the cap IS the throttle.
    const afterWarmupFilter = healthyMailboxes.filter(mb => {
        if (mb.warmup_limit > 0) {
            return mb.window_sent_count < mb.warmup_limit;
        }
        return true;
    });
    const warmupCappedCount = healthyMailboxes.length - afterWarmupFilter.length;

    // Filter out mailboxes that have hit their provider daily sending limit
    // (Gmail: 1800, Microsoft 365: 9000, etc.)
    const availableMailboxes = afterWarmupFilter.filter(mb => {
        const { atLimit } = inactivityService.checkProviderCapacity(mb.email, mb.window_sent_count);
        return !atLimit;
    });
    const providerCappedCount = afterWarmupFilter.length - availableMailboxes.length;

    if (availableMailboxes.length === 0) {
        // Check why no mailboxes are available
        const totalMailboxes = await prisma.mailbox.count({
            where: { organization_id: organizationId }
        });

        if (totalMailboxes === 0) {
            recommendations.push('No mailboxes configured. Sync with Smartlead.');
        } else if (providerCappedCount > 0 && afterWarmupFilter.length > 0) {
            // All healthy mailboxes have hit their provider daily limit
            recommendations.push(`All ${providerCappedCount} healthy mailbox(es) have reached their email provider daily sending limit. Leads will be deferred until tomorrow.`);
            logger.info('[GATE] All mailboxes at provider capacity', {
                organizationId,
                providerCappedCount,
                healthyTotal: healthyMailboxes.length,
            });
        } else if (warmupCappedCount > 0 && healthyMailboxes.length > 0) {
            // All healthy mailboxes have hit their warmup daily limit — soft block
            recommendations.push(`All ${warmupCappedCount} healthy mailbox(es) have reached their warmup send limit for today. Leads will be deferred until tomorrow.`);
            logger.info('[GATE] All mailboxes at warmup capacity', {
                organizationId,
                warmupCappedCount,
                healthyTotal: healthyMailboxes.length,
            });
        } else {
            // ── CRITICAL SITUATION: All mailboxes paused ──
            // System completely unable to send leads - requires immediate attention
            recommendations.push('All mailboxes are paused or in cooldown. Wait for recovery.');

            // Send CRITICAL notification to alert user
            // This is a complete system failure - no leads can be processed
            try {
                const pausedCount = await prisma.mailbox.count({
                    where: {
                        organization_id: organizationId,
                        status: 'paused'
                    }
                });

                const cooldownCount = await prisma.mailbox.count({
                    where: {
                        organization_id: organizationId,
                        cooldown_until: { gt: new Date() }
                    }
                });

                await notificationService.createNotification(organizationId, {
                    type: 'ERROR',
                    title: '🚨 CRITICAL: All Mailboxes Unavailable',
                    message: `All ${totalMailboxes} mailboxes are currently unavailable (${pausedCount} paused, ${cooldownCount} in cooldown). NO LEADS CAN BE SENT. Immediate action required. Check infrastructure health page for details.`
                });

                logger.error(`[CRITICAL] All mailboxes unavailable for org ${organizationId}`, undefined, {
                    organizationId,
                    totalMailboxes,
                    pausedCount,
                    cooldownCount
                });
            } catch (notifError: any) {
                // Don't fail the gate check if notification fails
                logger.error('[GATE] Failed to send critical notification', notifError, {
                    organizationId
                });
            }
        }

        const isWarmupCapBlock = warmupCappedCount > 0 && healthyMailboxes.length > 0;
        await auditLogService.logAction({
            organizationId,
            entity: 'lead',
            entityId: leadId,
            trigger: 'gate_check',
            action: 'gate_failed',
            details: isWarmupCapBlock
                ? `No available mailboxes: ${warmupCappedCount} at warmup daily limit`
                : 'No healthy mailboxes available'
        });
        return {
            allowed: false,
            reason: isWarmupCapBlock
                ? 'All mailboxes at warmup daily limit'
                : 'No healthy mailboxes available',
            riskScore: 100,
            recommendations,
            mode: systemMode,
            checks,
            // Warmup cap is a transient condition — deferrable until tomorrow
            failureType: isWarmupCapBlock ? FailureType.HEALTH_ISSUE
                : totalMailboxes === 0 ? FailureType.SYNC_ISSUE : FailureType.HEALTH_ISSUE,
            retryable: false,
            deferrable: isWarmupCapBlock || totalMailboxes === 0
        };
    }
    checks.mailboxAvailable = true;
    checks.domainHealthy = true;

    // =========================================================================
    // 2.3 LEAD HEALTH GATE — YELLOW differential treatment (M3AAWG BCP §4.2)
    // YELLOW leads (catch-all, role, risky) are capped at first 2 sequence
    // steps. Industry guidance: segment risky addresses to limited exposure.
    // =========================================================================
    const lead = await prisma.lead.findUnique({
        where: { id: leadId },
        select: { id: true, email: true, health_classification: true }
    });

    if (lead?.health_classification === 'yellow') {
        // CampaignLead is keyed by (campaign_id, email), not lead_id.
        const cl = lead.email ? await prisma.campaignLead.findFirst({
            where: { campaign_id: campaignId, email: lead.email },
            select: { current_step: true }
        }) : null;
        // current_step is the LAST delivered step (0 = nothing sent yet).
        // Block if we've already sent YELLOW_LEAD_MAX_STEP messages.
        if (cl && cl.current_step >= YELLOW_LEAD_MAX_STEP) {
            await auditLogService.logAction({
                organizationId,
                entity: 'lead',
                entityId: leadId,
                trigger: 'gate_check',
                action: 'gate_blocked',
                details: `YELLOW lead exceeded max-step cap (${cl.current_step}/${YELLOW_LEAD_MAX_STEP})`
            });
            return {
                allowed: false,
                reason: `YELLOW lead has reached max sequence step (${YELLOW_LEAD_MAX_STEP}) — risky addresses are capped to limit reputation exposure`,
                riskScore: 70,
                recommendations: ['YELLOW leads should not progress beyond step 2; complete or block this lead'],
                mode: systemMode,
                checks,
                failureType: FailureType.HEALTH_ISSUE,
                retryable: false,
                deferrable: false
            };
        }
    }

    // =========================================================================
    // 2.4 RECIPIENT-DOMAIN COMPLAINT RATE GATE (Google/Yahoo Feb 2024 thresholds)
    // Computed locally from BounceEvent + SendEvent over 30d window.
    // ≥0.30% → block enrollment. ≥0.10% → log warning + reduced priority hint.
    // =========================================================================
    if (lead?.email) {
        const recipientDomain = lead.email.split('@')[1]?.toLowerCase();
        if (recipientDomain) {
            const stats = await recipientDomainStats.getRecipientDomainComplaintRate(
                organizationId,
                recipientDomain
            );
            if (stats.sufficientSample) {
                if (stats.rate >= RECIPIENT_DOMAIN_COMPLAINT_THRESHOLD) {
                    await auditLogService.logAction({
                        organizationId,
                        entity: 'lead',
                        entityId: leadId,
                        trigger: 'gate_check',
                        action: 'gate_blocked',
                        details: `Recipient domain ${recipientDomain} complaint rate ${(stats.rate * 100).toFixed(3)}% ≥ ${(RECIPIENT_DOMAIN_COMPLAINT_THRESHOLD * 100).toFixed(2)}% (${stats.complaintCount}/${stats.sendCount})`
                    });
                    return {
                        allowed: false,
                        reason: `Recipient domain ${recipientDomain} has high complaint rate (${(stats.rate * 100).toFixed(3)}%) — sending paused to protect sender reputation`,
                        riskScore: 90,
                        recommendations: [
                            `Pause new sends to ${recipientDomain} until complaint rate drops below ${(RECIPIENT_DOMAIN_THROTTLE_THRESHOLD * 100).toFixed(2)}%`,
                            'Review recent campaigns and copy for complaint triggers'
                        ],
                        mode: systemMode,
                        checks,
                        failureType: FailureType.HEALTH_ISSUE,
                        retryable: false,
                        deferrable: false
                    };
                } else if (stats.rate >= RECIPIENT_DOMAIN_THROTTLE_THRESHOLD) {
                    recommendations.push(
                        `⚠️ Recipient domain ${recipientDomain} complaint rate elevated (${(stats.rate * 100).toFixed(3)}%); reduce volume to this domain`
                    );
                    logger.info('[GATE] Recipient-domain complaint rate elevated', {
                        organizationId, recipientDomain, rate: stats.rate,
                        sendCount: stats.sendCount, complaintCount: stats.complaintCount,
                    });
                }
            }
        }
    }

    // =========================================================================
    // 2.5 AGGREGATE THROTTLE CHECK (Domain + Org level)
    // Prevents total volume from exceeding safe limits during recovery
    // =========================================================================

    // Check domain-level aggregate cap
    const selectedMailbox = availableMailboxes[0]; // Best available mailbox (warmup-cap-filtered)
    if (selectedMailbox?.domain_id) {
        const domainLimit = await healingService.getDomainAggregateLimit(selectedMailbox.domain_id);
        if (domainLimit !== Infinity) {
            const domainSent = await healingService.getDomainSentToday(selectedMailbox.domain_id);
            if (domainSent >= domainLimit) {
                checks.belowCapacity = false;
                recommendations.push(`⛔ Domain daily cap reached (${domainSent}/${domainLimit} sends). Recovery throttle active.`);
                logger.info('[GATE] Domain aggregate throttle triggered', {
                    domainId: selectedMailbox.domain_id,
                    domainSent,
                    domainLimit,
                });
            }
        }
    }

    // Check org-level aggregate cap
    const orgLimit = await healingService.getOrgAggregateLimit(organizationId);
    if (orgLimit !== Infinity) {
        const orgSent = await healingService.getOrgSentToday(organizationId);
        if (orgSent >= orgLimit) {
            checks.belowCapacity = false;
            recommendations.push(`⛔ Organization daily cap reached (${orgSent}/${orgLimit} sends). Recovery throttle active.`);
            logger.info('[GATE] Org aggregate throttle triggered', {
                organizationId,
                orgSent,
                orgLimit,
            });
        }
    }

    // =========================================================================
    // 3. SEPARATED RISK SCORING (Production-Hardened)
    // Hard signals (bounce/failure) → CAN block execution
    // Soft signals (velocity/history) → Log only, never block
    // =========================================================================

    let totalHardScore = 0;
    let totalSoftScore = 0;
    let mailboxesWithMetrics = 0;

    for (const mailbox of availableMailboxes) {
        if (mailbox.metrics) {
            mailboxesWithMetrics++;

            // HARD SCORE: Bounce + failure ratios from 24h window (these CAN trigger blocking)
            const sent24h = mailbox.metrics.window_24h_sent || 1; // Avoid division by 0
            const bounce24h = mailbox.metrics.window_24h_bounce || 0;
            const failure24h = mailbox.metrics.window_24h_failure || 0;

            const bounceRate24h = (bounce24h / sent24h) * 100;    // 0-100%
            const failureRate24h = (failure24h / sent24h) * 100;  // 0-100%

            // Hard score: weighted bounce (70%) + failure (30%)
            const hardScore = (bounceRate24h * 0.7) + (failureRate24h * 0.3);
            totalHardScore += Math.min(hardScore * 10, 100); // Scale to 0-100

            // SOFT SCORE: Velocity + escalation history (these ONLY log)
            const velocityComponent = (mailbox.metrics.velocity || 0) * 20; // Scale velocity
            const domainWarnings = mailbox.domain?.warning_count || 0;
            const escalationComponent = domainWarnings * 10;

            const softScore = velocityComponent + escalationComponent;
            totalSoftScore += Math.min(softScore, 100);
        }
    }

    const avgHardScore = mailboxesWithMetrics > 0 ? totalHardScore / mailboxesWithMetrics : 0;
    const avgSoftScore = mailboxesWithMetrics > 0 ? totalSoftScore / mailboxesWithMetrics : 0;
    const avgRiskScore = (avgHardScore * 0.7) + (avgSoftScore * 0.3); // Combined for display

    // ONLY hard score blocks execution (bounce-based)
    if (avgHardScore >= HARD_RISK_CRITICAL) {
        checks.riskAcceptable = false;
        recommendations.push(`⛔ Hard risk score (${avgHardScore.toFixed(1)}) exceeds ${HARD_RISK_CRITICAL}. Bounce rate too high.`);
    }

    // Soft score: now has two tiers.
    // - ≥75 (SOFT_RISK_HIGH): log + recommendation only.
    // - ≥85 (SOFT_RISK_DEFER_THRESHOLD): defer the lead 1h instead of selecting
    //   a degraded mailbox. Velocity/escalation history is real risk; consistent
    //   defer at this tier prevents reputation damage from accumulating.
    if (avgSoftScore >= SOFT_RISK_DEFER_THRESHOLD) {
        await auditLogService.logAction({
            organizationId,
            entity: 'lead',
            entityId: leadId,
            trigger: 'gate_check',
            action: 'gate_deferred',
            details: `Soft risk score ${avgSoftScore.toFixed(1)} ≥ ${SOFT_RISK_DEFER_THRESHOLD} — deferring lead 1h`
        });
        return {
            allowed: false,
            reason: `Soft risk elevated (${avgSoftScore.toFixed(1)}); deferring 1h to let velocity/escalation signals settle`,
            riskScore: avgSoftScore,
            recommendations: [
                `Soft risk indicates accumulated velocity/escalation pressure — wait 1h before retry`
            ],
            mode: systemMode,
            checks,
            failureType: FailureType.SOFT_WARNING,
            retryable: true,
            deferrable: true
        };
    } else if (avgSoftScore >= SOFT_RISK_HIGH) {
        logger.info(`[GATE] ⚠️ High velocity detected: soft score ${avgSoftScore.toFixed(1)} (not blocking)`);
        recommendations.push(`⚠️ High velocity (${avgSoftScore.toFixed(1)}) detected but not blocking.`);
    }

    // 4. Determine if allowed based on mode and checks
    const allChecksPassed = Object.values(checks).every(v => v === true);

    // In observe mode, we log but don't enforce
    if (systemMode === SystemMode.OBSERVE) {
        await auditLogService.logAction({
            organizationId,
            entity: 'lead',
            entityId: leadId,
            trigger: 'gate_check',
            action: allChecksPassed ? 'gate_passed_observe' : 'gate_would_fail_observe',
            details: `Mode: observe. Checks: ${JSON.stringify(checks)}`
        });
        return {
            allowed: true,
            reason: allChecksPassed ? 'All checks passed (observe mode)' : 'Would fail but in observe mode',
            riskScore: avgRiskScore,
            recommendations: allChecksPassed ? [] : recommendations,
            mode: systemMode,
            checks
        };
    }

    // In suggest mode, we return result but still allow
    if (systemMode === SystemMode.SUGGEST) {
        await auditLogService.logAction({
            organizationId,
            entity: 'lead',
            entityId: leadId,
            trigger: 'gate_check',
            action: allChecksPassed ? 'gate_passed' : 'gate_suggest_caution',
            details: `Mode: suggest. Checks: ${JSON.stringify(checks)}`
        });
        return {
            allowed: true,
            reason: allChecksPassed ? 'All checks passed' : 'Caution recommended (suggest mode)',
            riskScore: avgRiskScore,
            recommendations,
            mode: systemMode,
            checks
        };
    }

    // In enforce mode, we block if checks fail
    if (!allChecksPassed) {
        await auditLogService.logAction({
            organizationId,
            entity: 'lead',
            entityId: leadId,
            trigger: 'gate_check',
            action: 'gate_blocked',
            details: `Mode: enforce. Failed checks: ${Object.entries(checks).filter(([, v]) => !v).map(([k]) => k).join(', ')}`
        });
        return {
            allowed: false,
            reason: 'Execution blocked due to failed checks',
            riskScore: avgRiskScore,
            recommendations,
            mode: systemMode,
            checks
        };
    }

    // All checks passed in enforce mode
    await auditLogService.logAction({
        organizationId,
        entity: 'lead',
        entityId: leadId,
        trigger: 'gate_check',
        action: 'gate_passed',
        details: `Mode: enforce. ${availableMailboxes.length} mailboxes available. Risk: ${avgRiskScore.toFixed(1)}`
    });

    return {
        allowed: true,
        reason: `Gate passed. ${availableMailboxes.length} healthy mailboxes, risk score: ${avgRiskScore.toFixed(1)}`,
        riskScore: avgRiskScore,
        recommendations: [],
        mode: systemMode,
        checks
    };
};

/**
 * Per-send protection gate.
 *
 * Lighter than canExecuteLead — runs immediately before each individual
 * send to (a) close the TOCTOU window between dispatcher snapshot and
 * BullMQ worker pickup (a paused mailbox can keep sending its in-flight
 * batch otherwise), and (b) enforce caps that only make sense at send
 * time (aggregate domain/org throttle, recipient-domain complaint rate,
 * YELLOW per-mailbox window cap).
 *
 * Returns `deferrable=true` for transient blocks so the caller can push
 * `next_send_at` out instead of pausing the lead permanently.
 */
export interface SendNowResult {
    allowed: boolean;
    reason?: string;
    deferrable?: boolean;
    deferMinutes?: number;
}

export const canSendNow = async (
    organizationId: string,
    campaignId: string,
    mailboxId: string,
    leadEmail: string,
): Promise<SendNowResult> => {
    // 0. Lead + campaign state re-check (TOCTOU window between dispatch
    // and send). The dispatcher can enqueue a delayed job up to 60 min in
    // the future; in that window the lead may have been paused via reply
    // action OR the campaign may have been soft-deleted/paused. Without
    // this check the BullMQ worker fires the send anyway because the
    // state-change happened after the dispatch snapshot.
    //
    // Hard skip (non-deferrable) because both are operator-driven
    // states — there's no value in retrying.
    const campaignLead = await prisma.campaignLead.findFirst({
        where: {
            campaign_id: campaignId,
            email: { equals: leadEmail, mode: 'insensitive' },
        },
        select: {
            status: true,
            campaign: { select: { status: true, deleted_at: true } },
        },
    });
    if (!campaignLead) {
        return { allowed: false, reason: 'CampaignLead not found at send time', deferrable: false };
    }
    if (campaignLead.status !== 'active') {
        return {
            allowed: false,
            reason: `Lead state changed to '${campaignLead.status}' since dispatch`,
            deferrable: false,
        };
    }
    if (campaignLead.campaign.deleted_at) {
        return { allowed: false, reason: 'Campaign was deleted', deferrable: false };
    }
    if (campaignLead.campaign.status !== 'active') {
        return {
            allowed: false,
            reason: `Campaign state changed to '${campaignLead.campaign.status}' since dispatch`,
            deferrable: false,
        };
    }

    // 1. Re-fetch mailbox + parent domain state (closes TOCTOU window).
    const mailbox = await prisma.mailbox.findUnique({
        where: { id: mailboxId },
        select: {
            status: true,
            recovery_phase: true,
            domain_id: true,
            domain: { select: { status: true } },
        },
    });
    if (!mailbox) {
        return { allowed: false, reason: 'Mailbox not found', deferrable: false };
    }
    if (
        mailbox.status === 'paused' ||
        mailbox.recovery_phase === RecoveryPhase.PAUSED ||
        mailbox.recovery_phase === RecoveryPhase.QUARANTINE
    ) {
        return {
            allowed: false,
            reason: `Mailbox in ${mailbox.recovery_phase}/${mailbox.status}`,
            deferrable: true,
            deferMinutes: 60,
        };
    }
    if (mailbox.domain?.status === 'paused') {
        return {
            allowed: false,
            reason: 'Parent domain paused',
            deferrable: true,
            deferMinutes: 60,
        };
    }

    // 2. Aggregate caps — domain + org. Closes the gap where follow-up
    // sequence steps for already-enrolled leads bypass DOMAIN_RECOVERY_CAP
    // (30/day) and ORG_RECOVERY_CAP (100/day) because canExecuteLead only
    // runs at enrollment.
    if (mailbox.domain_id) {
        const domainLimit = await healingService.getDomainAggregateLimit(mailbox.domain_id);
        if (domainLimit !== Infinity) {
            const domainSent = await healingService.getDomainSentToday(mailbox.domain_id);
            if (domainSent >= domainLimit) {
                return {
                    allowed: false,
                    reason: `Domain recovery cap reached (${domainSent}/${domainLimit} sent today)`,
                    deferrable: true,
                    deferMinutes: 60,
                };
            }
        }
    }
    const orgLimit = await healingService.getOrgAggregateLimit(organizationId);
    if (orgLimit !== Infinity) {
        const orgSent = await healingService.getOrgSentToday(organizationId);
        if (orgSent >= orgLimit) {
            return {
                allowed: false,
                reason: `Org recovery cap reached (${orgSent}/${orgLimit} sent today)`,
                deferrable: true,
                deferMinutes: 60,
            };
        }
    }

    // 3. Recipient-domain complaint rate gate (Google/Yahoo Feb 2024).
    const recipientDomain = leadEmail.split('@')[1]?.toLowerCase();
    if (recipientDomain) {
        const stats = await recipientDomainStats.getRecipientDomainComplaintRate(
            organizationId,
            recipientDomain,
        );
        if (stats.sufficientSample && stats.rate >= RECIPIENT_DOMAIN_COMPLAINT_THRESHOLD) {
            return {
                allowed: false,
                reason: `Recipient domain ${recipientDomain} complaint rate ${(stats.rate * 100).toFixed(3)}% ≥ ${(RECIPIENT_DOMAIN_COMPLAINT_THRESHOLD * 100).toFixed(2)}%`,
                deferrable: false,
            };
        }
    }

    // 4. YELLOW lead checks: max-step + per-mailbox window cap.
    // The lead lookup is case-insensitive on email; the campaignLead lookup
    // joins by composite (campaign_id, email) — the same convention
    // canExecuteLead uses.
    const lead = await prisma.lead.findFirst({
        where: {
            organization_id: organizationId,
            email: { equals: leadEmail, mode: 'insensitive' },
        },
        select: { health_classification: true },
    });
    if (lead?.health_classification === 'yellow') {
        const cl = await prisma.campaignLead.findFirst({
            where: {
                campaign_id: campaignId,
                email: { equals: leadEmail, mode: 'insensitive' },
            },
            select: { current_step: true },
        });
        if (cl && cl.current_step >= YELLOW_LEAD_MAX_STEP) {
            return {
                allowed: false,
                reason: `YELLOW lead reached max step (${cl.current_step}/${YELLOW_LEAD_MAX_STEP})`,
                deferrable: false,
            };
        }

        // Per-mailbox YELLOW window cap: at most LIMIT YELLOW recipients
        // within the most recent WINDOW_SIZE sends. Industry guidance
        // (M3AAWG Senders BCP v3 §4.2) is to segment risky addresses to a
        // limited stream so they can't dominate a mailbox's volume mix.
        const recentSends = await prisma.sendEvent.findMany({
            where: { mailbox_id: mailboxId },
            orderBy: { sent_at: 'desc' },
            take: YELLOW_LEAD_PER_MAILBOX_WINDOW_SIZE,
            select: { recipient_email: true },
        });
        if (recentSends.length > 0) {
            const emails = recentSends.map((s) => s.recipient_email.toLowerCase());
            const yellowInWindow = await prisma.lead.count({
                where: {
                    organization_id: organizationId,
                    email: { in: emails },
                    health_classification: 'yellow',
                },
            });
            if (yellowInWindow >= YELLOW_LEAD_PER_MAILBOX_WINDOW_LIMIT) {
                return {
                    allowed: false,
                    reason: `Per-mailbox YELLOW cap (${yellowInWindow}/${YELLOW_LEAD_PER_MAILBOX_WINDOW_LIMIT} YELLOW in last ${recentSends.length} sends)`,
                    deferrable: true,
                    deferMinutes: 60,
                };
            }
        }
    }

    return { allowed: true };
};

/**
 * Get current system mode for an organization.
 */
export const getSystemMode = async (organizationId: string): Promise<SystemMode> => {
    const org = await prisma.organization.findUnique({
        where: { id: organizationId },
        select: { system_mode: true }
    });
    return (org?.system_mode as SystemMode) || SystemMode.OBSERVE;
};
