/**
 * Dedicated-IP worker — drives the Super Sender state machine.
 *
 * Two responsibilities, one tick loop:
 *
 *   1. PROVISIONING — for every row in `state='provisioning'`:
 *        a. If ses_pool_name is null, call SES provisionDedicatedIp.
 *        b. Else, poll getDedicatedIpStatus. AVAILABLE → state='warming',
 *           activated_at=NOW, warmup_day=0, daily_cap=initial cap.
 *
 *   2. WARMING — for every row in `state='warming'`:
 *        a. If activated_at is yesterday or earlier, increment warmup_day.
 *        b. Recompute daily_cap from the ramp curve.
 *        c. warmup_day >= WARMUP_DAYS → state='active', daily_cap=full,
 *           warmup_completed_at=NOW.
 *
 * Cancellation is event-driven (webhook handler) — not polled here.
 *
 * Tick cadence: every 5 minutes. Provisioning shouldn't take more than
 * an hour in real mode; warmup is a daily increment so any cadence is
 * fine. 5min is a sweet spot — fast enough that the UI feels live in
 * stub mode (where provisioning completes in 10s), slow enough that
 * SES rate limits don't matter.
 */

import { prisma } from '../prisma';
import { logger } from '../services/observabilityService';
import {
    provisionDedicatedIp,
    getDedicatedIpStatus,
    type SesIpStatus,
} from '../services/sesProvisioningService';
import { WARMUP_DAYS } from '../services/superSenderService';

const TICK_INTERVAL_MS = 5 * 60 * 1000;
const PROVISION_BATCH = 10;
const WARMING_BATCH = 50;

/** Initial daily cap on day 1. AWS SES recommends starting around 50/day
 *  on a fresh dedicated IP and ramping to 50,000 over ~30 days. */
const INITIAL_DAILY_CAP = 50;
/** Cap on day 30+ (after ramp completion). */
const FULL_DAILY_CAP = 50_000;

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;
let stopped = false;

function rampCap(day: number): number {
    if (day <= 0) return INITIAL_DAILY_CAP;
    if (day >= WARMUP_DAYS) return FULL_DAILY_CAP;
    // Geometric ramp — doubles roughly every 3 days, lands at FULL_DAILY_CAP
    // on day WARMUP_DAYS. SES's published guidance is non-linear; geometric
    // is the closest single-line approximation.
    const ratio = day / WARMUP_DAYS;
    const cap = Math.round(INITIAL_DAILY_CAP * Math.pow(FULL_DAILY_CAP / INITIAL_DAILY_CAP, ratio));
    return Math.max(INITIAL_DAILY_CAP, Math.min(FULL_DAILY_CAP, cap));
}

async function processProvisioning(): Promise<{ moved: number }> {
    const rows = await prisma.dedicatedIp.findMany({
        where: { state: 'provisioning' },
        take: PROVISION_BATCH,
        orderBy: { created_at: 'asc' },
    });
    let moved = 0;
    for (const row of rows) {
        try {
            // First-touch — call SES to create the pool.
            if (!row.ses_pool_name) {
                const result = await provisionDedicatedIp({
                    accountId: row.account_id,
                    ipId: row.id,
                });
                await prisma.dedicatedIp.update({
                    where: { id: row.id },
                    data: {
                        ses_pool_name: result.poolName,
                        ses_ip_address: result.ipAddress,
                        last_error: null,
                    },
                });
                continue;
            }

            // Subsequent ticks — poll readiness.
            let status: SesIpStatus;
            try {
                status = await getDedicatedIpStatus(row.ses_pool_name);
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                logger.warn('[DEDICATED_IP_WORKER] status poll failed', { ipId: row.id, msg });
                continue; // retry next tick
            }

            if (status === 'AVAILABLE') {
                await prisma.dedicatedIp.update({
                    where: { id: row.id },
                    data: {
                        state: 'warming',
                        activated_at: new Date(),
                        warmup_day: 0,
                        daily_cap: INITIAL_DAILY_CAP,
                        last_error: null,
                    },
                });
                moved += 1;
                logger.info('[DEDICATED_IP_WORKER] provisioning → warming', { ipId: row.id });
            } else if (status === 'FAILED') {
                await prisma.dedicatedIp.update({
                    where: { id: row.id },
                    data: { state: 'failed', last_error: 'SES reported provisioning failure' },
                });
                moved += 1;
            }
            // PENDING / IN_PROGRESS — leave for next tick.
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.error('[DEDICATED_IP_WORKER] provisioning row failed', err instanceof Error ? err : new Error(msg), { ipId: row.id });
            await prisma.dedicatedIp.update({
                where: { id: row.id },
                data: { last_error: msg.slice(0, 500) },
            });
        }
    }
    return { moved };
}

async function processWarming(): Promise<{ advanced: number }> {
    const rows = await prisma.dedicatedIp.findMany({
        where: { state: 'warming' },
        take: WARMING_BATCH,
    });
    let advanced = 0;
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    for (const row of rows) {
        try {
            const activatedAt = row.activated_at;
            if (!activatedAt) continue;
            const activatedDay = new Date(activatedAt);
            activatedDay.setHours(0, 0, 0, 0);
            const expectedDay = Math.max(0, Math.floor((today.getTime() - activatedDay.getTime()) / (24 * 60 * 60 * 1000)));

            if (expectedDay <= row.warmup_day) {
                // Already advanced today; nothing to do until tomorrow.
                continue;
            }

            const newDay = expectedDay;
            if (newDay >= WARMUP_DAYS) {
                await prisma.dedicatedIp.update({
                    where: { id: row.id },
                    data: {
                        state: 'active',
                        warmup_day: WARMUP_DAYS,
                        daily_cap: FULL_DAILY_CAP,
                        warmup_completed_at: new Date(),
                    },
                });
                logger.info('[DEDICATED_IP_WORKER] warming → active', { ipId: row.id });
            } else {
                await prisma.dedicatedIp.update({
                    where: { id: row.id },
                    data: {
                        warmup_day: newDay,
                        daily_cap: rampCap(newDay),
                    },
                });
            }
            advanced += 1;
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.warn('[DEDICATED_IP_WORKER] warming row failed', { ipId: row.id, msg });
        }
    }
    return { advanced };
}

/** Decay 24h aggregate counters once a day so the bounce/complaint pause
 *  decision uses a rolling window. We don't store per-event timestamps
 *  in the aggregate — DedicatedIpEvent has the raw events for forensics —
 *  so this is a flat reset, executed when sends_reset_at rolls. Conservative
 *  but correct: a paused IP stays paused until manually unpaused even if
 *  counters reset. */
async function decayFeedbackAggregates(): Promise<void> {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await prisma.dedicatedIp.updateMany({
        where: {
            state: { in: ['warming', 'active'] },
            sends_reset_at: { lt: cutoff },
        },
        data: {
            bounce_count_24h: 0,
            complaint_count_24h: 0,
            delivered_count_24h: 0,
        },
    });
}

async function tick(): Promise<void> {
    if (running || stopped) return;
    running = true;
    try {
        const prov = await processProvisioning();
        const warm = await processWarming();
        await decayFeedbackAggregates();
        if (prov.moved > 0 || warm.advanced > 0) {
            logger.info('[DEDICATED_IP_WORKER] tick', { provMoved: prov.moved, warmAdvanced: warm.advanced });
        }
    } finally {
        running = false;
    }
}

export function startDedicatedIpWorker(): void {
    if (timer) return;
    stopped = false;
    timer = setInterval(() => { tick().catch(() => undefined); }, TICK_INTERVAL_MS);
    // Run once at startup so a fresh deploy doesn't wait 5min for the
    // first transitions — this matters most in stub mode where the
    // entire provisioning cycle is ~10s.
    tick().catch(() => undefined);
    logger.info('[DEDICATED_IP_WORKER] started', { intervalMs: TICK_INTERVAL_MS });
}

export function stopDedicatedIpWorker(): void {
    stopped = true;
    if (timer) {
        clearInterval(timer);
        timer = null;
        logger.info('[DEDICATED_IP_WORKER] stopped');
    }
}

// Export for tests.
export { rampCap as _rampCap };
