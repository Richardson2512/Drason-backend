/**
 * Super Sender routing - decides at send time whether a given outbound
 * should go through a dedicated IP or fall back to the mailbox's native
 * provider.
 *
 * Rules (in order):
 *   1. Mailbox MUST be SMTP/relay (not Gmail/Outlook OAuth). Google and
 *      Microsoft control their own outbound IPs; we cannot route their
 *      sends through our SES pool. The card UI flags this so the user
 *      isn't surprised.
 *   2. The mailbox's organization MUST have a DedicatedIp in
 *      `warming` or `active` state with no auto-pause flag.
 *   3. The DedicatedIp MUST have remaining daily-cap capacity. The
 *      counter is enforced atomically: a conditional UPDATE that bumps
 *      sends_today only when sends_today < daily_cap returns count=0
 *      when at-cap, signaling the caller to fall back to native send
 *      (we never block - we degrade gracefully to the mailbox's own
 *      provider). Reset boundary is checked + applied in the same UPDATE.
 *
 * Returns a tagged decision the caller switches on:
 *   { route: 'ses', ip: {...} }      → call sendViaSes(...)
 *   { route: 'native' }              → call existing sendViaSMTP / Gmail / Microsoft
 *   { route: 'native', reason }      → same, but log why we fell back
 */

import { prisma } from '../index';
import { logger } from './observabilityService';

export type RoutingDecision =
    | { route: 'ses'; ip: { id: string; pool_name: string; daily_cap: number; warmup_day: number } }
    | { route: 'native'; reason?: string };

/** Providers eligible for SES routing. Any non-OAuth mailbox routes
 *  through whatever transport its credentials describe; SMTP relay
 *  providers (Zapmail, Mission Inbox, Scaledmail, custom) are the
 *  intended targets. OAuth providers are explicitly excluded. */
const SES_ELIGIBLE_PROVIDERS = new Set(['smtp']);

export function isMailboxSesEligible(provider: string): boolean {
    return SES_ELIGIBLE_PROVIDERS.has(provider);
}

/**
 * Resolve + claim daily-cap capacity in one atomic step.
 *
 * Uses a conditional updateMany so two concurrent send workers can never
 * both incrementing past the cap. If the conditional update misses (count
 * = 0), capacity is exhausted; caller falls back to native transport.
 *
 * Resets the daily counter when sends_reset_at is more than 24 hours old
 * - checked in the same UPDATE so we don't need a separate cron.
 */
export async function resolveRouteForSend(opts: {
    organizationId: string;
    provider: string;
}): Promise<RoutingDecision> {
    if (!isMailboxSesEligible(opts.provider)) {
        return { route: 'native', reason: `Provider ${opts.provider} not SES-eligible` };
    }

    // Find an eligible IP (warming OR active, not paused).
    const ip = await prisma.dedicatedIp.findFirst({
        where: {
            organization_id: opts.organizationId,
            state: { in: ['warming', 'active'] },
            paused_reason: null,
        },
        select: { id: true, ses_pool_name: true, daily_cap: true, warmup_day: true, sends_reset_at: true, sends_today: true },
    });
    if (!ip || !ip.ses_pool_name) {
        return { route: 'native' };
    }

    // Check + reset window in one atomic conditional update. We do this
    // in two passes only when needed:
    //   Pass 1: roll the daily counter if sends_reset_at is >= 24h old.
    //   Pass 2: increment sends_today only when sends_today < daily_cap.
    // Both pass 1 and pass 2 are conditional updateMany() calls - they
    // either succeed atomically or do nothing.
    const now = new Date();
    const resetCutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    if (ip.sends_reset_at < resetCutoff) {
        // Roll the window. updateMany with the same WHERE conditions on
        // the row we read so we don't overwrite a concurrent send-path's
        // increment.
        await prisma.dedicatedIp.updateMany({
            where: { id: ip.id, sends_reset_at: { lt: resetCutoff } },
            data: { sends_today: 0, sends_reset_at: now },
        });
    }

    // Atomic conditional increment - succeeds only when capacity remains.
    const claimed = await prisma.dedicatedIp.updateMany({
        where: {
            id: ip.id,
            state: { in: ['warming', 'active'] },
            paused_reason: null,
            sends_today: { lt: ip.daily_cap },
        },
        data: {
            sends_today: { increment: 1 },
        },
    });

    if (claimed.count === 0) {
        // At cap, paused, or state changed under us. Fall back to native.
        return { route: 'native', reason: 'Dedicated IP daily cap reached or unavailable' };
    }

    return {
        route: 'ses',
        ip: {
            id: ip.id,
            pool_name: ip.ses_pool_name,
            daily_cap: ip.daily_cap,
            warmup_day: ip.warmup_day,
        },
    };
}

/**
 * Refund a send-cap claim when the SES send itself fails. Without this,
 * a transient AWS error would still consume the day's quota. Best-effort
 * - never throws because we don't want to mask the original send error.
 */
export async function refundCapClaim(ipId: string): Promise<void> {
    try {
        await prisma.dedicatedIp.updateMany({
            where: { id: ipId, sends_today: { gt: 0 } },
            data: { sends_today: { decrement: 1 } },
        });
    } catch (err) {
        logger.warn('[SS_ROUTING] Cap refund failed (non-fatal)', {
            ipId,
            err: err instanceof Error ? err.message : String(err),
        });
    }
}
