/**
 * Warmup Ramp Worker - daily volume cadence + spam-rate adaptation.
 *
 * Cadence: every 6 hours (idempotent - only the first tick after
 * midnight UTC actually mutates ramp state; later ticks are no-ops).
 *
 * On each tick (after the daily threshold):
 *   1. For every active membership:
 *      a. Recompute spam_rate_30d from WarmupExchange landed_in over
 *         the last 30 days.
 *      b. Decide next ramp step via membershipService.decideNextRamp:
 *         - spam_rate_30d ≥ ERROR threshold → flip to health='error'
 *         - spam_rate_30d ≥ PAUSE threshold → hold ramp, keep current
 *           daily volume
 *         - otherwise → advance ramp_step by 1, recompute current_daily
 *      c. Persist.
 *   2. Stamp last_ramp_advance_date so subsequent ticks today are no-ops.
 */

import { prisma } from '../index';
import { logger } from '../services/observabilityService';
import { computeSpamRate, decideNextRamp } from '../services/warmup/membershipService';

const TICK_INTERVAL_MS = 6 * 60 * 60 * 1000;
let timer: NodeJS.Timeout | null = null;
let stopped = false;
let running = false;

/** Yesterday-aware idempotency: store the last UTC date we advanced
 *  ramp on so multiple 6h ticks per day don't double-advance. We
 *  encode this on the membership row's updated_at + an in-process
 *  guard. The cleanest persistence would be a dedicated column
 *  (last_ramp_advanced_on Date), which we'll add when the next
 *  schema change goes through. For now we use the "if updated_at is
 *  today UTC" heuristic, which is safe because nothing else updates
 *  the row this frequently in v1. */
function isSameUtcDate(a: Date, b: Date): boolean {
    return a.getUTCFullYear() === b.getUTCFullYear()
        && a.getUTCMonth() === b.getUTCMonth()
        && a.getUTCDate() === b.getUTCDate();
}

async function processMembership(membership: {
    id: string;
    mailbox_id: string;
    enabled: boolean;
    start_daily: number;
    target_daily: number;
    ramp_days: number;
    ramp_step: number;
    maintenance_daily: number;
    updated_at: Date;
}): Promise<void> {
    const now = new Date();
    if (isSameUtcDate(membership.updated_at, now)) {
        // Already advanced today.
        return;
    }

    const spamRate = await computeSpamRate(membership.mailbox_id);
    const decision = decideNextRamp({
        rampStep: membership.ramp_step,
        startDaily: membership.start_daily,
        targetDaily: membership.target_daily,
        rampDays: membership.ramp_days,
        maintenanceDaily: membership.maintenance_daily,
        spamRate30d: spamRate,
        enabled: membership.enabled,
    });

    await prisma.warmupPoolMembership.update({
        where: { id: membership.id },
        data: {
            ramp_step: decision.nextRampStep,
            current_daily: decision.nextDaily,
            health: decision.nextHealth,
            spam_rate_30d: spamRate,
            last_error: decision.nextHealth === 'error'
                ? `Spam rate ${(spamRate ?? 0).toFixed(3)} exceeded error threshold - operator review required.`
                : null,
        },
    });

    if (decision.rampPaused) {
        logger.info('[WARMUP_RAMP] held ramp due to spam rate', {
            membershipId: membership.id,
            spamRate,
            nextDaily: decision.nextDaily,
            health: decision.nextHealth,
        });
    }
}

async function tick(): Promise<void> {
    if (running || stopped) return;
    running = true;
    try {
        const memberships = await prisma.warmupPoolMembership.findMany({
            select: {
                id: true,
                mailbox_id: true,
                enabled: true,
                start_daily: true,
                target_daily: true,
                ramp_days: true,
                ramp_step: true,
                maintenance_daily: true,
                updated_at: true,
            },
        });
        if (memberships.length === 0) return;

        let advanced = 0;
        for (const m of memberships) {
            if (stopped) break;
            try {
                const before = m.updated_at.getTime();
                await processMembership(m);
                const fresh = await prisma.warmupPoolMembership.findUnique({
                    where: { id: m.id },
                    select: { updated_at: true },
                });
                if (fresh && fresh.updated_at.getTime() > before) advanced += 1;
            } catch (err) {
                logger.warn('[WARMUP_RAMP] processMembership failed', {
                    membershipId: m.id,
                    err: (err as Error)?.message,
                });
            }
        }

        if (advanced > 0) {
            logger.info('[WARMUP_RAMP] tick advanced memberships', { advanced, total: memberships.length });
        }
    } finally {
        running = false;
    }
}

export function startWarmupRampWorker(): void {
    if (timer) return;
    stopped = false;
    timer = setInterval(() => { tick().catch(() => undefined); }, TICK_INTERVAL_MS);
    // Run once at startup so a fresh deploy doesn't wait 6h.
    tick().catch(() => undefined);
    logger.info('[WARMUP_RAMP_WORKER] started', { intervalMs: TICK_INTERVAL_MS });
}

export function stopWarmupRampWorker(): void {
    stopped = true;
    if (timer) {
        clearInterval(timer);
        timer = null;
        logger.info('[WARMUP_RAMP_WORKER] stopped');
    }
}
