/**
 * Warmup Dispatch Worker — sends scheduled WarmupExchange rows.
 *
 * Cadence: every 60 seconds. On each tick:
 *   1. Pull WarmupExchange rows where state='scheduled' AND
 *      scheduled_at <= now. Cap per-tick to BATCH_SIZE so a backlog
 *      doesn't blow our SMTP rate limits in one burst.
 *   2. For each:
 *      - Render subject + body fresh from the content engine.
 *        (The 3B+ permutation count is realized HERE — generation is
 *         per-send so two scheduled rows for the same mailbox get
 *         different rendered emails.)
 *      - Send via warmupSendService (isolated from production path).
 *      - Update the row: state='sent', sent_at, message_id, subject,
 *        body_preview (200 chars).
 *      - Increment the sender membership's total_sent counter.
 *   3. On send failure: state='failed', error captured.
 *
 * Concurrency: serial inside this worker (one mailbox at a time per
 * tick). Cross-mailbox parallelism comes from the cap on BATCH_SIZE
 * and the schedule jitter spreading sends across many ticks.
 */

import { prisma } from '../index';
import { logger } from '../services/observabilityService';
import { generateInitialMessage, generateThreadReply } from '../services/warmup/contentService';
import { sendWarmupEmail } from '../services/warmup/warmupSendService';

const TICK_INTERVAL_MS = 60 * 1000;
const BATCH_SIZE = 25;

let timer: NodeJS.Timeout | null = null;
let stopped = false;
let running = false;

/** First-200-chars preview, plain-text-stripped for HTML bodies. */
function preview(body: string, isHtml: boolean): string {
    const text = isHtml
        ? body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
        : body;
    return text.slice(0, 200);
}

async function dispatchOne(exchangeId: string): Promise<void> {
    // Atomic claim — flip 'scheduled' → 'sent' guard so two workers
    // running concurrently can't double-send the same row.
    const claimed = await prisma.warmupExchange.updateMany({
        where: { id: exchangeId, state: 'scheduled' },
        data: { state: 'sent' /* tentative — corrected on failure */ },
    });
    if (claimed.count === 0) return; // someone else got it

    const ex = await prisma.warmupExchange.findUnique({ where: { id: exchangeId } });
    if (!ex) return;

    const recipient = await prisma.mailbox.findUnique({
        where: { id: ex.recipient_mailbox_id },
        select: { email: true },
    });
    if (!recipient) {
        await prisma.warmupExchange.update({
            where: { id: exchangeId },
            data: { state: 'failed', error: 'Recipient mailbox not found' },
        });
        return;
    }

    const senderMailbox = await prisma.mailbox.findUnique({
        where: { id: ex.sender_mailbox_id },
        select: {
            connected_account_id: true,
            connectedAccount: { select: { display_name: true, email: true } },
        },
    });
    if (!senderMailbox?.connected_account_id) {
        await prisma.warmupExchange.update({
            where: { id: exchangeId },
            data: { state: 'failed', error: 'Sender has no connected account' },
        });
        return;
    }

    const senderName =
        senderMailbox.connectedAccount?.display_name?.trim() ||
        senderMailbox.connectedAccount?.email?.split('@')[0] ||
        null;

    // Render fresh content. Replies use a different generator + carry
    // threading headers from the parent.
    let content: { subject: string; body: string; isHtml: boolean };
    let inReplyTo: string | null = null;
    let references: string | null = null;

    if (ex.thread_depth > 0 && ex.thread_id) {
        // Find the immediate parent in the thread to lift its
        // message_id and subject for proper threading headers.
        const parent = await prisma.warmupExchange.findFirst({
            where: { thread_id: ex.thread_id, thread_depth: ex.thread_depth - 1 },
            select: { message_id: true, subject: true },
            orderBy: { sent_at: 'desc' },
        });
        const parentSubject = parent?.subject ?? 'Hi';
        content = await generateThreadReply({ subject: parentSubject, depth: ex.thread_depth });
        inReplyTo = parent?.message_id ? `<${parent.message_id}>` : null;
        references = inReplyTo;
    } else {
        content = await generateInitialMessage({ senderName });
    }

    const result = await sendWarmupEmail({
        exchangeId: ex.id,
        senderMailboxId: ex.sender_mailbox_id,
        senderConnectedAccountId: senderMailbox.connected_account_id,
        recipientMailboxId: ex.recipient_mailbox_id,
        recipientEmail: recipient.email,
        subject: content.subject,
        body: content.body,
        isHtml: content.isHtml,
        inReplyToMessageId: inReplyTo,
        referencesHeader: references,
    });

    if (!result.success) {
        await prisma.warmupExchange.update({
            where: { id: exchangeId },
            data: { state: 'failed', error: result.error?.slice(0, 500) ?? 'unknown' },
        });
        return;
    }

    // Persist the rendered content + message id + thread_id. For
    // initial messages, thread_id = our own id so replies can join.
    const finalThreadId = ex.thread_id || ex.id;
    await prisma.warmupExchange.update({
        where: { id: exchangeId },
        data: {
            state: 'sent',
            sent_at: new Date(),
            message_id: result.messageId,
            subject: content.subject.slice(0, 500),
            body_preview: preview(content.body, content.isHtml),
            thread_id: finalThreadId,
        },
    });

    // Increment sender membership counter (separate from production stats).
    await prisma.warmupPoolMembership.update({
        where: { id: ex.sender_membership_id },
        data: { total_sent: { increment: 1 } },
    });
}

async function tick(): Promise<void> {
    if (running || stopped) return;
    running = true;
    try {
        const due = await prisma.warmupExchange.findMany({
            where: {
                state: 'scheduled',
                scheduled_at: { lte: new Date() },
            },
            select: { id: true },
            orderBy: { scheduled_at: 'asc' },
            take: BATCH_SIZE,
        });
        if (due.length === 0) return;

        for (const e of due) {
            if (stopped) break;
            try {
                await dispatchOne(e.id);
            } catch (err) {
                logger.error(
                    '[WARMUP_DISPATCH] dispatchOne crashed',
                    err instanceof Error ? err : new Error(String(err)),
                    { exchangeId: e.id },
                );
            }
        }
        logger.info('[WARMUP_DISPATCH] tick complete', { dispatched: due.length });
    } finally {
        running = false;
    }
}

export function startWarmupDispatchWorker(): void {
    if (timer) return;
    stopped = false;
    timer = setInterval(() => { tick().catch(() => undefined); }, TICK_INTERVAL_MS);
    logger.info('[WARMUP_DISPATCH_WORKER] started', { intervalMs: TICK_INTERVAL_MS });
}

export function stopWarmupDispatchWorker(): void {
    stopped = true;
    if (timer) {
        clearInterval(timer);
        timer = null;
        logger.info('[WARMUP_DISPATCH_WORKER] stopped');
    }
}
