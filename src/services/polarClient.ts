/**
 * Polar Client Service
 *
 * Wrapper around Polar.sh API for payment gateway integration.
 * Handles customer creation, checkout sessions, and subscription management.
 */

import axios from 'axios';
import { logger } from './observabilityService';
import { prisma } from '../index';

// ============================================================================
// TYPES
// ============================================================================

/**
 * Tier-based caps. Only two real meters: monthly send volume and email-validation
 * credits. Everything else (leads, domains, mailboxes, DNSBL depth, webhook count)
 * is unlimited at every paid tier — the protection layer is a flat capability,
 * not a metered one. This keeps the pricing message simple ("send N/mo, validate
 * N/mo, everything else unlimited") and avoids charging for protection on a
 * per-entity basis.
 */
export interface TierLimits {
    validationCredits: number;
    monthlySendLimit: number;
}

export interface CheckoutSession {
    url: string;
    id: string;
}

// ============================================================================
// CONSTANTS
// ============================================================================

// ────────────────────────────────────────────────────────────────────
// Pro tier — volume dropdown
// ────────────────────────────────────────────────────────────────────
// Each variant maps to a distinct Polar product so checkout can be routed
// correctly once the product IDs are filled in. Keep this array in sync with
// the frontend dropdown in frontend/src/app/pricing/page.tsx
// (PricingCard `sendsDropdown` prop).

interface ProSendTier {
    key: string;          // tier key written to Organization.subscription_tier
    sends: number;
    credits: number;
    price: number;        // USD, monthly
}

export const PRO_SEND_TIERS: ProSendTier[] = [
    { key: 'pro',      sends:  60000, credits: 10000, price:  49 }, // default / anchor
    { key: 'pro_80k',  sends:  80000, credits: 15000, price:  59 },
    { key: 'pro_100k', sends: 100000, credits: 20000, price:  79 },
    { key: 'pro_150k', sends: 150000, credits: 30000, price: 109 },
    { key: 'pro_200k', sends: 200000, credits: 40000, price: 139 },
    { key: 'pro_250k', sends: 250000, credits: 50000, price: 169 },
];

const PRO_TIER_LIMITS: Record<string, TierLimits> = Object.fromEntries(
    PRO_SEND_TIERS.map(t => [
        t.key,
        {
            validationCredits: t.credits,
            monthlySendLimit: t.sends,
        },
    ])
);

export const TIER_LIMITS: Record<string, TierLimits> = {
    trial:      { validationCredits: 10000,    monthlySendLimit: 60000 },
    starter:    { validationCredits: 3000,     monthlySendLimit: 20000 },
    // Pro family — default 60k anchor + 5 dropdown variants (80k/100k/150k/200k/250k).
    ...PRO_TIER_LIMITS,
    growth:     { validationCredits: 60000,    monthlySendLimit: 300000 },
    scale:      { validationCredits: 100000,   monthlySendLimit: 600000 },
    enterprise: { validationCredits: Infinity, monthlySendLimit: Infinity },
};

/**
 * Given a `sends` value from the pricing page dropdown, return the tier key
 * that should be written to Organization.subscription_tier. Falls back to
 * the default 'pro' tier if the value does not match any configured variant.
 */
export function proTierKeyForSends(sends: number): string {
    const match = PRO_SEND_TIERS.find(t => t.sends === sends);
    return match ? match.key : 'pro';
}

/**
 * True for any Pro family tier (pro, pro_80k, …, pro_250k).
 */
export function isProTier(tierKey: string): boolean {
    return PRO_SEND_TIERS.some(t => t.key === tierKey);
}

const POLAR_API_BASE = 'https://api.polar.sh/v1';
const POLAR_ACCESS_TOKEN = process.env.POLAR_ACCESS_TOKEN;

// Each Pro volume option corresponds to its own Polar product. Until the
// matching Polar products exist the values fall back to the 60k product so
// checkout still resolves to *something* while the UI is being validated.
// Replace each env var once the Polar dashboard has the matching products.
const PRO_PRODUCT_FALLBACK = process.env.POLAR_PRO_PRODUCT_ID || process.env.POLAR_STARTER_PRODUCT_ID || '';

const PRODUCT_IDS: Record<string, string> = {
    starter: process.env.POLAR_STARTER_PRODUCT_ID || 'dfa51c15-8e20-452d-b51a-476d94b73d21',
    pro: process.env.POLAR_PRO_PRODUCT_ID || PRO_PRODUCT_FALLBACK,
    pro_80k:  process.env.POLAR_PRO_80K_PRODUCT_ID  || '7eda5c17-e9fc-4685-9e86-7a3c8b66fd79',
    pro_100k: process.env.POLAR_PRO_100K_PRODUCT_ID || '85e99d6f-a3cd-4dff-8c06-d28a74347878',
    pro_150k: process.env.POLAR_PRO_150K_PRODUCT_ID || 'bea564d5-82f9-4e8b-8551-9e38bf698c0f',
    pro_200k: process.env.POLAR_PRO_200K_PRODUCT_ID || 'f27a02fa-92bf-465f-879d-d6179f14f12c',
    pro_250k: process.env.POLAR_PRO_250K_PRODUCT_ID || 'd070f69d-f1ae-44d6-893f-e4b460ee16f3',
    growth: process.env.POLAR_GROWTH_PRODUCT_ID || '0690578b-2fe7-4e05-a2e2-a258a90599e9',
    scale: process.env.POLAR_SCALE_PRODUCT_ID || 'edae6a6e-bfd2-4f24-9092-197021cf984d'
};

// ============================================================================
// POLAR API CLIENT
// ============================================================================

const polarApi = axios.create({
    baseURL: POLAR_API_BASE,
    headers: {
        'Authorization': `Bearer ${POLAR_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
    }
});

// ============================================================================
// CUSTOMER MANAGEMENT
// ============================================================================

/**
 * Ensure a Polar customer exists for an organization.
 * Creates a new customer if one doesn't exist.
 */
export async function ensurePolarCustomer(orgId: string): Promise<string> {
    const org = await prisma.organization.findUnique({
        where: { id: orgId },
        include: { users: { take: 1, orderBy: { created_at: 'asc' } } }
    });

    if (!org) {
        throw new Error(`Organization not found: ${orgId}`);
    }

    // If customer already exists, return it
    if (org.polar_customer_id) {
        return org.polar_customer_id;
    }

    // Create new Polar customer
    const customerEmail = org.users[0]?.email || `${org.slug}@superkabe.com`;

    try {
        const response = await polarApi.post('/customers', {
            email: customerEmail,
            name: org.name,
            metadata: {
                organization_id: orgId,
                organization_slug: org.slug
            }
        });

        const customerId = response.data.id;

        // Update organization with customer ID
        await prisma.organization.update({
            where: { id: orgId },
            data: { polar_customer_id: customerId }
        });

        logger.info(`[POLAR] Created customer for organization ${orgId}`, { customerId });

        return customerId;
    } catch (error: any) {
        // Log the FULL Polar error response so we know exactly what was rejected
        if (error?.response) {
            logger.error('[POLAR] Customer creation rejected', new Error(JSON.stringify({
                status: error.response.status,
                body: error.response.data,
                email: customerEmail,
                orgId
            })));
        }

        // 422 = customer with this email already exists in Polar
        // (can happen if a previous attempt created the customer but DB save failed)
        // Look up the existing customer and link it
        if (error?.response?.status === 422) {
            logger.info(`[POLAR] Customer may already exist for ${customerEmail}, looking up...`);
            try {
                const searchResponse = await polarApi.get('/customers', {
                    params: { email: customerEmail, limit: 1 }
                });

                const existingCustomer = searchResponse.data?.items?.[0] || searchResponse.data?.result?.[0];
                if (existingCustomer?.id) {
                    await prisma.organization.update({
                        where: { id: orgId },
                        data: { polar_customer_id: existingCustomer.id }
                    });

                    logger.info(`[POLAR] Linked existing customer for ${orgId}`, { customerId: existingCustomer.id });
                    return existingCustomer.id;
                }
            } catch (lookupError) {
                logger.error('[POLAR] Failed to look up existing customer', lookupError instanceof Error ? lookupError : new Error(String(lookupError)));
            }
        }

        logger.error('[POLAR] Failed to create customer', error instanceof Error ? error : new Error(String(error)));
        throw new Error('Failed to create Polar customer');
    }
}

// ============================================================================
// CHECKOUT SESSIONS
// ============================================================================

/**
 * Create a Polar checkout session for upgrading to a paid tier.
 */
export async function createCheckoutSession(
    orgId: string,
    tier: 'starter' | 'growth' | 'scale'
): Promise<CheckoutSession> {
    const customerId = await ensurePolarCustomer(orgId);
    const productId = PRODUCT_IDS[tier];

    if (!productId) {
        throw new Error(`Invalid tier or missing product ID: ${tier}`);
    }

    try {
        const response = await polarApi.post('/checkouts', {
            product_id: productId,
            customer_id: customerId,
            success_url: `${process.env.FRONTEND_URL}/dashboard/settings?checkout=success`,
            cancel_url: `${process.env.FRONTEND_URL}/dashboard/settings?checkout=canceled`,
            metadata: {
                organization_id: orgId,
                tier
            }
        });

        logger.info(`[POLAR] Created checkout session for ${orgId} → ${tier}`, {
            checkoutId: response.data.id
        });

        return {
            url: response.data.url,
            id: response.data.id
        };
    } catch (error) {
        logger.error('[POLAR] Failed to create checkout session', error instanceof Error ? error : new Error(String(error)));
        throw new Error('Failed to create checkout session');
    }
}

// ============================================================================
// SUBSCRIPTION MANAGEMENT
// ============================================================================

/**
 * Cancel a subscription in Polar.
 */
export async function cancelSubscription(orgId: string): Promise<void> {
    const org = await prisma.organization.findUnique({
        where: { id: orgId },
        select: { polar_subscription_id: true }
    });

    if (!org?.polar_subscription_id) {
        throw new Error('No active subscription found');
    }

    try {
        await polarApi.post(`/subscriptions/${org.polar_subscription_id}/cancel`, {
            cancel_at_period_end: true // Don't cancel immediately, wait for billing period end
        });

        logger.info(`[POLAR] Canceled subscription for ${orgId}`, {
            subscriptionId: org.polar_subscription_id
        });
    } catch (error) {
        logger.error('[POLAR] Failed to cancel subscription', error instanceof Error ? error : new Error(String(error)));
        throw new Error('Failed to cancel subscription');
    }
}

/**
 * Change subscription to a different tier (upgrade or downgrade).
 * Upgrades: prorated, take effect immediately.
 * Downgrades: take effect at end of current billing period.
 */
export async function changeSubscription(orgId: string, newTier: string): Promise<{ success: boolean; effective: 'immediate' | 'end_of_period' }> {
    const org = await prisma.organization.findUnique({
        where: { id: orgId },
        select: { polar_subscription_id: true, subscription_tier: true }
    });

    if (!org?.polar_subscription_id) {
        throw new Error('No active subscription found. Use checkout for new subscriptions.');
    }

    const newProductId = PRODUCT_IDS[newTier];
    if (!newProductId) {
        throw new Error(`Invalid tier or missing product ID: ${newTier}`);
    }

    const tierOrder: Record<string, number> = { trial: 0, starter: 1, pro: 2, growth: 3, scale: 4, enterprise: 5 };
    const currentRank = tierOrder[org.subscription_tier || 'trial'] || 0;
    const newRank = tierOrder[newTier] || 0;
    const isUpgrade = newRank > currentRank;

    try {
        await polarApi.patch(`/subscriptions/${org.polar_subscription_id}`, {
            product_id: newProductId,
            proration_behavior: isUpgrade ? 'create_prorations' : 'none',
        });

        // Update org tier
        await prisma.organization.update({
            where: { id: orgId },
            data: { subscription_tier: newTier },
        });

        logger.info(`[POLAR] Subscription changed for ${orgId}: ${org.subscription_tier} → ${newTier}`, {
            subscriptionId: org.polar_subscription_id,
            direction: isUpgrade ? 'upgrade' : 'downgrade',
        });

        return { success: true, effective: isUpgrade ? 'immediate' : 'end_of_period' };
    } catch (error) {
        logger.error('[POLAR] Failed to change subscription', error instanceof Error ? error : new Error(String(error)));
        throw new Error('Failed to change subscription');
    }
}

/**
 * Get subscription details from Polar.
 */
export async function getSubscription(subscriptionId: string): Promise<any> {
    try {
        const response = await polarApi.get(`/subscriptions/${subscriptionId}`);
        return response.data;
    } catch (error) {
        logger.error('[POLAR] Failed to fetch subscription', error instanceof Error ? error : new Error(String(error)));
        throw new Error('Failed to fetch subscription details');
    }
}

// ============================================================================
// VALIDATION
// ============================================================================

/**
 * Validate Polar webhook signature using HMAC-SHA256.
 */
export function validateWebhookSignature(
    payload: string,
    signature: string,
    secret: string
): boolean {
    const crypto = require('crypto');
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(payload);
    const expectedSignature = hmac.digest('hex');
    return crypto.timingSafeEqual(
        Buffer.from(signature),
        Buffer.from(expectedSignature)
    );
}
