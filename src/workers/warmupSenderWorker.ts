/**
 * Warmup Sender Worker — schedules warmup sends across the pool.
 *
 * Cadence: every 15 minutes. On each tick:
 *   1. Find all opted-in memberships whose org has consent on AND who
 *      haven't yet hit today's allotted current_daily.
 *   2. For each, decide how many sends to queue this tick: spread the
 *      remaining day budget evenly across the remaining 15-min slots
 *      until the end of the sender's business day.
 *   3. Pair sender ↔ recipient via poolService.pickRecipient (cross-org,
 *      cross-domain, anti-recently-paired).
 *   4. INSERT a WarmupExchange row with state='scheduled' and a
 *      scheduled_at jittered within the next 15 minutes.
 *
 * This worker only enqueues. Actual SMTP send is the dispatch worker's
 * job. Keeping schedule + send separate means a slow Jina/SMTP doesn't
 * starve the scheduling loop.
 */

import { prisma } from '../prisma';
import { logger } from '../services/observabilityService';
import { pickRecipient } from '../services/warmup/poolService';

const TICK_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const SLOT_WINDOW_MS = 15 * 60 * 1000;   // schedule jitter range = next 15 min
const BUSINESS_DAY_HOURS_START = 9;      // 09:00 sender-local
const BUSINESS_DAY_HOURS_END = 18;       // 18:00 sender-local

let timer: NodeJS.Timeout | null = null;
let stopped = false;
let running = false;

/** Compute how many sends are still owed today for this membership. */
function remainingForToday(opts: {
    currentDaily: number;
    sentToday: number;
}): number {
    return Math.max(0, opts.currentDaily - opts.sentToday);
}

/** Spread remaining sends evenly across remaining 15-min slots in the
 *  business day. Bursting the entire day's volume in one tick is what
 *  spam filters notice. */
function chunkForThisTick(opts: {
    remaining: number;
    remainingTicks: number;
}): number {
    if (opts.remainingTicks <= 0) return opts.remaining;
    return Math.max(1, Math.ceil(opts.remaining / opts.remainingTicks));
}

function nextRandomScheduleAt(): Date {
    const ms = Math.floor(Math.random() * SLOT_WINDOW_MS);
    return new Date(Date.now() + ms);
}

/** Coarse "is sender within business hours" gate. Future polish: pull
 *  the mailbox's timezone from the existing mailbox/Sequencer settings.
 *  v1 uses the server's local TZ as a proxy — fine for a single-region
 *  deployment, doesn't break correctness if wrong. */
function isWithinBusinessHours(now: Date): boolean {
    const hour = now.getHours();
    return hour >= BUSINESS_DAY_HOURS_START && hour < BUSINESS_DAY_HOURS_END;
}

function remainingTicksToday(now: Date): number {
    const closeMs = new Date(now).setHours(BUSINESS_DAY_HOURS_END, 0, 0, 0);
    const remaining = closeMs - now.getTime();
    return Math.max(1, Math.floor(remaining / TICK_INTERVAL_MS));
}

async function scheduleForMembership(membership: {
    id: string;
    mailbox_id: string;
    organization_id: string;
    current_daily: number;
}): Promise<number> {
    // Count how many sends were already scheduled / sent today for this
    // mailbox (warmup only — production sends accounted separately).
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const sentToday = await prisma.warmupExchange.count({
        where: {
            sender_mailbox_id: membership.mailbox_id,
            created_at: { gte: startOfDay },
        },
    });

    const remaining = remainingForToday({ currentDaily: membership.current_daily, sentToday });
    if (remaining === 0) return 0;

    const ticksLeft = remainingTicksToday(new Date());
    const target = Math.min(remaining, chunkForThisTick({ remaining, remainingTicks: ticksLeft }));

    let scheduled = 0;
    for (let i = 0; i < target; i++) {
        const senderMailbox = await prisma.mailbox.findUnique({
            where: { id: membership.mailbox_id },
            select: { id: true, organization_id: true, domain_id: true },
        });
        if (!senderMailbox) break;

        const recipient = await pickRecipient({
            senderMailboxId: senderMailbox.id,
            senderOrgId: senderMailbox.organization_id,
            senderDomainId: senderMailbox.domain_id,
        });
        if (!recipient) {
            // Pool exhausted for now — try again next tick.
            break;
        }

        // Subject + body are NOT generated here — they're rendered at
        // dispatch time by the dispatch worker, so each scheduled send
        // gets a fresh permutation right before going out. We only store
        // a placeholder subject; dispatch overwrites it with the real
        // generated subject after rendering.
        await prisma.warmupExchange.create({
            data: {
                sender_mailbox_id: senderMailbox.id,
                sender_membership_id: membership.id,
                recipient_mailbox_id: recipient.mailboxId,
                recipient_membership_id: recipient.membershipId,
                subject: '(pending)',
                body_preview: '(pending)',
                thread_id: '',  // populated at dispatch with the row's own id
                thread_depth: 0,
                state: 'scheduled',
                scheduled_at: nextRandomScheduleAt(),
            },
        });
        scheduled += 1;
    }
    return scheduled;
}

async function tick(): Promise<void> {
    if (running || stopped) return;
    running = true;
    try {
        if (!isWithinBusinessHours(new Date())) {
            // Outside business hours — don't schedule. Existing scheduled
            // rows from earlier today will still be dispatched by the
            // other worker as long as their scheduled_at has arrived.
            return;
        }

        const memberships = await prisma.warmupPoolMembership.findMany({
            where: {
                enabled: true,
                health: { in: ['warming', 'maintenance'] },
                organization: { warmup_pool_consent: true },
            },
            select: {
                id: true,
                mailbox_id: true,
                organization_id: true,
                current_daily: true,
            },
            // Process oldest first so newer pool joiners don't steal
            // pair slots from members already deep into their ramp.
            orderBy: { joined_at: 'asc' },
            take: 200, // cap per-tick batch — large pools spread across ticks
        });

        let totalScheduled = 0;
        for (const m of memberships) {
            if (stopped) break;
            try {
                totalScheduled += await scheduleForMembership(m);
            } catch (err) {
                logger.warn('[WARMUP_SENDER] schedule failed', {
                    membershipId: m.id,
                    err: (err as Error)?.message,
                });
            }
        }

        if (totalScheduled > 0) {
            logger.info('[WARMUP_SENDER] tick scheduled', {
                memberships: memberships.length,
                scheduled: totalScheduled,
            });
        }
    } finally {
        running = false;
    }
}

export function startWarmupSenderWorker(): void {
    if (timer) return;
    stopped = false;
    timer = setInterval(() => { tick().catch(() => undefined); }, TICK_INTERVAL_MS);
    // Run once at startup so the first tick doesn't wait 15 minutes.
    tick().catch(() => undefined);
    logger.info('[WARMUP_SENDER_WORKER] started', { intervalMs: TICK_INTERVAL_MS });
}

export function stopWarmupSenderWorker(): void {
    stopped = true;
    if (timer) {
        clearInterval(timer);
        timer = null;
        logger.info('[WARMUP_SENDER_WORKER] stopped');
    }
}
