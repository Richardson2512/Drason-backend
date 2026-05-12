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

// Polar product IDs — every tier the dashboard exposes. The hardcoded
// fallback for each entry is the live Polar product UUID confirmed by the
// operator on 2026-05-04; env vars override only if explicitly set, which
// is normally only needed for staging vs prod splits.
//
// Earlier this map had a `PRO_PRODUCT_FALLBACK` chain that fell back to
// `POLAR_STARTER_PRODUCT_ID` when `POLAR_PRO_PRODUCT_ID` was unset. That
// silently routed Pro checkouts to the Starter product (or vice versa
// when a Starter-named env var actually held a Pro UUID), producing the
// "I clicked Starter but landed on Pro" mis-route. Removing the chain so
// each tier resolves only to its own ID — there is no cross-tier
// fallback path in this map by design.
const PRODUCT_IDS: Record<string, string> = {
    starter:  process.env.POLAR_STARTER_PRODUCT_ID  || 'dfa51c15-8e20-452d-b51a-476d94b73d21',
    pro:      process.env.POLAR_PRO_PRODUCT_ID      || 'f82a3f93-14d5-49c6-b6cf-6bc0d8e6ca6c',
    pro_80k:  process.env.POLAR_PRO_80K_PRODUCT_ID  || '7eda5c17-e9fc-4685-9e86-7a3c8b66fd79',
    pro_100k: process.env.POLAR_PRO_100K_PRODUCT_ID || '85e99d6f-a3cd-4dff-8c06-d28a74347878',
    pro_150k: process.env.POLAR_PRO_150K_PRODUCT_ID || 'bea564d5-82f9-4e8b-8551-9e38bf698c0f',
    pro_200k: process.env.POLAR_PRO_200K_PRODUCT_ID || 'f27a02fa-92bf-465f-879d-d6179f14f12c',
    pro_250k: process.env.POLAR_PRO_250K_PRODUCT_ID || 'd070f69d-f1ae-44d6-893f-e4b460ee16f3',
    growth:   process.env.POLAR_GROWTH_PRODUCT_ID   || '0690578b-2fe7-4e05-a2e2-a258a90599e9',
    scale:    process.env.POLAR_SCALE_PRODUCT_ID    || 'edae6a6e-bfd2-4f24-9092-197021cf984d',
};

// Boot-time sanity check: warn loudly if any tier resolves to the same
// product UUID as another, since that's almost always a misconfiguration
// (e.g. POLAR_STARTER_PRODUCT_ID accidentally set to the Pro UUID), and
// it's exactly what produced the cross-tier mis-route customers saw.
(() => {
    const seen = new Map<string, string>();
    for (const [tier, id] of Object.entries(PRODUCT_IDS)) {
        if (!id) {
            console.warn(`[POLAR] No product ID configured for tier "${tier}" — checkout will fail`);
            continue;
        }
        const prior = seen.get(id);
        if (prior) {
            console.warn(`[POLAR] Tier "${tier}" and "${prior}" both map to product ID ${id} — fix the env var override or the hardcoded fallback`);
        }
        seen.set(id, tier);
    }
})();

// ============================================================================
// POLAR API CLIENT
// ============================================================================

export const polarApi = axios.create({
    baseURL: POLAR_API_BASE,
    headers: {
        'Authorization': `Bearer ${POLAR_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
    }
});

/**
 * Centralized error reporter for Polar API calls. Every polarApi.* catch
 * should funnel through this so Railway logs reliably contain the actual
 * Polar rejection (status + response body) instead of just the axios
 * wrapper Error.message ("Request failed with status code 422"). Returns
 * a string suitable for re-throwing as the user-facing error message —
 * Polar's `detail` / `error` fields usually surface the field that failed
 * validation, which is what an operator (or the customer in the dashboard)
 * actually needs to act on.
 */
function logPolarError(prefix: string, error: any, context: Record<string, any>): string {
    const status = error?.response?.status;
    const data = error?.response?.data;
    const wrapperMessage = error instanceof Error ? error.message : String(error);

    // Console.error so Railway captures the structured detail; logger.error
    // is for indexed structured logs and only sees the wrapper Error.
    console.error(`${prefix} — Polar API error detail`, {
        ...context,
        status,
        responseBody: data,
        wrapperMessage,
    });
    logger.error(prefix, error instanceof Error ? error : new Error(wrapperMessage));

    // Polar response body can be string, an object with detail/error/message,
    // or an array of validation errors (FastAPI-style). Try each.
    if (typeof data === 'string' && data.trim()) return data;
    if (data && typeof data === 'object') {
        if (typeof data.detail === 'string') return data.detail;
        if (Array.isArray(data.detail) && data.detail[0]?.msg) {
            const first = data.detail[0];
            const fieldPath = Array.isArray(first.loc) ? first.loc.join('.') : '';
            return fieldPath ? `${fieldPath}: ${first.msg}` : first.msg;
        }
        if (typeof data.error === 'string') return data.error;
        if (typeof data.message === 'string') return data.message;
    }
    return `Polar API error${status ? ` (HTTP ${status})` : ''}: ${wrapperMessage}`;
}

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
        // 422 = customer with this email already exists in Polar
        // (can happen if a previous attempt created the customer but DB save failed)
        // Look up the existing customer and link it.
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
            } catch (lookupError: any) {
                logPolarError('[POLAR] Failed to look up existing customer', lookupError, { customerEmail, orgId });
                // fall through to the main error path below
            }
        }

        const detail = logPolarError('[POLAR] Failed to create customer', error, {
            orgId,
            customerEmail,
        });
        throw new Error(detail);
    }
}

// ============================================================================
// CHECKOUT SESSIONS
// ============================================================================

/**
 * Create a Polar checkout session for any paid tier — initial subscription
 * or plan change. The checkout flow is the single payment path: every
 * subscribe / upgrade / downgrade / re-subscribe goes through here so
 * coupon and non-coupon customers are treated identically and the new
 * tier's price is always actually paid.
 */
export async function createCheckoutSession(
    orgId: string,
    tier: string
): Promise<CheckoutSession> {
    const customerId = await ensurePolarCustomer(orgId);
    const productId = PRODUCT_IDS[tier];

    if (!productId) {
        throw new Error(`Invalid tier or missing product ID: ${tier}`);
    }

    // Log the resolved product_id alongside the requested tier so a
    // misconfigured env var (e.g. POLAR_STARTER_PRODUCT_ID set to a Pro
    // product) shows up in Railway the first time a customer hits it,
    // instead of being discovered by support tickets.
    logger.info('[POLAR] Checkout product resolved', {
        orgId,
        requestedTier: tier,
        resolvedProductId: productId,
        envOverride: !!process.env[`POLAR_${tier.toUpperCase()}_PRODUCT_ID`],
    });

    try {
        const response = await polarApi.post('/checkouts', {
            product_id: productId,
            customer_id: customerId,
            success_url: `${process.env.APP_URL || process.env.FRONTEND_URL}/dashboard/settings?checkout=success`,
            cancel_url: `${process.env.APP_URL || process.env.FRONTEND_URL}/dashboard/settings?checkout=canceled`,
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
    } catch (error: any) {
        const detail = logPolarError('[POLAR] Failed to create checkout session', error, {
            orgId,
            tier,
            productId,
            customerId,
        });
        throw new Error(detail);
    }
}

// ============================================================================
// SUBSCRIPTION MANAGEMENT
// ============================================================================

/**
 * Cancel a subscription in Polar at the end of the current billing period.
 *
 * Uses the canonical Polar pattern: PATCH /v1/subscriptions/{id} with
 * `cancel_at_period_end: true`. The prior version POSTed to
 * `/subscriptions/{id}/cancel` which is not part of Polar's documented v1
 * surface — that 404'd, threw, and showed users the same opaque "Failed
 * to cancel subscription" we just fixed for plan changes.
 *
 * Customer keeps access until next_billing_date; on that date, Polar fires
 * subscription.canceled and our webhook handler flips the status. To
 * cancel immediately instead, use revokeSubscription (not implemented —
 * we always honor the paid period).
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
        await polarApi.patch(`/subscriptions/${org.polar_subscription_id}`, {
            cancel_at_period_end: true,
        });

        logger.info(`[POLAR] Canceled subscription for ${orgId}`, {
            subscriptionId: org.polar_subscription_id
        });
    } catch (error: any) {
        const detail = logPolarError('[POLAR] Failed to cancel subscription', error, {
            orgId,
            subscriptionId: org.polar_subscription_id,
        });
        throw new Error(detail);
    }
}

/**
 * Change subscription to a different tier (upgrade or downgrade).
 *
 * Polar's `PATCH /v1/subscriptions/{id}` uses Polar-specific vocabulary —
 * NOT Stripe's. The prior version sent `proration_behavior:
 * 'create_prorations'` which is a Stripe-only value Polar rejects with
 * 422, and the resulting error body never made it to Railway logs because
 * the catch only logged the wrapper Error.message ("Request failed with
 * status code 422") instead of the axios error.response.data with the
 * real "invalid value" detail. Customers saw a generic "Failed to change
 * plan" with no recoverable info.
 *
 * Polar's accepted values for proration_behavior:
 *   - 'invoice'  → charge the prorated diff immediately on a new invoice
 *   - 'prorate'  → apply the prorated diff to the next scheduled invoice
 *   - omit/null  → no proration (used for downgrades that take effect at
 *                  the end of the current billing period)
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

    // Build the request body. Both upgrades and downgrades take effect
    // immediately on Polar's side; the difference is only in how the
    // dollar diff lands:
    //   - upgrade   → 'invoice' — charge the prorated difference NOW on a
    //                 new invoice. Customer pays, gets new tier instantly.
    //   - downgrade → 'prorate' — apply the prorated credit to the NEXT
    //                 invoice. Customer keeps the rest of the higher-tier
    //                 features they already paid for (Polar bills the
    //                 lower amount minus credit at next renewal).
    // Sending no proration_behavior at all lets Polar pick a default which
    // varies by account settings — explicit is better.
    const body: Record<string, any> = {
        product_id: newProductId,
        proration_behavior: isUpgrade ? 'invoice' : 'prorate',
    };

    try {
        await polarApi.patch(`/subscriptions/${org.polar_subscription_id}`, body);

        // Don't pre-emptively flip the local tier here — the
        // subscription.updated webhook fires immediately after Polar
        // accepts the PATCH and our handler updates the org row from the
        // authoritative payload. Updating locally before the webhook
        // arrived caused a brief window where our DB and Polar disagreed,
        // and on rare Polar 5xx-after-2xx returns we'd be stuck out of
        // sync. The webhook is the source of truth.

        logger.info(`[POLAR] Subscription change accepted for ${orgId}: ${org.subscription_tier} → ${newTier}`, {
            subscriptionId: org.polar_subscription_id,
            direction: isUpgrade ? 'upgrade' : 'downgrade',
        });

        return { success: true, effective: 'immediate' };
    } catch (error: any) {
        const detail = logPolarError('[POLAR] Failed to change subscription', error, {
            orgId,
            subscriptionId: org.polar_subscription_id,
            newTier,
            requestBody: body,
        });
        throw new Error(detail);
    }
}

/**
 * Get subscription details from Polar.
 */
export async function getSubscription(subscriptionId: string): Promise<any> {
    try {
        const response = await polarApi.get(`/subscriptions/${subscriptionId}`);
        return response.data;
    } catch (error: any) {
        const detail = logPolarError('[POLAR] Failed to fetch subscription', error, { subscriptionId });
        throw new Error(detail);
    }
}

// ============================================================================
// VALIDATION
// ============================================================================

/**
 * Verify a Polar webhook signature using the Standard Webhooks format
 * (https://www.standardwebhooks.com/) that Polar adopted in 2024+.
 *
 * Polar sends three headers:
 *   webhook-id        — unique delivery identifier
 *   webhook-timestamp — unix seconds at delivery time
 *   webhook-signature — space-separated list, each entry "v1,<base64-hmac>"
 *                       (multiple sigs let Polar rotate keys without an
 *                       atomic cutover; verify if ANY entry matches)
 *
 * The signed payload is `${id}.${timestamp}.${rawBody}`. The secret is the
 * raw value Polar showed at endpoint setup (sometimes prefixed `whsec_`,
 * sometimes base64). We accept both, normalize, then HMAC-SHA256.
 *
 * Returns true on first matching signature, false otherwise. Never throws
 * (constant-time check uses fixed-length buffers; bad input → false rather
 * than crashing the request, which previously got swallowed by an outer
 * try/catch that returned 200 — the bug that left customers stuck on trial).
 */
export function verifyPolarWebhook(
    rawBody: Buffer | string,
    headers: Record<string, string | string[] | undefined>,
    secret: string
): boolean {
    if (!rawBody || !secret) return false;

    const get = (name: string): string | null => {
        const raw = headers[name] ?? headers[name.toLowerCase()];
        if (!raw) return null;
        return Array.isArray(raw) ? raw[0] : String(raw);
    };

    const webhookId = get('webhook-id');
    const webhookTs = get('webhook-timestamp');
    const sigHeader = get('webhook-signature');
    if (!webhookId || !webhookTs || !sigHeader) return false;

    // Reject deliveries older than 5 minutes — protects against replay if
    // the secret leaks. Polar's own client uses the same window.
    const tsSec = parseInt(webhookTs, 10);
    if (!Number.isFinite(tsSec) || Math.abs(Date.now() / 1000 - tsSec) > 300) {
        logger.warn('[POLAR] Webhook rejected — timestamp outside 5-min window', { webhookTs });
        return false;
    }

    // Normalize the secret. Polar's dashboard surfaces the secret as
    // `whsec_<base64>`. Older endpoints may have raw base64 or raw bytes.
    const secretBytes = secret.startsWith('whsec_')
        ? Buffer.from(secret.slice('whsec_'.length), 'base64')
        : (() => {
            // Heuristic: treat as base64 if it looks base64-ish (length % 4 = 0
            // and only base64 chars). Fallback to raw bytes.
            const trimmed = secret.trim();
            const looksBase64 = /^[A-Za-z0-9+/=]+$/.test(trimmed) && trimmed.length % 4 === 0;
            return looksBase64 ? Buffer.from(trimmed, 'base64') : Buffer.from(trimmed, 'utf8');
        })();

    const bodyStr = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody;
    const signedPayload = `${webhookId}.${webhookTs}.${bodyStr}`;
    const expected = require('crypto')
        .createHmac('sha256', secretBytes)
        .update(signedPayload, 'utf8')
        .digest('base64');

    // Header looks like "v1,abc... v1,def..." — possibly multiple. Try each.
    for (const part of sigHeader.split(/\s+/)) {
        const idx = part.indexOf(',');
        if (idx < 0) continue;
        const version = part.slice(0, idx);
        const sig = part.slice(idx + 1);
        if (version !== 'v1') continue;
        try {
            const a = Buffer.from(sig, 'base64');
            const b = Buffer.from(expected, 'base64');
            if (a.length !== b.length) continue;
            if (require('crypto').timingSafeEqual(a, b)) return true;
        } catch {
            continue;
        }
    }
    return false;
}

/**
 * @deprecated Kept for callers that haven't migrated yet. Always returns
 * false in production — forces an explicit migration to verifyPolarWebhook.
 */
export function validateWebhookSignature(
    _payload: string,
    _signature: string,
    _secret: string
): boolean {
    logger.error('[POLAR] validateWebhookSignature is deprecated — use verifyPolarWebhook with rawBody + headers');
    return false;
}
