/**
 * Polar reconciliation job (drift-detection only).
 *
 * Webhooks are the primary path that writes subscription_tier / _status /
 * next_billing_date. A lost or delayed delivery leaves a paying customer stuck
 * on the wrong tier/status indefinitely (Billing audit B1). This worker pulls
 * each org's subscription state back from Polar on a cadence and corrects local
 * drift to match Polar (the billing source of truth).
 *
 * SCOPE - deliberately conservative (this writes customer access state on a
 * schedule, so it stays inside tight rails):
 *   - It ONLY corrects status / tier / period_end, and ONLY to values that
 *     prod's webhook path already writes: status is mapped to the existing
 *     {active, trialing, past_due, canceled} vocabulary, tier is written only
 *     when it is a known TIER_LIMITS key. An unmapped status or unknown tier is
 *     left untouched rather than written blindly.
 *   - On ANY error fetching from Polar (404, 5xx, network) it SKIPS the org for
 *     this cycle - it never auto-cancels or flips state on an ambiguous error.
 *   - It does NOT autonomously cancel subscriptions in Polar. The staging
 *     "orphan plan-change cancel" (B3) is intentionally NOT ported here: it
 *     mutates the live billing system and can't be validated without a Polar
 *     sandbox. That remains a separate, manually-reviewed effort.
 *
 * Self-gated on POLAR_ACCESS_TOKEN; a no-op when Polar isn't configured.
 */

import { prisma } from '../index';
import { logger } from './observabilityService';
import * as polarClient from './polarClient';
import { TIER_LIMITS } from './polarClient';
import * as auditLogService from './auditLogService';

const RECONCILE_INTERVAL_MS = parseInt(
    process.env.POLAR_RECONCILE_INTERVAL_MS || String(60 * 60 * 1000),
    10,
);
/** Skip orgs reconciled inside this window - the webhook is primary, this is
 *  the safety net. */
const RECONCILE_FRESHNESS_MS = 60 * 60 * 1000;
const PER_CYCLE_CAP = 100;

let workerInterval: NodeJS.Timeout | null = null;

/** Map a Polar subscription status onto prod's existing vocabulary. Returns
 *  null for anything unrecognised so the reconciler leaves status untouched
 *  rather than writing a value the feature-gate layer doesn't understand. */
function mapPolarStatus(s: unknown): string | null {
    switch (s) {
        case 'active': return 'active';
        case 'trialing': return 'trialing';
        case 'past_due':
        case 'unpaid': return 'past_due';
        case 'canceled':
        case 'incomplete_expired': return 'canceled';
        default: return null;
    }
}

export function startPolarReconciler(): void {
    if (workerInterval) {
        logger.warn('[POLAR_RECONCILER] Already running');
        return;
    }
    if (!process.env.POLAR_ACCESS_TOKEN) {
        logger.warn('[POLAR_RECONCILER] POLAR_ACCESS_TOKEN not set - reconciler disabled');
        return;
    }
    logger.info('[POLAR_RECONCILER] Starting', { intervalMs: RECONCILE_INTERVAL_MS });
    // Delay the first run so the rest of boot finishes first.
    setTimeout(() => {
        runReconcileOnce().catch(err =>
            logger.error('[POLAR_RECONCILER] Initial run failed',
                err instanceof Error ? err : new Error(String(err))));
    }, 30_000);
    workerInterval = setInterval(() => {
        runReconcileOnce().catch(err =>
            logger.error('[POLAR_RECONCILER] Cycle failed',
                err instanceof Error ? err : new Error(String(err))));
    }, RECONCILE_INTERVAL_MS);
}

export function stopPolarReconciler(): void {
    if (workerInterval) {
        clearInterval(workerInterval);
        workerInterval = null;
        logger.info('[POLAR_RECONCILER] Stopped');
    }
}

/** One pass: pull stale orgs with a Polar subscription, reconcile each. Exposed
 *  for tests + manual reruns. */
export async function runReconcileOnce(): Promise<{ scanned: number; reconciled: number; errors: number }> {
    const stale = new Date(Date.now() - RECONCILE_FRESHNESS_MS);

    const orgs = await prisma.organization.findMany({
        where: {
            polar_subscription_id: { not: null },
            OR: [{ polar_reconciled_at: null }, { polar_reconciled_at: { lt: stale } }],
        },
        select: {
            id: true,
            polar_subscription_id: true,
            subscription_tier: true,
            subscription_status: true,
            next_billing_date: true,
        },
        take: PER_CYCLE_CAP,
    });

    let reconciled = 0;
    let errors = 0;

    for (const org of orgs) {
        try {
            if (await reconcileOneOrg(org)) reconciled++;
        } catch (err) {
            errors++;
            logger.warn('[POLAR_RECONCILER] Skipped org (Polar fetch failed, will retry)', {
                orgId: org.id,
                err: err instanceof Error ? err.message : String(err),
            });
        } finally {
            // Stamp regardless of success/error so a single bad subscription
            // can't get re-hit every cycle; an errored org simply waits one
            // window and tries again - with NO state change applied.
            await prisma.organization.update({
                where: { id: org.id },
                data: { polar_reconciled_at: new Date() },
            }).catch(() => undefined);
        }
    }

    logger.info('[POLAR_RECONCILER] Pass complete', { scanned: orgs.length, reconciled, errors });
    return { scanned: orgs.length, reconciled, errors };
}

interface ReconcileOrg {
    id: string;
    polar_subscription_id: string | null;
    subscription_tier: string;
    subscription_status: string;
    next_billing_date: Date | null;
}

/** Fetch one org's Polar subscription and apply any safe drift correction.
 *  Returns true when a change was written. Throws if the Polar fetch fails
 *  (the caller treats that as "skip this org, retry next cycle"). */
async function reconcileOneOrg(org: ReconcileOrg): Promise<boolean> {
    if (!org.polar_subscription_id) return false;

    // getSubscription throws on any non-2xx (incl. 404); we let it propagate so
    // the caller skips this org rather than guessing a cancel from an error.
    const remote = await polarClient.getSubscription(org.polar_subscription_id);

    const mappedStatus = mapPolarStatus(remote?.status);
    const remoteTierRaw = remote?.metadata?.tier;
    // Only accept a tier we recognise; never write an unknown/garbage tier.
    const remoteTier = typeof remoteTierRaw === 'string' && TIER_LIMITS[remoteTierRaw]
        ? remoteTierRaw
        : null;
    const remotePeriodEnd = remote?.current_period_end ? new Date(remote.current_period_end) : null;

    const statusChanged = mappedStatus !== null && mappedStatus !== org.subscription_status;
    const tierChanged = remoteTier !== null && remoteTier !== org.subscription_tier;
    const periodChanged = !!remotePeriodEnd &&
        (!org.next_billing_date || org.next_billing_date.getTime() !== remotePeriodEnd.getTime());

    if (!statusChanged && !tierChanged && !periodChanged) return false;

    await prisma.organization.update({
        where: { id: org.id },
        data: {
            ...(statusChanged ? { subscription_status: mappedStatus! } : {}),
            ...(tierChanged ? { subscription_tier: remoteTier! } : {}),
            ...(periodChanged ? { next_billing_date: remotePeriodEnd } : {}),
        },
    });

    await auditLogService.logAction({
        organizationId: org.id,
        entity: 'subscription',
        entityId: org.polar_subscription_id,
        trigger: 'polar_reconciler',
        action: 'reconciled_drift',
        details: `Corrected webhook-missed drift from Polar. status: ${org.subscription_status}` +
            `${statusChanged ? ` -> ${mappedStatus}` : ' (unchanged)'}; tier: ${org.subscription_tier}` +
            `${tierChanged ? ` -> ${remoteTier}` : ' (unchanged)'}; period_end: ` +
            `${org.next_billing_date?.toISOString() ?? 'null'}${periodChanged ? ` -> ${remotePeriodEnd?.toISOString()}` : ' (unchanged)'}`,
    });

    logger.warn('[POLAR_RECONCILER] Drift corrected', { orgId: org.id, statusChanged, tierChanged, periodChanged });
    return true;
}
