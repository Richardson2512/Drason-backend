/**
 * Polar checkout creation for LinkedIn account-slot add-ons.
 *
 * Mirrors superSenderService.createSuperSenderCheckout - one product
 * per slot, $15/account/month, quantity on the line item via metadata.
 * The Polar webhook router reads `metadata.linkedin_addon = 'true'` and
 * dispatches the event to handleLinkedInAddonWebhook (see
 * billingService.ts when wiring) which increments the addon counter +
 * creates the LinkedInAccountAddonPurchase row.
 *
 * Configuration:
 *   POLAR_LINKEDIN_ADDON_PRODUCT_ID - Polar product id, set in env.
 *                                     When unset, the controller falls
 *                                     back to the direct-increment stub
 *                                     path so the UI still works in dev.
 */

import { prisma } from '../../prisma';
import { logger } from '../observabilityService';
import { polarApi, ensurePolarCustomer } from '../polarClient';
import { LINKEDIN_ADDON_PRICE_USD } from './accountLimitService';

const PURCHASE_ELIGIBLE_TIERS = new Set([
    'starter', 'pro', 'pro_80k', 'pro_100k', 'pro_150k', 'pro_200k', 'pro_250k',
    'growth', 'scale', 'enterprise',
]);

export function isPolarConfigured(): boolean {
    return Boolean(process.env.POLAR_LINKEDIN_ADDON_PRODUCT_ID);
}

function getProductId(): string {
    const id = process.env.POLAR_LINKEDIN_ADDON_PRODUCT_ID;
    if (!id) {
        throw new Error('POLAR_LINKEDIN_ADDON_PRODUCT_ID is not configured');
    }
    return id;
}

async function checkTierGate(organizationId: string): Promise<{ ok: boolean; reason?: string }> {
    const org = await prisma.organization.findUnique({
        where: { id: organizationId },
        select: { subscription_tier: true, subscription_status: true },
    });
    if (!org) return { ok: false, reason: 'Organization not found' };
    if (!PURCHASE_ELIGIBLE_TIERS.has(org.subscription_tier)) {
        return { ok: false, reason: 'Upgrade to a paid plan to purchase LinkedIn account add-ons' };
    }
    if (org.subscription_status !== 'active') {
        return { ok: false, reason: 'Reactivate your subscription before purchasing add-ons' };
    }
    return { ok: true };
}

export interface CreateCheckoutInput {
    organizationId: string;
    userId: string;
    quantity: number;
}

export interface CreateCheckoutResult {
    checkoutUrl: string;
    checkoutId: string;
    quantity: number;
    unitPriceUsd: number;
}

/**
 * Hand-off to Polar. The redirect lands the user on Polar's hosted
 * checkout; on success Polar redirects back to the Accounts page with
 * ?checkout=success, and a webhook arrives async to flip the counter.
 */
export async function createLinkedInAddonCheckout(input: CreateCheckoutInput): Promise<CreateCheckoutResult> {
    if (input.quantity < 1 || input.quantity > 20) {
        throw new Error('Quantity must be between 1 and 20');
    }

    const gate = await checkTierGate(input.organizationId);
    if (!gate.ok) throw new Error(gate.reason || 'Not eligible');

    const productId = getProductId();
    const customerId = await ensurePolarCustomer(input.organizationId);
    const frontend = process.env.APP_URL || process.env.FRONTEND_URL || 'http://localhost:3000';

    const response = await polarApi.post('/checkouts', {
        product_id: productId,
        customer_id: customerId,
        success_url: `${frontend}/dashboard/linkedin/accounts?checkout=success`,
        cancel_url: `${frontend}/dashboard/linkedin/accounts?checkout=canceled`,
        metadata: {
            organization_id: input.organizationId,
            user_id: input.userId,
            // Marker for the Polar webhook router to dispatch this event to
            // the LinkedIn add-on handler instead of treating it as a tier
            // upgrade or a Super Sender purchase.
            linkedin_addon: 'true',
            linkedin_addon_quantity: String(input.quantity),
            linkedin_addon_unit_price_usd: String(LINKEDIN_ADDON_PRICE_USD),
        },
    });

    const checkoutId: string = response.data.id;
    const checkoutUrl: string = response.data.url;

    // Pre-create a pending audit row keyed to the checkout id. The webhook
    // will flip status='completed' + bump linkedin_account_addon_count on
    // confirmed payment, or 'failed' if the checkout was canceled.
    await prisma.linkedInAccountAddonPurchase.create({
        data: {
            organization_id: input.organizationId,
            user_id: input.userId,
            quantity: input.quantity,
            unit_price_usd: LINKEDIN_ADDON_PRICE_USD,
            status: 'pending',
            polar_checkout_id: checkoutId,
        },
    });

    logger.info('[LINKEDIN-ADDON] Polar checkout created', {
        organization_id: input.organizationId,
        checkout_id: checkoutId,
        quantity: input.quantity,
    });

    return {
        checkoutUrl,
        checkoutId,
        quantity: input.quantity,
        unitPriceUsd: LINKEDIN_ADDON_PRICE_USD,
    };
}
