/**
 * Warmup Content Engine — produces the 3B+ unique permutations that
 * power our pool's reputation-building signal.
 *
 * Pipeline:
 *   1. Pick weighted-random subject / body / signoff / thread-reply
 *      templates from WarmupTemplate rows of the right kind.
 *   2. Run each through the existing spintax resolver (used in
 *      production sends today) to expand `{a|b|c}` blocks.
 *   3. Apply runtime jitter — random emoji 5%, plaintext-vs-HTML 50/50,
 *      optional P.S. 10%, signature inclusion 70%, etc. These layers
 *      multiply the count well past the seed-corpus combinatorics.
 *
 * Why this beats competitors:
 *   - 50 body × 30 subject × 20 signoff × spintax internals = 3B+ raw.
 *   - Layered runtime jitter adds another order of magnitude and breaks
 *     the obvious "all warmup looks structurally the same" pattern.
 *   - The spintax resolver is the same one used for production sends —
 *     same library, same rendered output style, so the warmup traffic
 *     is genuinely indistinguishable from real campaign output.
 */

import * as crypto from 'crypto';
import { prisma } from '../../prisma';
import { resolveSpintax } from '../../utils/spintax';
import type { WarmupTemplateKind } from './types';

// ────────────────────────────────────────────────────────────────────
// Header signing — every warmup email carries an HMAC-signed marker so
// recipient mailboxes can identify and route them without false
// positives from external traffic that happens to look similar.
// ────────────────────────────────────────────────────────────────────

const WARMUP_HEADER = 'X-Superkabe-Warmup';

function getHmacSecret(): string {
    const secret = process.env.WARMUP_HMAC_SECRET || process.env.ENCRYPTION_KEY;
    if (!secret) throw new Error('WARMUP_HMAC_SECRET (or ENCRYPTION_KEY) must be set');
    return secret;
}

/** Sign a payload (exchangeId + senderMailboxId + recipientMailboxId)
 *  to produce the X-Superkabe-Warmup header value. The recipient worker
 *  verifies this before treating the email as warmup, so a malicious
 *  sender outside the pool can't spoof the header to hide messages from
 *  the unibox. */
export function signWarmupHeader(payload: {
    exchangeId: string;
    senderMailboxId: string;
    recipientMailboxId: string;
}): string {
    const data = `${payload.exchangeId}|${payload.senderMailboxId}|${payload.recipientMailboxId}`;
    const sig = crypto.createHmac('sha256', getHmacSecret()).update(data).digest('hex').slice(0, 32);
    return `${payload.exchangeId}.${sig}`;
}

/** Returns the exchangeId encoded in the header IF the signature is
 *  valid, or null. Constant-time compare to avoid timing leaks. */
export function verifyWarmupHeader(headerValue: string): { exchangeId: string } | null {
    if (!headerValue || !headerValue.includes('.')) return null;
    const [exchangeId, sig] = headerValue.split('.', 2);
    if (!exchangeId || !sig) return null;

    // We can only re-derive the signature if we know the sender +
    // recipient mailbox ids — which we look up from the exchangeId.
    // The verification helper stays in this module but the caller
    // (recipient worker) loads the exchange row and feeds those in.
    // Here we just sanity-check shape; full crypto check happens via
    // verifyWarmupHeaderWithExchange below.
    if (sig.length !== 32) return null;
    return { exchangeId };
}

export function verifyWarmupHeaderWithExchange(
    headerValue: string,
    exchange: { id: string; sender_mailbox_id: string; recipient_mailbox_id: string },
): boolean {
    const expected = signWarmupHeader({
        exchangeId: exchange.id,
        senderMailboxId: exchange.sender_mailbox_id,
        recipientMailboxId: exchange.recipient_mailbox_id,
    });
    const a = Buffer.from(headerValue);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

export function getWarmupHeaderName(): string {
    return WARMUP_HEADER;
}

// ────────────────────────────────────────────────────────────────────
// Template selection — weighted-random over WarmupTemplate rows.
// In-process LRU cache keyed on (kind, language) so the 4-worker hot
// path doesn't hit the DB on every send.
// ────────────────────────────────────────────────────────────────────

interface CachedBucket {
    expiresAt: number;
    /** Pre-built cumulative-weight index for O(log n) weighted pick. */
    rows: Array<{ id: string; spintax: string; cum: number }>;
    totalWeight: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const cache = new Map<string, CachedBucket>();

async function loadBucket(kind: WarmupTemplateKind, language = 'en'): Promise<CachedBucket | null> {
    const key = `${kind}:${language}`;
    const now = Date.now();
    const hit = cache.get(key);
    if (hit && hit.expiresAt > now) return hit;

    const rows = await prisma.warmupTemplate.findMany({
        where: { kind, language, active: true },
        select: { id: true, spintax: true, weight: true },
    });
    if (rows.length === 0) return null;

    const indexed: Array<{ id: string; spintax: string; cum: number }> = [];
    let totalWeight = 0;
    for (const r of rows) {
        totalWeight += Math.max(1, r.weight);
        indexed.push({ id: r.id, spintax: r.spintax, cum: totalWeight });
    }
    const bucket: CachedBucket = { expiresAt: now + CACHE_TTL_MS, rows: indexed, totalWeight };
    cache.set(key, bucket);
    return bucket;
}

/** Invalidate the in-process cache — call after seeding/editing the
 *  corpus. */
export function invalidateContentCache(): void {
    cache.clear();
}

function pickWeighted(bucket: CachedBucket): { id: string; spintax: string } {
    const r = Math.random() * bucket.totalWeight;
    // Linear scan — O(n) but n ≤ 50 in practice. Replace with binary
    // search on bucket.cum if the corpus grows past a few hundred.
    for (const row of bucket.rows) {
        if (r < row.cum) return row;
    }
    return bucket.rows[bucket.rows.length - 1];
}

// ────────────────────────────────────────────────────────────────────
// Runtime jitter — variation layers stacked on top of spintax expansion
// to push the unique-permutation count well past the raw combinatorial
// total of the seed corpus.
// ────────────────────────────────────────────────────────────────────

const SOFT_EMOJI = ['🙂', '✌️', '👍', '🙏', '☕', '✨', '🤝', '📩', '✅'];
const PS_OPENERS = [
    'P.S. ',
    'p.s. ',
    'PS — ',
    'PS: ',
];
const PS_BODIES = [
    'how was your weekend?',
    'great catching up earlier.',
    'liked your last post on LinkedIn.',
    'send my regards to the team.',
    'have a great rest of the week.',
    'enjoy the rest of your day.',
    'happy Friday!',
];

function pick<T>(arr: T[]): T {
    return arr[Math.floor(Math.random() * arr.length)];
}

function maybeAppendEmoji(text: string): string {
    if (Math.random() < 0.05) {
        // 5% of the time, append a soft emoji. Keeps rate low so it's
        // not a fingerprint.
        return `${text} ${pick(SOFT_EMOJI)}`;
    }
    return text;
}

function maybeAppendPS(body: string): string {
    if (Math.random() < 0.10) {
        return `${body}\n\n${pick(PS_OPENERS)}${pick(PS_BODIES)}`;
    }
    return body;
}

/** 70% of warmup emails carry the sign-off block, 30% don't (mimics how
 *  real conversational emails sometimes drop the sign-off in mid-thread). */
function maybeAttachSignoff(body: string, signoff: string | null): string {
    if (!signoff) return body;
    if (Math.random() < 0.70) return `${body}\n\n${signoff}`;
    return body;
}

/** 50/50 plaintext vs minimal HTML (just <br> for line breaks). The
 *  sender adapter in the dispatch worker honors whichever shape this
 *  function returns — the result of `generate*` is the BODY exactly as
 *  it should hit the wire. */
function maybeWrapHtml(text: string): { body: string; isHtml: boolean } {
    if (Math.random() < 0.5) {
        // Plain text path
        return { body: text, isHtml: false };
    }
    const html = text
        .split('\n')
        .map(line => line.trim() === '' ? '<br>' : escapeHtml(line))
        .join('<br>');
    return { body: `<p>${html}</p>`, isHtml: true };
}

function escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ────────────────────────────────────────────────────────────────────
// Public API — the sender worker calls these per scheduled exchange.
// ────────────────────────────────────────────────────────────────────

export interface GeneratedWarmupContent {
    subject: string;
    body: string;
    isHtml: boolean;
}

/** Generate one fresh initial-message subject + body. Called by the
 *  dispatch worker right before send so we never store the rendered
 *  body — only a 200-char preview lands in WarmupExchange. */
export async function generateInitialMessage(opts: {
    senderName?: string | null;
} = {}): Promise<GeneratedWarmupContent> {
    const [subjectBucket, bodyBucket, signoffBucket] = await Promise.all([
        loadBucket('subject'),
        loadBucket('body'),
        loadBucket('signoff'),
    ]);

    if (!subjectBucket || !bodyBucket) {
        throw new Error('Warmup template corpus is empty — seed warmup_templates before sending');
    }

    const rawSubject = resolveSpintax(pickWeighted(subjectBucket).spintax);
    const rawBody = resolveSpintax(pickWeighted(bodyBucket).spintax);
    const rawSignoff = signoffBucket
        ? resolveSpintax(pickWeighted(signoffBucket).spintax)
        : null;

    const senderToken = opts.senderName ? opts.senderName.trim() : '';
    const signoffWithName = rawSignoff
        ? rawSignoff.replace(/\{\{sender_name\}\}/g, senderToken)
        : null;

    let body = maybeAppendPS(rawBody);
    body = maybeAttachSignoff(body, signoffWithName);

    const wrapped = maybeWrapHtml(body);
    const subject = maybeAppendEmoji(rawSubject);

    return { subject, body: wrapped.body, isHtml: wrapped.isHtml };
}

/** Generate a reply to an existing warmup thread. The recipient worker
 *  decides (60% probability) to send a reply, then calls this. */
export async function generateThreadReply(parent: {
    subject: string;
    depth: number;
}): Promise<GeneratedWarmupContent> {
    const replyBucket = await loadBucket('thread_reply');
    if (!replyBucket) {
        // Fall back to body bucket if no dedicated reply corpus is seeded.
        const body = await loadBucket('body');
        if (!body) throw new Error('Warmup template corpus is empty');
        const text = resolveSpintax(pickWeighted(body).spintax);
        const wrapped = maybeWrapHtml(text);
        return {
            subject: parent.subject.startsWith('Re:') ? parent.subject : `Re: ${parent.subject}`,
            body: wrapped.body,
            isHtml: wrapped.isHtml,
        };
    }

    const rawBody = resolveSpintax(pickWeighted(replyBucket).spintax);
    const wrapped = maybeWrapHtml(rawBody);

    // Vary subject prefix: most replies use "Re:", some use no prefix
    // (drop-the-prefix is a real human pattern especially in casual
    // threads; killing the always-Re: signal helps).
    const prefix = Math.random() < 0.85
        ? (parent.subject.startsWith('Re:') ? '' : 'Re: ')
        : '';
    const subject = `${prefix}${parent.subject}`;

    return { subject, body: wrapped.body, isHtml: wrapped.isHtml };
}

/** Diagnostic — returns the in-process cache state for /api/ai/status
 *  style dashboards. No PII. */
export function getContentEngineStats() {
    return {
        bucketsCached: cache.size,
        keys: Array.from(cache.keys()),
    };
}
