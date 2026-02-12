/**
 * Metrics Service
 * 
 * Implements rolling window metrics, velocity-based risk detection, and
 * ExecutionRiskScore calculation as per Section 7 & 12 of the Infrastructure Audit.
 * 
 * Key features:
 * - Multiple rolling windows (1h, 24h, 7d)
 * - Velocity calculation (rate of change)
 * - Risk score (0-100) based on bounces, failures, and velocity
 * - Automatic window rotation
 */

import { prisma } from '../index';
import { MONITORING_THRESHOLDS } from '../types';
import { logger } from './observabilityService';

// ============================================================================
// TYPES
// ============================================================================

interface WindowMetrics {
    sent: number;
    bounces: number;
    failures: number;
    bounceRate: number;
    failureRate: number;
    windowStart: Date;
}

interface AllWindowMetrics {
    window1h: WindowMetrics;
    window24h: WindowMetrics;
    window7d: WindowMetrics;
}

interface RiskAssessment {
    riskScore: number;         // 0-100
    velocity: number;          // Rate of change (-100 to +100)
    riskLevel: 'low' | 'medium' | 'high' | 'critical';
    factors: {
        bounceRatio: number;   // Contribution from bounces (0-40)
        failureRatio: number;  // Contribution from failures (0-30)
        velocityScore: number; // Contribution from velocity (0-20)
        escalation: number;    // Contribution from repeated issues (0-10)
    };
    recommendations: string[];
}

// ============================================================================
// WINDOW CONSTANTS
// ============================================================================

const WINDOW_DURATIONS = {
    '1h': MONITORING_THRESHOLDS.WINDOW_1H_MS,      // 3600000 ms
    '24h': MONITORING_THRESHOLDS.WINDOW_24H_MS,    // 86400000 ms
    '7d': MONITORING_THRESHOLDS.WINDOW_7D_MS       // 604800000 ms
};

// ============================================================================
// METRICS RECORDING
// ============================================================================

/**
 * Record a sent email in all rolling windows.
 */
export async function recordSent(mailboxId: string): Promise<void> {
    const metrics = await getOrCreateMetrics(mailboxId);

    // Check and rotate expired windows
    await rotateExpiredWindows(mailboxId, metrics);

    // Increment sent counters in all windows
    await prisma.mailboxMetrics.update({
        where: { mailbox_id: mailboxId },
        data: {
            window_1h_sent: { increment: 1 },
            window_24h_sent: { increment: 1 },
            window_7d_sent: { increment: 1 }
        }
    });
}

/**
 * Record a bounce in all rolling windows and recalculate risk.
 */
export async function recordBounce(mailboxId: string): Promise<RiskAssessment> {
    const metrics = await getOrCreateMetrics(mailboxId);

    // Check and rotate expired windows
    await rotateExpiredWindows(mailboxId, metrics);

    // Increment bounce counters in all windows
    await prisma.mailboxMetrics.update({
        where: { mailbox_id: mailboxId },
        data: {
            window_1h_bounce: { increment: 1 },
            window_24h_bounce: { increment: 1 },
            window_7d_bounce: { increment: 1 }
        }
    });

    // Also update the mailbox-level counters
    await prisma.mailbox.update({
        where: { id: mailboxId },
        data: {
            hard_bounce_count: { increment: 1 },
            window_bounce_count: { increment: 1 }
        }
    });

    // Recalculate and return risk assessment
    return await calculateAndUpdateRisk(mailboxId);
}

/**
 * Record a delivery failure in all rolling windows.
 */
export async function recordFailure(mailboxId: string): Promise<RiskAssessment> {
    const metrics = await getOrCreateMetrics(mailboxId);

    // Check and rotate expired windows
    await rotateExpiredWindows(mailboxId, metrics);

    // Increment failure counters in all windows
    await prisma.mailboxMetrics.update({
        where: { mailbox_id: mailboxId },
        data: {
            window_1h_failure: { increment: 1 },
            window_24h_failure: { increment: 1 },
            window_7d_failure: { increment: 1 }
        }
    });

    // Also update the mailbox-level counter
    await prisma.mailbox.update({
        where: { id: mailboxId },
        data: {
            delivery_failure_count: { increment: 1 }
        }
    });

    // Recalculate and return risk assessment
    return await calculateAndUpdateRisk(mailboxId);
}

// ============================================================================
// WINDOW MANAGEMENT
// ============================================================================

/**
 * Get or create metrics record for a mailbox.
 */
async function getOrCreateMetrics(mailboxId: string): Promise<any> {
    let metrics = await prisma.mailboxMetrics.findUnique({
        where: { mailbox_id: mailboxId }
    });

    if (!metrics) {
        metrics = await prisma.mailboxMetrics.create({
            data: {
                mailbox_id: mailboxId,
                window_1h_start: new Date(),
                window_24h_start: new Date(),
                window_7d_start: new Date()
            }
        });
    }

    return metrics;
}

/**
 * Check and rotate any expired windows, resetting their counters.
 */
async function rotateExpiredWindows(mailboxId: string, metrics: any): Promise<void> {
    const now = Date.now();
    const updates: any = {};

    // Check 1-hour window
    if (now - metrics.window_1h_start.getTime() > WINDOW_DURATIONS['1h']) {
        updates.window_1h_sent = 0;
        updates.window_1h_bounce = 0;
        updates.window_1h_failure = 0;
        updates.window_1h_start = new Date();
        logger.info(`[METRICS] Rotated 1h window for mailbox ${mailboxId}`);
    }

    // Check 24-hour window
    if (now - metrics.window_24h_start.getTime() > WINDOW_DURATIONS['24h']) {
        updates.window_24h_sent = 0;
        updates.window_24h_bounce = 0;
        updates.window_24h_failure = 0;
        updates.window_24h_start = new Date();
        logger.info(`[METRICS] Rotated 24h window for mailbox ${mailboxId}`);
    }

    // Check 7-day window
    if (now - metrics.window_7d_start.getTime() > WINDOW_DURATIONS['7d']) {
        updates.window_7d_sent = 0;
        updates.window_7d_bounce = 0;
        updates.window_7d_failure = 0;
        updates.window_7d_start = new Date();
        logger.info(`[METRICS] Rotated 7d window for mailbox ${mailboxId}`);
    }

    if (Object.keys(updates).length > 0) {
        await prisma.mailboxMetrics.update({
            where: { mailbox_id: mailboxId },
            data: updates
        });
    }
}

/**
 * Get all window metrics for a mailbox.
 */
export async function getWindowMetrics(mailboxId: string): Promise<AllWindowMetrics> {
    const metrics = await getOrCreateMetrics(mailboxId);
    await rotateExpiredWindows(mailboxId, metrics);

    // Re-fetch after potential rotation
    const updated = await prisma.mailboxMetrics.findUnique({
        where: { mailbox_id: mailboxId }
    });

    if (!updated) {
        throw new Error(`Metrics not found for mailbox ${mailboxId}`);
    }

    return {
        window1h: {
            sent: updated.window_1h_sent,
            bounces: updated.window_1h_bounce,
            failures: updated.window_1h_failure,
            bounceRate: calculateRate(updated.window_1h_bounce, updated.window_1h_sent),
            failureRate: calculateRate(updated.window_1h_failure, updated.window_1h_sent),
            windowStart: updated.window_1h_start
        },
        window24h: {
            sent: updated.window_24h_sent,
            bounces: updated.window_24h_bounce,
            failures: updated.window_24h_failure,
            bounceRate: calculateRate(updated.window_24h_bounce, updated.window_24h_sent),
            failureRate: calculateRate(updated.window_24h_failure, updated.window_24h_sent),
            windowStart: updated.window_24h_start
        },
        window7d: {
            sent: updated.window_7d_sent,
            bounces: updated.window_7d_bounce,
            failures: updated.window_7d_failure,
            bounceRate: calculateRate(updated.window_7d_bounce, updated.window_7d_sent),
            failureRate: calculateRate(updated.window_7d_failure, updated.window_7d_sent),
            windowStart: updated.window_7d_start
        }
    };
}

// ============================================================================
// RISK CALCULATION
// ============================================================================

/**
 * Calculate the ExecutionRiskScore (0-100) for a mailbox.
 * 
 * Risk is composed of:
 * - Bounce ratio (0-40 points): Based on 1h and 24h bounce rates
 * - Failure ratio (0-30 points): Based on delivery failure rates
 * - Velocity (0-20 points): Rate of change in issues
 * - Escalation (0-10 points): Repeated pauses increase risk
 */
export async function calculateAndUpdateRisk(mailboxId: string): Promise<RiskAssessment> {
    const metrics = await getWindowMetrics(mailboxId);
    const mailbox = await prisma.mailbox.findUnique({
        where: { id: mailboxId },
        select: { consecutive_pauses: true, status: true }
    });

    const consecutivePauses = mailbox?.consecutive_pauses || 0;

    // Calculate individual risk factors
    const factors = calculateRiskFactors(metrics, consecutivePauses);

    // Calculate velocity (rate of change between 1h and 24h windows)
    const velocity = calculateVelocity(metrics);

    // Total risk score (capped at 100)
    const riskScore = Math.min(100, Math.round(
        factors.bounceRatio +
        factors.failureRatio +
        factors.velocityScore +
        factors.escalation
    ));

    // Determine risk level
    const riskLevel = getRiskLevel(riskScore);

    // Generate recommendations
    const recommendations = generateRecommendations(riskScore, factors, metrics);

    // Update the stored risk score and velocity
    await prisma.mailboxMetrics.update({
        where: { mailbox_id: mailboxId },
        data: {
            risk_score: riskScore,
            velocity: velocity
        }
    });

    logger.info(`[METRICS] Risk score for ${mailboxId}: ${riskScore} (${riskLevel})`);

    return {
        riskScore,
        velocity,
        riskLevel,
        factors,
        recommendations
    };
}

/**
 * Calculate individual risk factors.
 */
function calculateRiskFactors(
    metrics: AllWindowMetrics,
    consecutivePauses: number
): RiskAssessment['factors'] {
    // Bounce ratio (0-40 points)
    // Weight 1h more heavily (2x) as it's more recent
    const bounceRatio = Math.min(40,
        (metrics.window1h.bounceRate * 2 + metrics.window24h.bounceRate) * 10
    );

    // Failure ratio (0-30 points)
    const failureRatio = Math.min(30,
        (metrics.window1h.failureRate * 2 + metrics.window24h.failureRate) * 8
    );

    // Velocity score (0-20 points)
    // Higher velocity = faster deterioration = higher risk
    const velocity = calculateVelocity(metrics);
    const velocityScore = Math.min(20, Math.max(0, velocity * 0.2));

    // Escalation factor (0-10 points)
    // Each consecutive pause adds 3 points
    const escalation = Math.min(10, consecutivePauses * 3);

    return {
        bounceRatio: Math.round(bounceRatio * 10) / 10,
        failureRatio: Math.round(failureRatio * 10) / 10,
        velocityScore: Math.round(velocityScore * 10) / 10,
        escalation
    };
}

/**
 * Calculate velocity (rate of change).
 * Positive = getting worse, Negative = improving
 */
function calculateVelocity(metrics: AllWindowMetrics): number {
    // Compare 1h rate to 24h rate
    // If 1h is worse than 24h, velocity is positive (deteriorating)
    const bounceDelta = metrics.window1h.bounceRate - metrics.window24h.bounceRate;
    const failureDelta = metrics.window1h.failureRate - metrics.window24h.failureRate;

    // Scale velocity to -100 to +100 range
    const velocity = (bounceDelta * 50 + failureDelta * 30);

    return Math.round(Math.max(-100, Math.min(100, velocity)) * 10) / 10;
}

/**
 * Determine risk level from score.
 */
function getRiskLevel(riskScore: number): RiskAssessment['riskLevel'] {
    if (riskScore >= MONITORING_THRESHOLDS.RISK_SCORE_CRITICAL) return 'critical';
    if (riskScore >= MONITORING_THRESHOLDS.RISK_SCORE_WARNING) return 'high';
    if (riskScore >= 25) return 'medium';
    return 'low';
}

/**
 * Generate actionable recommendations based on risk factors.
 */
function generateRecommendations(
    riskScore: number,
    factors: RiskAssessment['factors'],
    metrics: AllWindowMetrics
): string[] {
    const recommendations: string[] = [];

    if (riskScore >= MONITORING_THRESHOLDS.RISK_SCORE_CRITICAL) {
        recommendations.push('CRITICAL: Immediate action required. Consider pausing this mailbox.');
    }

    if (factors.bounceRatio > 20) {
        recommendations.push(`High bounce rate detected (${metrics.window1h.bounceRate.toFixed(1)}% in 1h). Check email list quality.`);
    }

    if (factors.failureRatio > 15) {
        recommendations.push(`Elevated delivery failures. Verify SMTP configuration and domain reputation.`);
    }

    if (factors.velocityScore > 10) {
        recommendations.push('Rapid deterioration detected. Monitor closely for the next hour.');
    }

    if (factors.escalation >= 6) {
        recommendations.push('Multiple consecutive pauses. Consider extended cooldown or mailbox retirement.');
    }

    if (riskScore < 25) {
        recommendations.push('Mailbox is operating within healthy parameters.');
    }

    return recommendations;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Calculate rate as a percentage, handling division by zero.
 */
function calculateRate(count: number, total: number): number {
    if (total === 0) return 0;
    return (count / total) * 100;
}

/**
 * Get risk assessment for a mailbox without updating.
 */
export async function getRiskAssessment(mailboxId: string): Promise<RiskAssessment> {
    return calculateAndUpdateRisk(mailboxId);
}

/**
 * Get all mailboxes above a risk threshold for an organization.
 */
export async function getHighRiskMailboxes(
    organizationId: string,
    threshold: number = MONITORING_THRESHOLDS.RISK_SCORE_WARNING
): Promise<any[]> {
    return prisma.mailbox.findMany({
        where: {
            organization_id: organizationId,
            metrics: {
                risk_score: { gte: threshold }
            }
        },
        include: {
            metrics: true,
            domain: true
        },
        orderBy: {
            metrics: { risk_score: 'desc' }
        }
    });
}

/**
 * Aggregate risk metrics for a domain.
 */
export async function getDomainRiskMetrics(domainId: string): Promise<{
    averageRiskScore: number;
    highestRiskScore: number;
    mailboxCount: number;
    atRiskCount: number;
}> {
    const mailboxes = await prisma.mailbox.findMany({
        where: { domain_id: domainId },
        include: { metrics: true }
    });

    if (mailboxes.length === 0) {
        return {
            averageRiskScore: 0,
            highestRiskScore: 0,
            mailboxCount: 0,
            atRiskCount: 0
        };
    }

    const riskScores = mailboxes
        .map(m => m.metrics?.risk_score || 0);

    const averageRiskScore = riskScores.reduce((a, b) => a + b, 0) / riskScores.length;
    const highestRiskScore = Math.max(...riskScores);
    const atRiskCount = riskScores.filter(s => s >= MONITORING_THRESHOLDS.RISK_SCORE_WARNING).length;

    return {
        averageRiskScore: Math.round(averageRiskScore * 10) / 10,
        highestRiskScore,
        mailboxCount: mailboxes.length,
        atRiskCount
    };
}
