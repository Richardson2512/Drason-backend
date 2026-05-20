/**
 * Polar reconciliation job.
 *
 * Background worker that pulls subscription state back from Polar so the
 * platform's DB doesn't drift when webhooks are lost / delayed / fail.
 *
 * Pre-fix (Billing audit B1 + B3):
 *   - Webhooks were the ONLY path that wrote subscription_tier /
 *     subscription_status / polar_subscription_id. A lost delivery left
 *     a paying customer stuck on 'trialing' indefinitely. Polar retries
 *     a few times then gives up; our `200-on-error` design (which
 *     prevents retry storms on permanent errors) also accelerates the
 *     drift case.
 *   - The plan-change branch in handleSubscriptionCreated cancels the
 *     PREVIOUS subscription at period end on a best-effort basis. If
 *     that cancel-attempt fails (network, Polar 5xx, transient auth),
 *     the org carries two active subscriptions in Polar and will be
 *     double-billed at next renewal. Documented as "operator
 *     reconciles manually" - this job IS the reconciler.
 *
 * Loop:
 *   1. Every RECONCILE_INTERVAL_MS, find every org with a non-null
 *      polar_subscription_id that hasn't been reconciled in the last
 *      hour.
 *   2. For each, GET /v1/subscriptions/{id} from Polar.
 *   3. Apply diffs to subscription_status / subscription_tier /
 *      next_billing_date. Emit an audit row for each change so the
 *      operator can see the reconciler caught something the webhook
 *      didn't.
 *   4. Detect orphan plan-change subscriptions: org rows store
 *      subscription_started_at; any OAuthAccessToken-style 'previous
 *      subscription_id' we know about (via the SubscriptionEvent log
 *      of subscription.created events tied to this org) that is still
 *      active in Polar AND is NOT the current polar_subscription_id
 *      gets a re-attempt of cancel-at-period-end.
 *
 * Best-effort across the board: every Polar call is wrapped, a single
 * org's failure does not block the rest.
 */

import { prisma } from '../prisma';
import { logger } from './observabilityService';
import * as polarClient from './polarClient';
import * as auditLogService from './auditLogService';

const RECONCILE_INTERVAL_MS = parseInt(
    process.env.POLAR_RECONCILE_INTERVAL_MS || String(60 * 60 * 1000),
    10,
);
/** Skip orgs reconciled inside this window - the webhook path is the
 *  primary mechanism, the reconciler is the safety net. */
const RECONCILE_FRESHNESS_MS = 60 * 60 * 1000; // 1 hour

let workerInterval: NodeJS.Timeout | null = null;

export function startPolarReconciler(): void {
    if (workerInterval) {
        logger.warn('[POLAR_RECONCILER] Worker already running');
        return;
    }
    if (!process.env.POLAR_ACCESS_TOKEN) {
        logger.warn('[POLAR_RECONCILER] POLAR_ACCESS_TOKEN not set - reconciler disabled');
        return;
    }
    logger.info('[POLAR_RECONCILER] Starting reconciler', {
        intervalMs: RECONCILE_INTERVAL_MS,
        freshnessMs: RECONCILE_FRESHNESS_MS,
    });
    // Run once on startup (delayed slightly so the rest of the boot path
    // finishes first), then on interval.
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

/**
 * One pass: pull all orgs with a Polar subscription, reconcile each.
 * Exposed for tests + manual reruns from a one-off script.
 */
export async function runReconcileOnce(): Promise<{
    scanned: number;
    reconciled: number;
    orphans_resolved: number;
    errors: number;
}> {
    const stale = new Date(Date.now() - RECONCILE_FRESHNESS_MS);

    const orgs = await prisma.organization.findMany({
        where: {
            polar_subscription_id: { not: null },
            // Either never reconciled, or stale.
            OR: [
                { polar_reconciled_at: null },
                { polar_reconciled_at: { lt: stale } },
            ],
        },
        select: {
            id: true,
            polar_subscription_id: true,
            subscription_tier: true,
            subscription_status: true,
            next_billing_date: true,
        },
        // Cap the per-cycle work so a backlog can't starve the API quota.
        take: 100,
    });

    let reconciled = 0;
    let orphansResolved = 0;
    let errors = 0;

    for (const org of orgs) {
        try {
            const changed = await reconcileOneOrg(org);
            if (changed) reconciled++;
            const orphan = await resolveOrphanedSubscriptions(org.id, org.polar_subscription_id!);
            if (orphan) orphansResolved++;
        } catch (err) {
            errors++;
            logger.warn('[POLAR_RECONCILER] Failed to reconcile org (continuing)', {
                orgId: org.id,
                err: err instanceof Error ? err.message : String(err),
            });
        }
        // Stamp the timestamp regardless of changed-or-not so we don't
        // re-hit Polar on the next cycle for the same already-current
        // row. A reconciler that loops on the same orgs is a waste.
        await prisma.organization.update({
            where: { id: org.id },
            data: { polar_reconciled_at: new Date() },
        }).catch(() => undefined);
    }

    logger.info('[POLAR_RECONCILER] Pass complete', {
        scanned: orgs.length, reconciled, orphans_resolved: orphansResolved, errors,
    });

    return { scanned: orgs.length, reconciled, orphans_resolved: orphansResolved, errors };
}

/**
 * Fetch the current Polar state for one org's subscription and apply
 * any diffs to our DB. Returns true when something changed.
 */
async function reconcileOneOrg(org: {
    id: string;
    polar_subscription_id: string | null;
    subscription_tier: string;
    subscription_status: string;
    next_billing_date: Date | null;
}): Promise<boolean> {
    if (!org.polar_subscription_id) return false;

    const remote = await polarClient.getSubscription(org.polar_subscription_id).catch(err => {
        // 404 means the subscription was deleted in Polar - treat as
        // canceled. Anything else we surface as a soft error.
        const status = err?.status || err?.response?.status;
        if (status === 404) {
            return { _missing: true } as any;
        }
        throw err;
    });

    if (remote?._missing) {
        if (org.subscription_status !== 'canceled') {
            await prisma.organization.update({
                where: { id: org.id },
                data: { subscription_status: 'canceled', polar_subscription_id: null },
            });
            await auditLogService.logAction({
                organizationId: org.id,
                entity: 'subscription',
                entityId: org.polar_subscription_id,
                trigger: 'polar_reconciler',
                action: 'canceled_remote_missing',
                details: 'Polar reports the subscription no longer exists; flipped local state to canceled.',
            });
            return true;
        }
        return false;
    }

    // Map Polar subscription state to our internal vocab. Polar uses
    // 'active' | 'canceled' | 'past_due' | 'unpaid' | etc.; we mirror
    // the few we drive UI from.
    const remoteStatus = (remote?.status as string | undefined) || org.subscription_status;
    const remoteTier = (remote?.metadata?.tier as string | undefined) || org.subscription_tier;
    const remotePeriodEnd = remote?.current_period_end
        ? new Date(remote.current_period_end as string)
        : null;

    const statusChanged = remoteStatus !== org.subscription_status;
    const tierChanged = remoteTier !== org.subscription_tier;
    const periodChanged = remotePeriodEnd && (!org.next_billing_date ||
        org.next_billing_date.getTime() !== remotePeriodEnd.getTime());

    if (!statusChanged && !tierChanged && !periodChanged) return false;

    await prisma.organization.update({
        where: { id: org.id },
        data: {
            ...(statusChanged ? { subscription_status: remoteStatus } : {}),
            ...(tierChanged ? { subscription_tier: remoteTier } : {}),
            ...(periodChanged ? { next_billing_date: remotePeriodEnd } : {}),
        },
    });

    await auditLogService.logAction({
        organizationId: org.id,
        entity: 'subscription',
        entityId: org.polar_subscription_id,
        trigger: 'polar_reconciler',
        action: 'reconciled',
        details: `Reconciler applied diff from Polar. status: ${org.subscription_status} → ${remoteStatus}; tier: ${org.subscription_tier} → ${remoteTier}; period_end: ${org.next_billing_date?.toISOString() ?? 'null'} → ${remotePeriodEnd?.toISOString() ?? 'null'}`,
    });

    logger.warn('[POLAR_RECONCILER] Drift detected - applied diff', {
        orgId: org.id,
        statusChanged, tierChanged, periodChanged,
    });
    return true;
}

/**
 * Re-attempt cancel-at-period-end for any subscription this org previously
 * had that is NOT the current polar_subscription_id but might still be
 * active in Polar (orphan from a plan-change where the cancel call failed
 * - Billing audit B3).
 *
 * We use the SubscriptionEvent table as the historical record of prior
 * subscription IDs. Any subscription.created row whose data.id differs
 * from the current id is a candidate.
 */
async function resolveOrphanedSubscriptions(orgId: string, currentSubId: string): Promise<boolean> {
    const priorCreated = await prisma.subscriptionEvent.findMany({
        where: {
            organization_id: orgId,
            event_type: { in: ['subscription.created', 'subscription.active'] },
        },
        orderBy: { created_at: 'desc' },
        take: 20,
        select: { payload: true },
    });

    const priorIds = new Set<string>();
    for (const row of priorCreated) {
        const id = (row.payload as any)?.id;
        if (typeof id === 'string' && id !== currentSubId) priorIds.add(id);
    }
    if (priorIds.size === 0) return false;

    let resolved = false;
    for (const oldId of priorIds) {
        const remote = await polarClient.getSubscription(oldId).catch(err => {
            const status = err?.status || err?.response?.status;
            if (status === 404) return null;
            throw err;
        });
        if (!remote) continue;
        const status = remote.status as string | undefined;
        const cancelAtPeriodEnd = !!remote.cancel_at_period_end;
        // Only act on orphans that are STILL active and NOT already set
        // to cancel-at-period-end. Anything else means the prior cancel
        // path actually worked or the sub naturally ended.
        if (status === 'active' && !cancelAtPeriodEnd) {
            try {
                await polarClient.cancelSubscriptionAtPeriodEnd(oldId, {
                    orgId,
                    reason: `reconciler_orphan_resolution; current=${currentSubId}`,
                });
                resolved = true;
                await auditLogService.logAction({
                    organizationId: orgId,
                    entity: 'subscription',
                    entityId: oldId,
                    trigger: 'polar_reconciler',
                    action: 'orphan_canceled',
                    details: `Reconciler canceled orphan subscription left active after a plan change. Current subscription: ${currentSubId}.`,
                });
            } catch (err) {
                // Will retry on the next reconciler pass.
                logger.warn('[POLAR_RECONCILER] Orphan cancel failed (will retry next pass)', {
                    orgId, oldId,
                    err: err instanceof Error ? err.message : String(err),
                });
            }
        }
    }
    return resolved;
}
