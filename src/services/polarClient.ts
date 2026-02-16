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

export interface TierLimits {
    leads: number;
    domains: number;
    mailboxes: number;
}

export interface CheckoutSession {
    url: string;
    id: string;
}

// ============================================================================
// CONSTANTS
// ============================================================================

export const TIER_LIMITS: Record<string, TierLimits> = {
    trial: { leads: 10000, domains: 3, mailboxes: 15 },
    starter: { leads: 10000, domains: 3, mailboxes: 15 },
    growth: { leads: 50000, domains: 15, mailboxes: 75 },
    scale: { leads: 100000, domains: 30, mailboxes: 200 },
    enterprise: { leads: Infinity, domains: Infinity, mailboxes: Infinity }
};

const POLAR_API_BASE = 'https://api.polar.sh/v1';
const POLAR_ACCESS_TOKEN = process.env.POLAR_ACCESS_TOKEN;

const PRODUCT_IDS: Record<string, string> = {
    starter: process.env.POLAR_STARTER_PRODUCT_ID || '',
    growth: process.env.POLAR_GROWTH_PRODUCT_ID || '',
    scale: process.env.POLAR_SCALE_PRODUCT_ID || ''
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
    try {
        const response = await polarApi.post('/customers', {
            email: org.users[0]?.email || `${org.slug}@superkabe.com`,
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
    } catch (error) {
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
