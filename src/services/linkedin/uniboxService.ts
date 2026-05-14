/**
 * LinkedIn Unibox service — proxies the per-account Unipile chats API
 * up to our org-scoped REST surface, merging threads across every
 * connected LinkedIn account for the workspace.
 *
 * We DO NOT mirror every message into our DB — Unipile already does the
 * sync server-side and we'd be duplicating their work + handling sync
 * conflicts. We DO read the per-profile auto-tag (written by the reply
 * classifier worker) so the Unibox can render the Interested / Not
 * Interested / Generic badge without a second round-trip.
 *
 * Stub-safe: returns empty lists when UNIPILE_API_KEY is unset.
 */

import { prisma } from '../../prisma';
import { logger } from '../observabilityService';
import { isUnipileConfigured, chats as unipileChats, invitations as unipileInvitations } from '../unipile';
import { pauseCrossChannelForLead } from '../crossChannelSuppressionService';

export interface UniboxThread {
    /** Composite ID (account.id + ':' + unipile thread id) — unique across the workspace. */
    id: string;
    linkedin_account_id: string;
    sender_display_name: string;
    counterparty_name: string;
    counterparty_headline: string | null;
    counterparty_public_identifier: string | null;
    counterparty_picture_url: string | null;
    /** Workspace-wide auto-tag from the reply classifier (Phase 6 wire-up). */
    auto_tag: 'Interested' | 'Not Interested' | 'Generic' | null;
    preview: string;
    last_message_at: string | null;
    /** Direction of the most recent message in the thread. INBOUND = lead
     *  sent last; OUTBOUND = our account sent last. The UI's "Inbox /
     *  Sent / Replied" tabs derive from this — without it those filters
     *  are guesses based on unread_count which is unreliable (an
     *  operator can open a thread without replying, dropping unread to
     *  zero without sending). */
    last_message_direction: 'INBOUND' | 'OUTBOUND' | null;
    unread_count: number;
}

export interface ListThreadsOptions {
    unread_only?: boolean;
    /** Server-side auto-tag filter. Accepts a list of tag values; matches
     *  if the thread's tag is in the set. */
    auto_tags?: Array<'Interested' | 'Not Interested' | 'Generic'>;
}

export interface ListThreadsResult {
    threads: UniboxThread[];
    /** Per-account error state. When Unipile fails for one account we
     *  continue with the others (partial visibility beats a blank
     *  page), but the UI surfaces a banner for the broken accounts so
     *  the operator knows their inbox is incomplete. */
    account_errors: Array<{ account_id: string; display_name: string; error: string }>;
}

export async function listThreadsForOrg(
    organizationId: string,
    opts: ListThreadsOptions = {},
): Promise<ListThreadsResult> {
    if (!isUnipileConfigured()) return { threads: [], account_errors: [] };

    const accounts = await prisma.linkedInAccount.findMany({
        where: { organization_id: organizationId, status: { in: ['OK', 'SYNC_SUCCESS'] } },
        select: { id: true, display_name: true, unipile_account_id: true },
    });
    if (accounts.length === 0) return { threads: [], account_errors: [] };

    // ── Step 1: fan out Unipile listChats per account ──────────────
    // We do them sequentially to respect the Unipile concurrency cap
    // (the client semaphore caps at ~10 in-flight requests org-wide;
    // running 50 accounts in parallel would queue them anyway, and
    // sequential keeps the per-account error attribution clean).
    type RawThread = {
        accountId: string;
        accountDisplayName: string;
        chat: Awaited<ReturnType<typeof unipileChats.listChats>>['items'][number];
    };
    const raw: RawThread[] = [];
    const account_errors: ListThreadsResult['account_errors'] = [];
    for (const acct of accounts) {
        try {
            const resp = await unipileChats.listChats(acct.unipile_account_id, {
                limit: 100,
                unread_only: opts.unread_only,
            });
            for (const c of resp.items || []) {
                raw.push({ accountId: acct.id, accountDisplayName: acct.display_name, chat: c });
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.warn('[UNIBOX] listChats failed', { account_id: acct.id, err: msg.slice(0, 200) });
            account_errors.push({
                account_id: acct.id,
                display_name: acct.display_name,
                error: msg.slice(0, 200),
            });
        }
    }

    // ── Step 2: batch the auto-tag lookup (fixes the N+1 we used to
    // run inside the per-thread loop — one findUnique per thread on
    // 100 threads = 100 sequential round-trips). One findMany with
    // a unique-key `in` clause replaces it. ──────────────────────────
    const slugSet = new Set<string>();
    for (const r of raw) {
        const counterparty = pickCounterparty(r.chat);
        if (counterparty?.public_identifier) slugSet.add(counterparty.public_identifier);
    }
    const profileRows = slugSet.size > 0
        ? await prisma.linkedInProfile.findMany({
            where: {
                organization_id: organizationId,
                public_identifier: { in: Array.from(slugSet) },
            },
            select: { public_identifier: true, linkedin_auto_tag: true },
        })
        : [];
    const autoTagBySlug = new Map(
        profileRows.map(p => [p.public_identifier, p.linkedin_auto_tag as UniboxThread['auto_tag']]),
    );

    // ── Step 3: shape rows + apply optional tag filter ─────────────
    const autoTagFilter = opts.auto_tags && opts.auto_tags.length > 0
        ? new Set(opts.auto_tags)
        : null;

    const threads: UniboxThread[] = [];
    for (const r of raw) {
        const counterparty = pickCounterparty(r.chat);
        if (!counterparty) continue;
        const slug = counterparty.public_identifier ?? null;
        const autoTag = slug ? (autoTagBySlug.get(slug) ?? null) : null;
        if (autoTagFilter && (!autoTag || !autoTagFilter.has(autoTag))) continue;

        threads.push({
            id: `${r.accountId}:${r.chat.id}`,
            linkedin_account_id: r.accountId,
            sender_display_name: r.accountDisplayName,
            counterparty_name: counterparty.full_name || counterparty.public_identifier || 'Unknown',
            counterparty_headline: counterparty.headline || null,
            counterparty_public_identifier: slug,
            counterparty_picture_url: counterparty.picture_url || null,
            auto_tag: autoTag,
            preview: r.chat.last_message_preview || '',
            last_message_at: r.chat.last_message_at || null,
            // Unipile is inconsistent across API revisions — accept
            // either `last_message_direction` or `direction`. Falls
            // back to null on payloads that omit both; the UI treats
            // null as "unknown" rather than guessing.
            last_message_direction: normalizeDirection(r.chat.last_message_direction ?? r.chat.direction),
            unread_count: r.chat.unread_count || 0,
        });
    }
    threads.sort((a, b) => (b.last_message_at || '').localeCompare(a.last_message_at || ''));
    return { threads, account_errors };
}

function pickCounterparty<T extends { attendees?: Array<{ public_identifier?: string; member_urn?: string; full_name?: string; headline?: string; picture_url?: string }> }>(
    chat: T,
) {
    return chat.attendees?.find(a => a.public_identifier || a.member_urn) || chat.attendees?.[0];
}

function normalizeDirection(d: string | null | undefined): 'INBOUND' | 'OUTBOUND' | null {
    if (d === 'INBOUND' || d === 'OUTBOUND') return d;
    return null;
}

export interface UniboxMessage {
    id: string;
    direction: 'INBOUND' | 'OUTBOUND';
    text: string;
    sent_at: string;
    sender_name: string;
}

/** Parse a composite Unibox thread id back into account + Unipile thread. */
function parseCompositeId(composite: string): { accountRowId: string; unipileThreadId: string } | null {
    const [accountRowId, unipileThreadId] = composite.split(':', 2);
    if (!accountRowId || !unipileThreadId) return null;
    return { accountRowId, unipileThreadId };
}

/**
 * Hard cap on how many messages we return per thread. Unipile threads
 * can be arbitrarily long; clients that need scroll-to-load can request
 * pagination later via cursor. v1: most operator conversations stay
 * well under 200 messages, so we slice and document the cap.
 */
const MAX_THREAD_MESSAGES = 200;

export async function getThreadMessages(organizationId: string, compositeId: string): Promise<UniboxMessage[]> {
    if (!isUnipileConfigured()) return [];
    const parsed = parseCompositeId(compositeId);
    if (!parsed) return [];

    // Verify the account belongs to this org — never leak Unipile data
    // across tenants via a forged thread id.
    const acct = await prisma.linkedInAccount.findFirst({
        where: { id: parsed.accountRowId, organization_id: organizationId },
        select: { id: true, display_name: true },
    });
    if (!acct) return [];

    const resp = await unipileChats.listChatMessages(parsed.unipileThreadId, { limit: MAX_THREAD_MESSAGES });
    return (resp.items || []).map(m => ({
        id: m.id,
        direction: m.direction,
        text: m.text || '',
        sent_at: m.sent_at,
        sender_name: m.direction === 'OUTBOUND' ? acct.display_name : (m.sender_full_name || 'Counterparty'),
    }));
}

export class SendReplyError extends Error {
    constructor(public code: 'cap_reached' | 'invalid' | 'send_failed', message: string) {
        super(message);
        this.name = 'SendReplyError';
    }
}

export interface SendReplyResult {
    message_id?: string;
    /** Cross-channel suppression outcome (null when the lead isn't
     *  linked to a Lead row, so no other channel to pause). */
    suppression?: { decision: 'paused' | 'skipped'; paused_enrollments: number; mode: string; reason?: string } | null;
}

/**
 * Send a DM via Unipile, increment the daily send counter, and trigger
 * cross-channel suppression for this lead.
 *
 * Suppression: per the org's configured stop intelligence, an operator's
 * outbound reply on LinkedIn is treated as the strongest possible
 * engagement signal — we model it as replyClass='positive' so it pauses
 * any parallel email enrollments under HARD / CLASSIFIED / ASYMMETRIC
 * modes. Under OFF mode the service no-ops. We catch any suppression
 * failure and log it without breaking the send — a successful Unipile
 * dispatch with a stale cross-channel state is recoverable; the inverse
 * (suppression fired but the message never sent) is worse.
 *
 * Rate-limit precheck: we look at the account's `messages_today` vs
 * `max_messages_per_day` BEFORE calling Unipile so we can surface a
 * proper 429 to the UI instead of a generic 500 from a swallowed
 * Unipile error.
 *
 * @param counterpartyPublicIdentifier — optional hint from the UI. The
 *   thread list already carries this, so the frontend passes it on
 *   reply. We use it to resolve the LinkedInProfile → lead_id for
 *   suppression. Spoofing risk is org-bounded (the lookup is
 *   organization-scoped) and the worst case is "operator pauses their
 *   own org's campaigns for a lead they don't actually own a thread
 *   with" — annoying, not a security incident.
 */
export async function sendReply(
    organizationId: string,
    compositeId: string,
    text: string,
    counterpartyPublicIdentifier?: string | null,
): Promise<SendReplyResult> {
    const parsed = parseCompositeId(compositeId);
    if (!parsed) throw new SendReplyError('invalid', 'Invalid thread id');
    if (!text || text.length === 0) throw new SendReplyError('invalid', 'text is required');
    if (text.length > 4000) throw new SendReplyError('invalid', 'LinkedIn DM max is 4000 characters');

    const acct = await prisma.linkedInAccount.findFirst({
        where: { id: parsed.accountRowId, organization_id: organizationId },
        select: { id: true, unipile_account_id: true, messages_today: true, max_messages_per_day: true, status: true },
    });
    if (!acct) throw new SendReplyError('invalid', 'Account not found');
    if (acct.status !== 'OK' && acct.status !== 'SYNC_SUCCESS') {
        throw new SendReplyError('send_failed', `Account is in ${acct.status} state — reconnect before sending.`);
    }

    // Rate-limit precheck. The dispatcher uses the same counter so this
    // mirrors the capacity logic in linkedinDispatcherWorker.pickSender.
    if (acct.messages_today >= acct.max_messages_per_day) {
        throw new SendReplyError(
            'cap_reached',
            `Daily message cap reached (${acct.messages_today}/${acct.max_messages_per_day}). Sends resume after the next midnight reset.`,
        );
    }

    let res: { message_id?: string };
    try {
        res = await unipileInvitations.sendMessage({
            account_id: acct.unipile_account_id,
            thread_id: parsed.unipileThreadId,
            text,
        });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new SendReplyError('send_failed', msg);
    }

    await prisma.linkedInAccount.update({
        where: { id: acct.id },
        data: { messages_today: { increment: 1 } },
    });

    // ── Cross-channel suppression ──────────────────────────────────
    // Resolve the lead from the counterparty profile (if known). Skip
    // silently when there's no LinkedInProfile or no linked Lead — the
    // suppression service has nothing to act on in that case.
    let suppression: SendReplyResult['suppression'] = null;
    if (counterpartyPublicIdentifier) {
        try {
            const profile = await prisma.linkedInProfile.findUnique({
                where: {
                    organization_id_public_identifier: {
                        organization_id: organizationId,
                        public_identifier: counterpartyPublicIdentifier,
                    },
                },
                select: { lead_id: true },
            });
            if (profile?.lead_id) {
                const result = await pauseCrossChannelForLead({
                    organizationId,
                    leadId: profile.lead_id,
                    source: 'linkedin',
                    // Operator's manual reply = explicit engagement.
                    // Model it as 'positive' so CLASSIFIED + ASYMMETRIC
                    // both honor it. HARD pauses regardless of class.
                    // OFF still no-ops as the service decides.
                    replyClass: 'positive',
                    reason: 'operator outbound reply via LinkedIn Unibox',
                });
                suppression = {
                    decision: result.decision,
                    paused_enrollments: result.pausedEnrollments,
                    mode: result.mode,
                    reason: result.skipReason,
                };
            }
        } catch (err) {
            // Non-fatal: the send succeeded and the counter is already
            // updated. Log the suppression failure so a healthy review
            // catches it, but never throw to the caller.
            logger.warn('[UNIBOX] cross-channel suppression failed after send (non-fatal)', {
                organizationId,
                account_id: acct.id,
                counterparty_slug: counterpartyPublicIdentifier,
                err: err instanceof Error ? err.message : String(err),
            });
        }
    }

    return { message_id: res.message_id, suppression };
}

export interface MarkReadResult {
    success: boolean;
    error?: string;
}

export async function markRead(organizationId: string, compositeId: string): Promise<MarkReadResult> {
    const parsed = parseCompositeId(compositeId);
    if (!parsed) return { success: false, error: 'Invalid thread id' };
    const acct = await prisma.linkedInAccount.findFirst({
        where: { id: parsed.accountRowId, organization_id: organizationId },
        select: { id: true },
    });
    if (!acct) return { success: false, error: 'Account not found' };
    try {
        await unipileChats.markChatRead(parsed.unipileThreadId);
        return { success: true };
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn('[UNIBOX] markRead failed', { thread: compositeId, err: msg.slice(0, 200) });
        return { success: false, error: msg };
    }
}
