/**
 * Polar webhook handler for LinkedIn account-slot add-ons.
 *
 * Mirrors handleSuperSenderWebhook in superSenderService.ts.
 *
 * Flow:
 *   1. Polar fires subscription.created / .active with our metadata.
 *   2. The billing router (services/billingService.ts) dispatches to
 *      this handler when metadata.linkedin_addon === 'true'.
 *   3. We flip the matching LinkedInAccountAddonPurchase row to
 *      'completed' and bump Organization.linkedin_account_addon_count.
 *   4. On subscription.canceled / .revoked we decrement the count.
 *
 * Idempotency: keyed off polar_subscription_id. If the row is already
 * 'completed' for this sub id we no-op.
 */

import { prisma } from '../../prisma';
import { logger } from '../observabilityService';

interface WebhookEventLike {
    type?: string;
    data?: {
        id?: string;
        metadata?: Record<string, string | number>;
    } & Record<string, unknown>;
}

export async function handleLinkedInAddonWebhook(event: WebhookEventLike, resolvedOrgId: string): Promise<void> {
    const subscriptionId = event.data?.id;
    if (!subscriptionId) {
        logger.warn('[LINKEDIN-ADDON] Webhook missing subscription id', { type: event.type });
        return;
    }

    const metadata = event.data?.metadata || {};
    const quantity = Math.max(1, Number(metadata.linkedin_addon_quantity || 1));

    if (event.type === 'subscription.canceled' || event.type === 'subscription.revoked') {
        await handleCancellation(resolvedOrgId, String(subscriptionId), quantity);
        return;
    }

    // .created / .active - bump the counter + flip the audit row.
    // Idempotency: look up the pending purchase row by polar_subscription_id
    // OR by polar_checkout_id (the latter is what we pre-created in
    // polarAddonCheckout.ts when the user clicked Buy).
    const checkoutId = String(metadata.checkout_id || '');
    const existing = await prisma.linkedInAccountAddonPurchase.findFirst({
        where: {
            organization_id: resolvedOrgId,
            OR: [
                { polar_subscription_id: String(subscriptionId) },
                checkoutId ? { polar_checkout_id: checkoutId } : { polar_checkout_id: { contains: '__never__' } },
            ],
        },
        orderBy: { purchased_at: 'desc' },
    });

    if (existing?.status === 'completed') {
        logger.info('[LINKEDIN-ADDON] Already completed - skipping', { subscriptionId });
        return;
    }

    // Atomic "claim and bump". Two simultaneous webhook deliveries can
    // both pass the line-60 guard (both see status='pending'); without a
    // database-level CAS, both would increment the counter. We claim the
    // pending row first via updateMany-with-status-guard - only ONE
    // tick's updateMany returns count > 0; the loser bails before
    // touching the counter.
    if (existing) {
        const claim = await prisma.linkedInAccountAddonPurchase.updateMany({
            where: { id: existing.id, status: { not: 'completed' } },
            data: {
                status: 'completed',
                polar_subscription_id: String(subscriptionId),
                quantity,
            },
        });
        if (claim.count === 0) {
            logger.info('[LINKEDIN-ADDON] Race lost - another delivery already completed this purchase', { subscriptionId });
            return;
        }
    } else {
        await prisma.linkedInAccountAddonPurchase.create({
            data: {
                organization_id: resolvedOrgId,
                user_id: 'unknown', // .name field on Polar event would carry this
                quantity,
                status: 'completed',
                polar_subscription_id: String(subscriptionId),
            },
        });
    }

    // Only fire the counter increment AFTER the row claim succeeded.
    // The previous implementation had the increment as the first stmt
    // in a $transaction, so a webhook retry that reached the transaction
    // (e.g., transient DB error mid-flight) would double-bump.
    await prisma.organization.update({
        where: { id: resolvedOrgId },
        data: { linkedin_account_addon_count: { increment: quantity } },
    });

    logger.info('[LINKEDIN-ADDON] Counter bumped', { organization_id: resolvedOrgId, subscriptionId, quantity });
}

async function handleCancellation(orgId: string, subscriptionId: string, _quantity: number): Promise<void> {
    const purchase = await prisma.linkedInAccountAddonPurchase.findFirst({
        where: { organization_id: orgId, polar_subscription_id: subscriptionId, status: 'completed' },
    });
    if (!purchase) {
        logger.warn('[LINKEDIN-ADDON] Cancellation for unknown purchase', { subscriptionId });
        return;
    }
    await prisma.$transaction([
        prisma.organization.update({
            where: { id: orgId },
            data: { linkedin_account_addon_count: { decrement: purchase.quantity } },
        }),
        prisma.linkedInAccountAddonPurchase.update({
            where: { id: purchase.id },
            data: { status: 'refunded', refunded_at: new Date() },
        }),
    ]);
    logger.info('[LINKEDIN-ADDON] Counter decremented on cancellation', { organization_id: orgId, subscriptionId, quantity: purchase.quantity });
}
