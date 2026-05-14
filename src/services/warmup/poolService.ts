/**
 * Warmup Pool — pair selection (cross-tenant).
 *
 * Picks a recipient mailbox for a given sender, with these rules:
 *
 *   1. Cross-org: never pair within the sender's own organization.
 *      (Same-org pairing would build "fake" reputation that doesn't
 *      cross to external ISPs anyway and risks false-positive bounce
 *      cascades inside the same workspace.)
 *
 *   2. Cross-domain: never pair to a recipient whose mailbox lives on
 *      the sender's domain (rare across orgs but possible for shared
 *      hosting; same-domain mail is treated specially by ISPs and
 *      doesn't carry the same reputation signal).
 *
 *   3. Recipient must be opted-in to RECEIVE (receive_enabled=true,
 *      enabled=true, health != 'error', org consent on).
 *
 *   4. De-dup recent pairings: avoid re-using the same (sender, recipient)
 *      pair more than once per ROTATION_WINDOW_HOURS so traffic spreads
 *      evenly across the pool and ISP filters can't flag us for hitting
 *      the same address repeatedly.
 *
 * Pool size assumption: at MVP we expect ~10s-1000s of mailboxes. Random
 * sampling with a few rejections is fine. If the pool grows past 100K
 * we'd want a Redis-backed weighted index — out of scope today.
 */

import { prisma } from '../../prisma';
import { logger } from '../observabilityService';

const ROTATION_WINDOW_HOURS = 24;
/** How many random recipient candidates we sample before giving up.
 *  Higher = better mixing, more DB load. 8 is plenty for a pool of
 *  any reasonable size and scales with O(8) per send regardless of
 *  pool size. */
const MAX_CANDIDATE_SAMPLES = 8;

export interface PoolCandidate {
    membershipId: string;
    mailboxId: string;
    mailboxEmail: string;
    organizationId: string;
    domainId: string;
}

/**
 * Pick a recipient for a given sender. Returns null if no eligible
 * recipient exists (small pool, or all candidates are filtered out by
 * the rotation guard).
 */
export async function pickRecipient(opts: {
    senderMailboxId: string;
    senderOrgId: string;
    senderDomainId: string;
}): Promise<PoolCandidate | null> {
    // 1. Build the eligible pool: cross-org, opted-in to receive, with
    //    workspace-level consent on, mailbox not in error/paused state.
    const eligibleCount = await prisma.warmupPoolMembership.count({
        where: {
            enabled: true,
            receive_enabled: true,
            health: { in: ['warming', 'maintenance'] },
            organization_id: { not: opts.senderOrgId },
            organization: { warmup_pool_consent: true },
        },
    });
    if (eligibleCount === 0) {
        logger.debug('[WARMUP_POOL] no eligible recipients for sender', { senderMailboxId: opts.senderMailboxId });
        return null;
    }

    // 2. Random-skip sampling — pick MAX_CANDIDATE_SAMPLES candidates
    //    via random offset and reject any that fail the cross-domain
    //    or rotation-window guard.
    const recentlyPairedSince = new Date(Date.now() - ROTATION_WINDOW_HOURS * 60 * 60 * 1000);

    for (let attempt = 0; attempt < MAX_CANDIDATE_SAMPLES; attempt++) {
        const offset = Math.floor(Math.random() * eligibleCount);

        const candidates = await prisma.warmupPoolMembership.findMany({
            where: {
                enabled: true,
                receive_enabled: true,
                health: { in: ['warming', 'maintenance'] },
                organization_id: { not: opts.senderOrgId },
                organization: { warmup_pool_consent: true },
            },
            include: {
                mailbox: {
                    select: { id: true, email: true, domain_id: true, organization_id: true, status: true },
                },
            },
            skip: offset,
            take: 1,
        });
        const found = candidates[0];
        if (!found) continue;

        // Cross-domain guard
        if (found.mailbox.domain_id === opts.senderDomainId) continue;

        // Skip mailboxes currently in healing pipeline (paused / quarantine etc.)
        if (found.mailbox.status !== 'healthy' && found.mailbox.status !== 'active') continue;

        // Rotation-window guard — skip if we've sent (sender → recipient)
        // in the last ROTATION_WINDOW_HOURS.
        const recentPair = await prisma.warmupExchange.findFirst({
            where: {
                sender_mailbox_id: opts.senderMailboxId,
                recipient_mailbox_id: found.mailbox.id,
                created_at: { gte: recentlyPairedSince },
            },
            select: { id: true },
        });
        if (recentPair) continue;

        return {
            membershipId: found.id,
            mailboxId: found.mailbox.id,
            mailboxEmail: found.mailbox.email,
            organizationId: found.mailbox.organization_id,
            domainId: found.mailbox.domain_id,
        };
    }

    // Pool too small or saturated for this sender right now.
    logger.debug('[WARMUP_POOL] sampling exhausted — skipping send for this tick', {
        senderMailboxId: opts.senderMailboxId,
        attempts: MAX_CANDIDATE_SAMPLES,
    });
    return null;
}

/** Org-level consent gate. Used by the sender-side query before any of
 *  this org's mailboxes can SEND warmup. (Receive consent is the same
 *  flag — joining the pool means both directions.) */
export async function setOrgConsent(orgId: string, consent: boolean): Promise<void> {
    await prisma.organization.update({
        where: { id: orgId },
        data: {
            warmup_pool_consent: consent,
            warmup_pool_consent_at: consent ? new Date() : null,
        },
    });
    logger.info('[WARMUP_POOL] org consent updated', { orgId, consent });
}

export async function getOrgConsent(orgId: string): Promise<{ consent: boolean; consentAt: Date | null }> {
    const row = await prisma.organization.findUnique({
        where: { id: orgId },
        select: { warmup_pool_consent: true, warmup_pool_consent_at: true },
    });
    return {
        consent: !!row?.warmup_pool_consent,
        consentAt: row?.warmup_pool_consent_at ?? null,
    };
}
