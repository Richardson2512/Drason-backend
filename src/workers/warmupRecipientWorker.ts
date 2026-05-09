/**
 * Warmup Recipient Worker — recipient-side actions on warmup emails.
 *
 * Cadence: every 5 minutes. On each tick:
 *   1. Pull recently-sent WarmupExchange rows that the recipient hasn't
 *      yet processed (state='sent', no opened_at, message_id set).
 *   2. Group by recipient mailbox so we open one IMAP connection per
 *      mailbox per tick (not per row).
 *   3. For each row, in the recipient's mailbox:
 *      a. Locate the message (by X-Superkabe-Warmup header)
 *         across INBOX / Promotions / Spam folders.
 *      b. If found: mark as read; if in spam → MOVE to inbox
 *         ("report not spam"); record landed_in.
 *      c. With probability REPLY_PROBABILITY (0.6), if thread_depth <
 *         MAX_THREAD_DEPTH, queue a reply WarmupExchange for the
 *         original sender (recipient becomes the reply's sender).
 *   4. Skip any message older than the freshness window — if the
 *      recipient hasn't picked it up in 6 hours, it's almost certainly
 *      undeliverable / quarantined upstream. Mark exchange state
 *      'bounced' for accounting.
 *
 * Data isolation reminder: this worker NEVER creates EmailThread or
 * EmailMessage rows. The unibox is unaware of warmup activity.
 */

import { prisma } from '../index';
import { logger } from '../services/observabilityService';
import { signWarmupHeader } from '../services/warmup/contentService';
import { processIncomingWarmup, type RecipientCredentials } from '../services/warmup/engagementService';
import { MAX_THREAD_DEPTH, REPLY_PROBABILITY } from '../services/warmup/types';

const TICK_INTERVAL_MS = 5 * 60 * 1000;
const BATCH_SIZE = 50;
const FRESHNESS_HOURS = 6;
/** Replies are scheduled 5 min – 8 hours after the original send so
 *  the conversation looks paced rather than instant-bot. */
const REPLY_LATENCY_MIN_MS = 5 * 60 * 1000;
const REPLY_LATENCY_MAX_MS = 8 * 60 * 60 * 1000;

let timer: NodeJS.Timeout | null = null;
let stopped = false;
let running = false;

interface RecipientCtx {
    mailboxId: string;
    creds: RecipientCredentials;
}

/** Resolve IMAP credentials for a recipient mailbox. Returns null if
 *  the mailbox lacks IMAP — that mailbox can still SEND warmup but
 *  can't perform engagement actions. */
async function loadRecipientCreds(mailboxId: string): Promise<RecipientCtx | null> {
    const mailbox = await prisma.mailbox.findUnique({
        where: { id: mailboxId },
        select: {
            email: true,
            connectedAccount: {
                select: {
                    email: true,
                    smtp_username: true,
                    imap_host: true,
                    imap_port: true,
                    smtp_password: true,
                    provider: true,
                },
            },
        },
    });
    if (!mailbox?.connectedAccount) return null;
    const ca = mailbox.connectedAccount;
    if (!ca.imap_host || !ca.smtp_password) {
        // OAuth-only accounts without SMTP creds can't be IMAP-polled
        // here. Future: add OAuth XOAUTH2 IMAP support.
        return null;
    }
    return {
        mailboxId,
        creds: {
            email: ca.email,
            imapHost: ca.imap_host,
            imapPort: ca.imap_port || 993,
            imapUser: ca.smtp_username || ca.email,
            imapPassword: ca.smtp_password,
        },
    };
}

function nextReplyScheduledAt(): Date {
    const ms = REPLY_LATENCY_MIN_MS + Math.floor(Math.random() * (REPLY_LATENCY_MAX_MS - REPLY_LATENCY_MIN_MS));
    return new Date(Date.now() + ms);
}

async function processOne(exchange: {
    id: string;
    sender_mailbox_id: string;
    sender_membership_id: string;
    recipient_mailbox_id: string;
    recipient_membership_id: string;
    thread_id: string;
    thread_depth: number;
    subject: string;
    sent_at: Date | null;
}, recipientCtx: RecipientCtx): Promise<void> {
    if (!exchange.sent_at) return;

    const ageMs = Date.now() - exchange.sent_at.getTime();
    if (ageMs > FRESHNESS_HOURS * 60 * 60 * 1000) {
        // Too old to plausibly still be undelivered. Mark as bounced
        // (warmup-only — not the production bounce path).
        await prisma.warmupExchange.update({
            where: { id: exchange.id },
            data: { state: 'bounced', error: 'Message not found in recipient mailbox after freshness window' },
        });
        return;
    }

    const headerValue = signWarmupHeader({
        exchangeId: exchange.id,
        senderMailboxId: exchange.sender_mailbox_id,
        recipientMailboxId: exchange.recipient_mailbox_id,
    });

    const outcome = await processIncomingWarmup({
        creds: recipientCtx.creds,
        headerValue,
    });

    if (!outcome.found) {
        // Not yet delivered. Leave state='sent' and try again next tick.
        return;
    }

    // Persist the engagement outcome.
    await prisma.warmupExchange.update({
        where: { id: exchange.id },
        data: {
            state: outcome.recovered ? 'recovered_from_spam' : 'opened',
            delivered_at: new Date(),
            opened_at: outcome.markedRead ? new Date() : null,
            recovered_at: outcome.recovered ? new Date() : null,
            landed_in: outcome.landedIn,
        },
    });

    // Update recipient + sender membership counters.
    const recipientCounterUpdate: any = { total_received: { increment: 1 } };
    if (outcome.markedRead) recipientCounterUpdate.total_opened = { increment: 1 };
    if (outcome.recovered) recipientCounterUpdate.total_recovered_from_spam = { increment: 1 };
    await prisma.warmupPoolMembership.update({
        where: { id: exchange.recipient_membership_id },
        data: recipientCounterUpdate,
    });

    // Decide reply (and only if not already at max depth).
    if (exchange.thread_depth >= MAX_THREAD_DEPTH) return;
    if (Math.random() >= REPLY_PROBABILITY) return;

    // Queue a reply: roles flip — recipient becomes sender.
    await prisma.warmupExchange.create({
        data: {
            sender_mailbox_id: exchange.recipient_mailbox_id,
            sender_membership_id: exchange.recipient_membership_id,
            recipient_mailbox_id: exchange.sender_mailbox_id,
            recipient_membership_id: exchange.sender_membership_id,
            subject: '(pending-reply)',
            body_preview: '(pending-reply)',
            thread_id: exchange.thread_id,
            thread_depth: exchange.thread_depth + 1,
            state: 'scheduled',
            scheduled_at: nextReplyScheduledAt(),
        },
    });
}

async function tick(): Promise<void> {
    if (running || stopped) return;
    running = true;
    try {
        const pending = await prisma.warmupExchange.findMany({
            where: {
                state: 'sent',
                opened_at: null,
                message_id: { not: null },
            },
            select: {
                id: true,
                sender_mailbox_id: true,
                sender_membership_id: true,
                recipient_mailbox_id: true,
                recipient_membership_id: true,
                thread_id: true,
                thread_depth: true,
                subject: true,
                sent_at: true,
            },
            orderBy: { sent_at: 'asc' },
            take: BATCH_SIZE,
        });
        if (pending.length === 0) return;

        // Group by recipient mailbox to amortize the IMAP connect cost.
        const byRecipient = new Map<string, typeof pending>();
        for (const p of pending) {
            const arr = byRecipient.get(p.recipient_mailbox_id) ?? [];
            arr.push(p);
            byRecipient.set(p.recipient_mailbox_id, arr);
        }

        for (const [mailboxId, exchanges] of byRecipient) {
            if (stopped) break;
            const ctx = await loadRecipientCreds(mailboxId);
            if (!ctx) continue;

            for (const ex of exchanges) {
                if (stopped) break;
                try {
                    await processOne(ex, ctx);
                } catch (err) {
                    logger.warn('[WARMUP_RECIPIENT] processOne failed', {
                        exchangeId: ex.id,
                        err: (err as Error)?.message,
                    });
                }
            }
        }

        logger.info('[WARMUP_RECIPIENT] tick processed', { exchanges: pending.length });
    } finally {
        running = false;
    }
}

export function startWarmupRecipientWorker(): void {
    if (timer) return;
    stopped = false;
    timer = setInterval(() => { tick().catch(() => undefined); }, TICK_INTERVAL_MS);
    logger.info('[WARMUP_RECIPIENT_WORKER] started', { intervalMs: TICK_INTERVAL_MS });
}

export function stopWarmupRecipientWorker(): void {
    stopped = true;
    if (timer) {
        clearInterval(timer);
        timer = null;
        logger.info('[WARMUP_RECIPIENT_WORKER] stopped');
    }
}
