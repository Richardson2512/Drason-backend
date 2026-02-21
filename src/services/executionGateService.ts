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

import { prisma } from '../index';
import * as auditLogService from './auditLogService';
import * as healingService from './healingService';
import * as notificationService from './notificationService';
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
    RISK_SCORE_CRITICAL     // For display/logging
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

    // ── INVARIANT: No execution before infrastructure assessment completes ──
    if (!org?.assessment_completed) {
        return {
            allowed: false,
            reason: 'Infrastructure assessment in progress — gate locked until assessment completes',
            riskScore: 100,
            mode: systemMode,
            failureType: FailureType.SYNC_ISSUE,
            checks: {
                campaignActive: false,
                domainHealthy: false,
                mailboxAvailable: false,
                belowCapacity: false,
                riskAcceptable: false
            },
            recommendations: ['Wait for infrastructure assessment to complete before executing leads']
        };
    }

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
            cooldown_until: {
                OR: [
                    { equals: null },
                    { lt: new Date() }
                ]
            } as any,
            domain: {
                status: 'healthy'
            }
        },
        include: {
            domain: true,
            metrics: true
        }
    });

    if (healthyMailboxes.length === 0) {
        // Check why no mailboxes are available
        const totalMailboxes = await prisma.mailbox.count({
            where: { organization_id: organizationId }
        });

        if (totalMailboxes === 0) {
            recommendations.push('No mailboxes configured. Sync with Smartlead.');
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

        await auditLogService.logAction({
            organizationId,
            entity: 'lead',
            entityId: leadId,
            trigger: 'gate_check',
            action: 'gate_failed',
            details: 'No healthy mailboxes available'
        });
        return {
            allowed: false,
            reason: 'No healthy mailboxes available',
            riskScore: 100,
            recommendations,
            mode: systemMode,
            checks,
            // FAILURE CLASSIFICATION: Health issue - mailboxes degraded
            failureType: totalMailboxes === 0 ? FailureType.SYNC_ISSUE : FailureType.HEALTH_ISSUE,
            retryable: false,
            deferrable: totalMailboxes === 0  // Deferrable if just needs sync
        };
    }
    checks.mailboxAvailable = true;
    checks.domainHealthy = true;

    // =========================================================================
    // 2.5 AGGREGATE THROTTLE CHECK (Domain + Org level)
    // Prevents total volume from exceeding safe limits during recovery
    // =========================================================================

    // Check domain-level aggregate cap
    const selectedMailbox = healthyMailboxes[0]; // Best available mailbox
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

    for (const mailbox of healthyMailboxes) {
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

    // Soft score just logs (velocity-based) - NEVER blocks
    if (avgSoftScore >= SOFT_RISK_HIGH) {
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
        details: `Mode: enforce. ${healthyMailboxes.length} mailboxes available. Risk: ${avgRiskScore.toFixed(1)}`
    });

    return {
        allowed: true,
        reason: `Gate passed. ${healthyMailboxes.length} healthy mailboxes, risk score: ${avgRiskScore.toFixed(1)}`,
        riskScore: avgRiskScore,
        recommendations: [],
        mode: systemMode,
        checks
    };
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
