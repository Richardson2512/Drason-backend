/**
 * LinkedIn connection-acceptance backstop poller.
 *
 * Unipile's `invitation_accepted` (`new_relation`) webhook lags up to 8
 * HOURS per their own docs - explicitly called out as a known limitation
 * of their relations sync. For sequence flows that hinge on the
 * accept-→-DM transition this is unacceptably slow.
 *
 * The fast path is the `new message` webhook: if a connection request
 * carried a text note, the lead's first reply lands as a chat message on
 * a thread we own, which Unipile DOES push in real-time. The webhook
 * handler flips LinkedInConnectionEdge.status to ACCEPTED on receipt.
 *
 * THIS worker is the slow path - every 2 hours, for every account, we
 * pull the relations list + sent-invitations list and reconcile any
 * INVITE_SENT edges that have transitioned. Catches noteless CRs (which
 * have no fast-path signal) and serves as defense-in-depth for note-
 * bearing ones that the webhook missed.
 */

import { prisma } from '../prisma';
import { logger } from '../services/observabilityService';
import { isUnipileConfigured, users as unipileUsers } from '../services/unipile';

const RUN_INTERVAL_MS = 2 * 60 * 60 * 1000; // 2h between cycles
const FIRST_RUN_DELAY_MS = 4 * 60 * 1000;
const JITTER_MS = 15 * 60 * 1000;

let scheduled: NodeJS.Timeout | null = null;
let totalCycles = 0;
let totalAcceptancesDetected = 0;
let lastError: string | null = null;

function jitter(baseMs: number): number {
    return baseMs + Math.floor((Math.random() - 0.5) * JITTER_MS * 2);
}

export async function runOnce(): Promise<{ accountsScanned: number; acceptances: number }> {
    if (!isUnipileConfigured()) return { accountsScanned: 0, acceptances: 0 };

    const accounts = await prisma.linkedInAccount.findMany({
        where: { status: { in: ['OK', 'SYNC_SUCCESS'] } },
        select: { id: true, organization_id: true, unipile_account_id: true },
    });

    let acceptances = 0;
    for (const acct of accounts) {
        try {
            acceptances += await reconcileAccount(acct);
        } catch (err) {
            logger.warn('[ACCEPTANCE-WATCHER] per-account reconcile failed', {
                account_id: acct.id,
                err: String(err).slice(0, 200),
            });
        }
    }

    return { accountsScanned: accounts.length, acceptances };
}

async function reconcileAccount(acct: { id: string; organization_id: string; unipile_account_id: string }): Promise<number> {
    // Find all edges currently marked INVITE_SENT for this account - these
    // are the only ones we need to recheck. Already-CONNECTED edges don't
    // change; NOT_CONNECTED edges aren't pending so a reconcile is moot.
    const pending = await prisma.linkedInConnectionEdge.findMany({
        where: { linkedin_account_id: acct.id, status: 'INVITE_SENT' },
        select: {
            linkedin_account_id: true,
            linkedin_profile_id: true,
            profile: { select: { public_identifier: true, member_urn: true } },
        },
    });
    if (pending.length === 0) return 0;

    // Build a lookup of the pending recipients by both identifiers.
    const slugMap = new Map<string, typeof pending[number]>();
    const urnMap = new Map<string, typeof pending[number]>();
    for (const p of pending) {
        if (p.profile.public_identifier) slugMap.set(p.profile.public_identifier, p);
        if (p.profile.member_urn) urnMap.set(p.profile.member_urn, p);
    }

    // Pull the relations list (page 1; cycle through pages for accounts
    // with >100 recent relations). Each relation that matches a pending
    // recipient means the invite was accepted between cycles.
    let cursor: string | undefined;
    let acceptedThisCycle = 0;
    let pagesScanned = 0;
    const MAX_PAGES = 5; // 5 × 100 = 500 most-recent relations per cycle
    while (pagesScanned < MAX_PAGES) {
        const page = await unipileUsers.listRelations(acct.unipile_account_id, { cursor, limit: 100 });
        for (const r of page.items || []) {
            const hit = (r.public_identifier && slugMap.get(r.public_identifier))
                     || (r.member_urn && urnMap.get(r.member_urn));
            if (!hit) continue;
            await prisma.linkedInConnectionEdge.update({
                where: {
                    linkedin_account_id_linkedin_profile_id: {
                        linkedin_account_id: hit.linkedin_account_id,
                        linkedin_profile_id: hit.linkedin_profile_id,
                    },
                },
                data: {
                    status: 'CONNECTED',
                    accepted_at: r.created_at ? new Date(r.created_at) : new Date(),
                    last_polled_at: new Date(),
                },
            });
            acceptedThisCycle++;
        }
        if (!page.cursor) break;
        cursor = page.cursor;
        pagesScanned++;
    }

    // Bump last_polled_at on the still-pending ones so the UI can show
    // "last checked X minutes ago" without us writing a separate counter.
    if (pending.length > 0) {
        await prisma.linkedInConnectionEdge.updateMany({
            where: { linkedin_account_id: acct.id, status: 'INVITE_SENT' },
            data: { last_polled_at: new Date() },
        });
    }

    return acceptedThisCycle;
}

async function tick(): Promise<void> {
    totalCycles += 1;
    try {
        const { accountsScanned, acceptances } = await runOnce();
        totalAcceptancesDetected += acceptances;
        if (accountsScanned > 0 || acceptances > 0) {
            logger.info('[ACCEPTANCE-WATCHER] Cycle complete', { accountsScanned, acceptances });
        }
        lastError = null;
    } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        logger.error('[ACCEPTANCE-WATCHER] Cycle failed', err instanceof Error ? err : new Error(lastError));
    }
}

export function scheduleLinkedInAcceptanceWatcher(): void {
    if (scheduled) return;
    setTimeout(() => {
        void tick();
        scheduled = setInterval(() => { void tick(); }, jitter(RUN_INTERVAL_MS));
    }, FIRST_RUN_DELAY_MS);
    logger.info('[ACCEPTANCE-WATCHER] Scheduled', { baseIntervalMs: RUN_INTERVAL_MS, jitterMs: JITTER_MS });
}

export function stopLinkedInAcceptanceWatcher(): void {
    if (scheduled) {
        clearInterval(scheduled);
        scheduled = null;
    }
}

export function getAcceptanceWatcherStatus() {
    return { totalCycles, totalAcceptancesDetected, lastError, scheduled: Boolean(scheduled) };
}
