/**
 * Warmup Recipient Engagement
 *
 * Recipient-side actions on incoming warmup emails:
 *   - Mark as read (+ \Seen flag)
 *   - Move from Spam/Junk to Inbox (a.k.a. "report not spam")
 *   - Detect what folder the email landed in
 *
 * Implementation: pure IMAP via ImapFlow. The recipient mailbox provides
 * the SMTP/IMAP credentials we already store (decrypted via the same
 * pattern used by imapReplyWorker / imapSentAppendService).
 *
 * Why IMAP and not provider APIs (Gmail / Microsoft Graph):
 *   - SMTP/IMAP is the lowest common denominator — every connected
 *     mailbox in the pool has IMAP creds.
 *   - Folder semantics work uniformly across Gmail, Outlook, custom
 *     SMTP — we don't have to maintain three branches.
 *   - The "move from junk to inbox" operation is the IMAP MOVE command,
 *     supported by every modern server.
 *
 * Provider-specific spam-folder names — handled by tryFolders below.
 * Order matters: we look in Junk first (Outlook), then Spam (Gmail's
 * label is exposed to IMAP as a folder), then provider-specific
 * fallbacks.
 */

import { ImapFlow } from 'imapflow';
import { logger } from '../observabilityService';
import { decrypt, isEncrypted } from '../../utils/encryption';
import { getWarmupHeaderName } from './contentService';

const CONNECTION_TIMEOUT_MS = 15_000;

/** Folders we'll search for warmup messages, in priority order. The
 *  first folder we successfully open and find the target message in
 *  becomes the "landed_in" answer. */
const SPAM_FOLDER_NAMES = [
    '[Gmail]/Spam',     // Gmail
    'Spam',             // generic
    'Junk',             // Outlook
    'Junk Email',       // Outlook (full)
    'INBOX.Spam',       // some IMAP servers
    'INBOX.Junk',       // some IMAP servers
];
const PROMOTIONS_FOLDER_NAMES = [
    'Categories/Promotions',
    '[Gmail]/Promotions',
    'Promotions',
];
const INBOX_FOLDER_NAME = 'INBOX';

export interface RecipientCredentials {
    email: string;
    imapHost: string;
    imapPort: number;
    imapUser: string;
    /** Encrypted in the DB; pass the encrypted string and the helper
     *  decrypts. Encrypts-but-plaintext-also-handled for legacy rows. */
    imapPassword: string;
}

interface FoundMessage {
    folder: string;
    uid: number;
    landedIn: 'inbox' | 'spam' | 'promotions' | 'unknown';
}

function readPassword(stored: string): string {
    return isEncrypted(stored) ? decrypt(stored) : stored;
}

async function connect(creds: RecipientCredentials): Promise<ImapFlow> {
    const client = new ImapFlow({
        host: creds.imapHost,
        port: creds.imapPort || 993,
        secure: true,
        auth: { user: creds.imapUser || creds.email, pass: readPassword(creds.imapPassword) },
        logger: false,
        tls: { rejectUnauthorized: false },
    });
    await Promise.race([
        client.connect(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('IMAP connection timeout')), CONNECTION_TIMEOUT_MS)),
    ]);
    return client;
}

async function tryOpenMailbox(client: ImapFlow, name: string): Promise<boolean> {
    try {
        await client.mailboxOpen(name);
        return true;
    } catch {
        return false;
    }
}

/** Search a folder for a warmup email by its X-Superkabe-Warmup header
 *  value. Returns the UID if found. */
async function searchByWarmupHeader(client: ImapFlow, headerValue: string): Promise<number | null> {
    try {
        const uids = await client.search({ header: { [getWarmupHeaderName()]: headerValue } });
        if (Array.isArray(uids) && uids.length > 0) return uids[0];
        return null;
    } catch (err) {
        logger.debug('[WARMUP_ENGAGEMENT] search failed', { err: (err as Error)?.message });
        return null;
    }
}

/**
 * Find a warmup message across the candidate folders. Used by the
 * recipient worker after a send to determine where the message landed
 * AND to capture the UID for the subsequent mark-read / move actions.
 *
 * Returns `null` if the message hasn't been delivered yet (still in
 * transit, recipient ISP delaying). Caller retries on next tick.
 */
export async function locateWarmupMessage(opts: {
    creds: RecipientCredentials;
    headerValue: string;
}): Promise<FoundMessage | null> {
    const client = await connect(opts.creds).catch(err => {
        logger.warn('[WARMUP_ENGAGEMENT] IMAP connect failed', { email: opts.creds.email, err: (err as Error)?.message });
        return null;
    });
    if (!client) return null;

    try {
        // Inbox first — most messages should land here for an opted-in
        // pool member by definition.
        if (await tryOpenMailbox(client, INBOX_FOLDER_NAME)) {
            const uid = await searchByWarmupHeader(client, opts.headerValue);
            if (uid != null) return { folder: INBOX_FOLDER_NAME, uid, landedIn: 'inbox' };
        }

        // Then promotions (Gmail) — counts as a "landed but not great"
        // outcome for spam-rate accounting.
        for (const folder of PROMOTIONS_FOLDER_NAMES) {
            if (!(await tryOpenMailbox(client, folder))) continue;
            const uid = await searchByWarmupHeader(client, opts.headerValue);
            if (uid != null) return { folder, uid, landedIn: 'promotions' };
        }

        // Spam / Junk — the "recover from spam" target.
        for (const folder of SPAM_FOLDER_NAMES) {
            if (!(await tryOpenMailbox(client, folder))) continue;
            const uid = await searchByWarmupHeader(client, opts.headerValue);
            if (uid != null) return { folder, uid, landedIn: 'spam' };
        }

        return null;
    } finally {
        try { await client.logout(); } catch { /* swallow */ }
    }
}

/** Mark a message as read (\Seen flag). Idempotent — re-marking is a
 *  no-op. */
export async function markRead(opts: {
    creds: RecipientCredentials;
    folder: string;
    uid: number;
}): Promise<boolean> {
    const client = await connect(opts.creds).catch(() => null);
    if (!client) return false;
    try {
        await client.mailboxOpen(opts.folder);
        await client.messageFlagsAdd({ uid: opts.uid }, ['\\Seen'], { uid: true });
        return true;
    } catch (err) {
        logger.warn('[WARMUP_ENGAGEMENT] markRead failed', { email: opts.creds.email, err: (err as Error)?.message });
        return false;
    } finally {
        try { await client.logout(); } catch { /* swallow */ }
    }
}

/**
 * Move a warmup message from Spam/Junk into Inbox — i.e., "report not
 * spam" from the recipient's side. ISPs (Gmail, Outlook) treat this
 * action as a strong positive signal toward the sender's reputation.
 *
 * Implementation note: IMAP MOVE is what Gmail's "Not spam" button does
 * under the hood, with the same effect on inbox-placement learning.
 */
export async function recoverFromSpam(opts: {
    creds: RecipientCredentials;
    spamFolder: string;
    uid: number;
}): Promise<boolean> {
    const client = await connect(opts.creds).catch(() => null);
    if (!client) return false;
    try {
        await client.mailboxOpen(opts.spamFolder);
        const result = await client.messageMove({ uid: opts.uid }, INBOX_FOLDER_NAME, { uid: true });
        if (!result) return false;
        return true;
    } catch (err) {
        logger.warn('[WARMUP_ENGAGEMENT] recoverFromSpam failed', { email: opts.creds.email, err: (err as Error)?.message });
        return false;
    } finally {
        try { await client.logout(); } catch { /* swallow */ }
    }
}

/** Same effect as `recoverFromSpam` but starting in the Promotions
 *  folder. Promotions → Inbox is also a positive signal on Gmail (it
 *  effectively reclassifies the sender). */
export async function recoverFromPromotions(opts: {
    creds: RecipientCredentials;
    promoFolder: string;
    uid: number;
}): Promise<boolean> {
    const client = await connect(opts.creds).catch(() => null);
    if (!client) return false;
    try {
        await client.mailboxOpen(opts.promoFolder);
        const result = await client.messageMove({ uid: opts.uid }, INBOX_FOLDER_NAME, { uid: true });
        if (!result) return false;
        return true;
    } catch (err) {
        logger.warn('[WARMUP_ENGAGEMENT] recoverFromPromotions failed', { email: opts.creds.email, err: (err as Error)?.message });
        return false;
    } finally {
        try { await client.logout(); } catch { /* swallow */ }
    }
}

/** Convenience: locate + mark read + (if in spam) recover. The
 *  recipient worker calls this once per pending exchange. Returns the
 *  outcome so the worker can update WarmupExchange state and counters. */
export interface EngagementOutcome {
    found: boolean;
    landedIn: 'inbox' | 'spam' | 'promotions' | 'unknown' | null;
    markedRead: boolean;
    recovered: boolean;
}

export async function processIncomingWarmup(opts: {
    creds: RecipientCredentials;
    headerValue: string;
}): Promise<EngagementOutcome> {
    const located = await locateWarmupMessage(opts);
    if (!located) return { found: false, landedIn: null, markedRead: false, recovered: false };

    const markedRead = await markRead({ creds: opts.creds, folder: located.folder, uid: located.uid });

    let recovered = false;
    if (located.landedIn === 'spam') {
        recovered = await recoverFromSpam({ creds: opts.creds, spamFolder: located.folder, uid: located.uid });
    } else if (located.landedIn === 'promotions') {
        recovered = await recoverFromPromotions({ creds: opts.creds, promoFolder: located.folder, uid: located.uid });
    }

    return {
        found: true,
        landedIn: located.landedIn,
        markedRead,
        recovered,
    };
}
