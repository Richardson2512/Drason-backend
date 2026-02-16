/**
 * Billing Controller
 *
 * HTTP handlers for billing-related endpoints:
 * - Polar webhook processing
 * - Checkout session creation
 * - Subscription management
 */

import { Request, Response } from 'express';
import { logger } from '../services/observabilityService';
import * as billingService from '../services/billingService';
import * as polarClient from '../services/polarClient';
import { getOrgId } from '../middleware/orgContext';

// ============================================================================
// WEBHOOK HANDLER
// ============================================================================

/**
 * Handle Polar webhook events.
 * Validates signature and processes events idempotently.
 */
export const handlePolarWebhook = async (req: Request, res: Response): Promise<Response> => {
    try {
        const signature = req.headers['x-polar-signature'] as string;
        const webhookSecret = process.env.POLAR_WEBHOOK_SECRET;

        if (!webhookSecret) {
            logger.error('[BILLING] Missing POLAR_WEBHOOK_SECRET environment variable');
            return res.status(500).json({ error: 'Webhook secret not configured' });
        }

        // Validate HMAC-SHA256 signature
        const payload = JSON.stringify(req.body);
        const isValid = polarClient.validateWebhookSignature(payload, signature, webhookSecret);

        if (!isValid) {
            logger.warn('[BILLING] Invalid webhook signature', {
                receivedSignature: signature
            });
            return res.status(401).json({ error: 'Invalid signature' });
        }

        // Process webhook event
        await billingService.processWebhook(req.body);

        // Always return 200 to prevent retry storms
        return res.json({ received: true });
    } catch (error) {
        logger.error('[BILLING] Webhook processing failed', error instanceof Error ? error : new Error(String(error)));
        // Still return 200 to prevent retries for non-retryable errors
        return res.status(200).json({ error: 'Processing failed', received: true });
    }
};

// ============================================================================
// CHECKOUT MANAGEMENT
// ============================================================================

/**
 * Create a Polar checkout session for upgrading.
 */
export const createCheckout = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const { tier } = req.body;

        if (!tier || !['starter', 'growth', 'scale'].includes(tier)) {
            return res.status(400).json({ error: 'Invalid tier. Must be one of: starter, growth, scale' });
        }

        // Check if already has active subscription
        const org = await billingService.getUsageAndLimits(orgId);
        if (org.tier !== 'trial' && org.tier !== 'free') {
            return res.status(400).json({ error: 'Already have an active subscription. Cancel first to change tiers.' });
        }

        // Create checkout session
        const checkoutSession = await polarClient.createCheckoutSession(orgId, tier);

        return res.json({
            checkoutUrl: checkoutSession.url,
            checkoutId: checkoutSession.id
        });
    } catch (error) {
        logger.error('[BILLING] Checkout creation failed', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ error: 'Failed to create checkout session' });
    }
};

// ============================================================================
// SUBSCRIPTION MANAGEMENT
// ============================================================================

/**
 * Get current subscription status and usage.
 */
export const getSubscriptionStatus = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);

        // Refresh usage counts
        await billingService.refreshUsageCounts(orgId);

        // Get current status
        const data = await billingService.getUsageAndLimits(orgId);

        // Get organization details
        const { prisma } = await import('../index');
        const org = await prisma.organization.findUnique({
            where: { id: orgId },
            select: {
                subscription_tier: true,
                subscription_status: true,
                trial_started_at: true,
                trial_ends_at: true,
                subscription_started_at: true,
                next_billing_date: true
            }
        });

        return res.json({
            subscription: {
                tier: org?.subscription_tier,
                status: org?.subscription_status,
                trialStartedAt: org?.trial_started_at,
                trialEndsAt: org?.trial_ends_at,
                subscriptionStartedAt: org?.subscription_started_at,
                nextBillingDate: org?.next_billing_date
            },
            usage: data.usage,
            limits: data.limits
        });
    } catch (error) {
        logger.error('[BILLING] Failed to get subscription status', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ error: 'Failed to get subscription status' });
    }
};

/**
 * Cancel current subscription.
 */
export const cancelSubscription = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);

        await polarClient.cancelSubscription(orgId);

        return res.json({ message: 'Subscription canceled. Access will continue until the end of your billing period.' });
    } catch (error) {
        logger.error('[BILLING] Failed to cancel subscription', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to cancel subscription' });
    }
};

// ============================================================================
// USAGE TRACKING
// ============================================================================

/**
 * Manually refresh usage counts.
 */
export const refreshUsage = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);

        const usage = await billingService.refreshUsageCounts(orgId);

        return res.json({ usage });
    } catch (error) {
        logger.error('[BILLING] Failed to refresh usage', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ error: 'Failed to refresh usage' });
    }
};
