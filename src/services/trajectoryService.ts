/**
 * Trajectory Classification Service
 * 
 * Implements Section 4.3 (Trajectory Classification) of the Implementation Plan.
 * 
 * Classifies entity behavioral trends using deterministic rules over rolling windows.
 * Requires minimum volume threshold (20 sends/window) to prevent false classifications
 * on low-volume entities.
 */

import { prisma } from '../index';
import { TrendState, DataQuality } from '../types';
import logger from '../utils/logger';

// ============================================================================
// CONSTANTS
// ============================================================================

const MIN_SENDS_PER_WINDOW = 20;       // Below this, retain current trend (no change)
const SUFFICIENT_SENDS = 50;           // ≥50 sends for sufficient_data quality
const SUFFICIENT_WINDOWS = 2;          // ≥2 windows for sufficient_data quality
const STABLE_TOLERANCE = 0.01;         // ±1% for stable classification
const WINDOW_DURATION_MS = 86400000;   // 24h rolling windows

// ============================================================================
// TYPES
// ============================================================================

export interface WindowSnapshot {
    windowIndex: number;
    sent: number;
    bounces: number;
    bounceRate: number;
    timestamp: Date;
}

export interface TrajectoryResult {
    trendState: TrendState;
    dataQuality: DataQuality;
    windows: WindowSnapshot[];
    totalSends: number;
    windowCount: number;
    rateOfChange: number;           // Positive = worsening, negative = improving
    message: string;
}

// ============================================================================
// TRAJECTORY CLASSIFICATION
// ============================================================================

/**
 * Classify the behavioral trajectory of a mailbox based on its event history.
 * Uses deterministic rules over rolling 24h windows.
 */
export async function classifyMailboxTrajectory(mailboxId: string): Promise<TrajectoryResult> {
    const mailbox = await prisma.mailbox.findUnique({
        where: { id: mailboxId },
        select: {
            id: true,
            organization_id: true,
            trend_state: true,
            total_sent_count: true,
            hard_bounce_count: true,
        },
    });
    if (!mailbox) {
        return makeInsufficientResult('Mailbox not found');
    }

    // Fetch recent events for window calculation
    const lookbackMs = WINDOW_DURATION_MS * 7; // 7 windows of lookback
    const cutoff = new Date(Date.now() - lookbackMs);

    const events = await prisma.rawEvent.findMany({
        where: {
            entity_id: mailboxId,
            entity_type: 'mailbox',
            created_at: { gte: cutoff },
            event_type: { in: ['EmailSent', 'HardBounce', 'SoftBounce'] },
        },
        orderBy: { created_at: 'asc' },
        select: { event_type: true, created_at: true },
    });

    // Build window snapshots
    const windows = buildWindows(events, WINDOW_DURATION_MS);
    const dataQuality = assessDataQuality(windows, mailbox.total_sent_count);

    // If insufficient data, retain current trend state
    if (dataQuality === DataQuality.INSUFFICIENT) {
        return {
            trendState: (mailbox.trend_state as TrendState) || TrendState.STABLE,
            dataQuality,
            windows,
            totalSends: mailbox.total_sent_count,
            windowCount: windows.length,
            rateOfChange: 0,
            message: `Insufficient data (${mailbox.total_sent_count} total sends, ${windows.length} windows) — retaining current trend`,
        };
    }

    // Filter to windows with sufficient volume
    const qualifiedWindows = windows.filter(w => w.sent >= MIN_SENDS_PER_WINDOW);

    if (qualifiedWindows.length < 2) {
        return {
            trendState: (mailbox.trend_state as TrendState) || TrendState.STABLE,
            dataQuality,
            windows,
            totalSends: mailbox.total_sent_count,
            windowCount: windows.length,
            rateOfChange: 0,
            message: `Only ${qualifiedWindows.length} windows with ≥${MIN_SENDS_PER_WINDOW} sends — retaining current trend`,
        };
    }

    // Classify trend from qualified windows
    const { trendState, rateOfChange, message } = classifyFromWindows(qualifiedWindows);

    // Persist trend state
    await prisma.mailbox.update({
        where: { id: mailboxId },
        data: { trend_state: trendState },
    });

    return {
        trendState,
        dataQuality,
        windows,
        totalSends: mailbox.total_sent_count,
        windowCount: qualifiedWindows.length,
        rateOfChange,
        message,
    };
}

/**
 * Classify the behavioral trajectory of a domain by aggregating its mailbox trends.
 */
export async function classifyDomainTrajectory(domainId: string): Promise<TrajectoryResult> {
    const domain = await prisma.domain.findUnique({
        where: { id: domainId },
        include: { mailboxes: { select: { id: true, trend_state: true } } as any },
    });
    if (!domain) {
        return makeInsufficientResult('Domain not found');
    }

    // Aggregate mailbox trends
    const trends: TrendState[] = (domain as any).mailboxes.map((m: any) => m.trend_state as TrendState);

    if (trends.length === 0) {
        return makeInsufficientResult('No mailboxes on domain');
    }

    // Domain trend = worst trend among its mailboxes (conservative)
    const trendPriority: Record<TrendState, number> = {
        [TrendState.ACCELERATING]: 0,
        [TrendState.DEGRADING]: 1,
        [TrendState.OSCILLATING]: 2,
        [TrendState.STABLE]: 3,
        [TrendState.RECOVERING]: 4,
    };

    const worstTrend = trends.reduce((worst, t) => {
        return (trendPriority[t] || 3) < (trendPriority[worst] || 3) ? t : worst;
    }, TrendState.STABLE);

    await prisma.domain.update({
        where: { id: domainId },
        data: { trend_state: worstTrend },
    });

    return {
        trendState: worstTrend,
        dataQuality: DataQuality.SUFFICIENT,
        windows: [],
        totalSends: 0,
        windowCount: trends.length,
        rateOfChange: 0,
        message: `Domain trend = ${worstTrend} (worst among ${trends.length} mailboxes)`,
    };
}

// ============================================================================
// INTERNAL HELPERS
// ============================================================================

/**
 * Build window snapshots from raw events.
 */
function buildWindows(events: { event_type: string; created_at: Date }[], windowDuration: number): WindowSnapshot[] {
    if (events.length === 0) return [];

    const now = Date.now();
    const windowCount = 7; // Max 7 windows of lookback
    const windows: WindowSnapshot[] = [];

    for (let i = 0; i < windowCount; i++) {
        const windowEnd = now - (i * windowDuration);
        const windowStart = windowEnd - windowDuration;

        const windowEvents = events.filter(e => {
            const time = new Date(e.created_at).getTime();
            return time >= windowStart && time < windowEnd;
        });

        const sent = windowEvents.filter(e => e.event_type === 'EmailSent').length;
        const bounces = windowEvents.filter(e =>
            e.event_type === 'HardBounce' || e.event_type === 'SoftBounce'
        ).length;

        windows.push({
            windowIndex: i,
            sent,
            bounces,
            bounceRate: sent > 0 ? bounces / sent : 0,
            timestamp: new Date(windowStart),
        });
    }

    // Return in chronological order (oldest first)
    return windows.reverse();
}

/**
 * Assess data quality from windows and total send count.
 */
function assessDataQuality(windows: WindowSnapshot[], totalSends: number): DataQuality {
    const qualifiedWindows = windows.filter(w => w.sent >= MIN_SENDS_PER_WINDOW);

    if (totalSends >= SUFFICIENT_SENDS && qualifiedWindows.length >= SUFFICIENT_WINDOWS) {
        return DataQuality.SUFFICIENT;
    }
    if (totalSends >= MIN_SENDS_PER_WINDOW) {
        return DataQuality.LIMITED;
    }
    return DataQuality.INSUFFICIENT;
}

/**
 * Classify trend from qualified windows using deterministic rules.
 */
function classifyFromWindows(windows: WindowSnapshot[]): {
    trendState: TrendState;
    rateOfChange: number;
    message: string;
} {
    if (windows.length < 2) {
        return { trendState: TrendState.STABLE, rateOfChange: 0, message: 'Not enough windows for trend' };
    }

    // Calculate rate changes between consecutive windows
    const changes: number[] = [];
    for (let i = 1; i < windows.length; i++) {
        changes.push(windows[i].bounceRate - windows[i - 1].bounceRate);
    }

    const avgRateOfChange = changes.reduce((sum, c) => sum + c, 0) / changes.length;
    const lastThree = windows.slice(-3);
    const recentChanges = changes.slice(-Math.min(changes.length, 3));

    // ── ACCELERATING: Degrading + rate of change increasing ──
    if (recentChanges.length >= 2) {
        const allWorsening = recentChanges.every(c => c > 0);
        const rateIncreasing = recentChanges.length >= 2 &&
            recentChanges[recentChanges.length - 1] > recentChanges[recentChanges.length - 2];

        if (allWorsening && rateIncreasing) {
            return {
                trendState: TrendState.ACCELERATING,
                rateOfChange: avgRateOfChange,
                message: `Bounce rate accelerating: last changes ${recentChanges.map(c => `${(c * 100).toFixed(1)}%`).join(', ')}`,
            };
        }
    }

    // ── DEGRADING: 2 consecutive worsening windows ──
    if (recentChanges.length >= 2) {
        const lastTwo = recentChanges.slice(-2);
        if (lastTwo.every(c => c > STABLE_TOLERANCE)) {
            return {
                trendState: TrendState.DEGRADING,
                rateOfChange: avgRateOfChange,
                message: `Bounce rate degrading: last 2 windows worsened by ${lastTwo.map(c => `${(c * 100).toFixed(1)}%`).join(', ')}`,
            };
        }
    }

    // ── OSCILLATING: Alternating improve/decline across 4+ windows ──
    if (changes.length >= 3) {
        let alternations = 0;
        for (let i = 1; i < changes.length; i++) {
            if ((changes[i] > 0 && changes[i - 1] < 0) || (changes[i] < 0 && changes[i - 1] > 0)) {
                alternations++;
            }
        }
        if (alternations >= 3) {
            return {
                trendState: TrendState.OSCILLATING,
                rateOfChange: avgRateOfChange,
                message: `Bounce rate oscillating: ${alternations} direction changes across ${changes.length + 1} windows`,
            };
        }
    }

    // ── RECOVERING: 2 consecutive improving windows ──
    if (recentChanges.length >= 2) {
        const lastTwo = recentChanges.slice(-2);
        if (lastTwo.every(c => c < -STABLE_TOLERANCE)) {
            return {
                trendState: TrendState.RECOVERING,
                rateOfChange: avgRateOfChange,
                message: `Bounce rate recovering: last 2 windows improved by ${lastTwo.map(c => `${(c * 100).toFixed(1)}%`).join(', ')}`,
            };
        }
    }

    // ── STABLE: Last 3 windows within ±1% ──
    if (lastThree.length >= 3) {
        const rates = lastThree.map(w => w.bounceRate);
        const maxRate = Math.max(...rates);
        const minRate = Math.min(...rates);
        if ((maxRate - minRate) <= STABLE_TOLERANCE) {
            return {
                trendState: TrendState.STABLE,
                rateOfChange: avgRateOfChange,
                message: `Bounce rate stable: variance ${((maxRate - minRate) * 100).toFixed(2)}% across 3 windows`,
            };
        }
    }

    // Default: stable
    return {
        trendState: TrendState.STABLE,
        rateOfChange: avgRateOfChange,
        message: `No clear trend pattern — defaulting to stable`,
    };
}

/**
 * Produce an insufficient data result.
 */
function makeInsufficientResult(message: string): TrajectoryResult {
    return {
        trendState: TrendState.STABLE,
        dataQuality: DataQuality.INSUFFICIENT,
        windows: [],
        totalSends: 0,
        windowCount: 0,
        rateOfChange: 0,
        message,
    };
}
