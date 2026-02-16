/**
 * Billing Routes
 *
 * Routes for subscription management, checkout, and Polar webhooks.
 * Note: Authentication is handled by extractOrgContext middleware applied to all /api routes.
 */

import { Router } from 'express';
import * as billingController from '../controllers/billingController';

const router = Router();

// ============================================================================
// PUBLIC ROUTES (No Auth Required)
// ============================================================================

/**
 * POST /api/billing/polar-webhook
 * Webhook endpoint for Polar events.
 * Must be public for Polar to send events.
 */
router.post('/polar-webhook', billingController.handlePolarWebhook);

// ============================================================================
// PROTECTED ROUTES (Auth via extractOrgContext middleware)
// ============================================================================

/**
 * GET /api/billing/subscription
 * Get current subscription status, usage, and limits.
 */
router.get('/subscription', billingController.getSubscriptionStatus);

/**
 * POST /api/billing/create-checkout
 * Create a Polar checkout session for upgrading.
 * Body: { tier: 'starter' | 'growth' | 'scale' }
 */
router.post('/create-checkout', billingController.createCheckout);

/**
 * POST /api/billing/cancel
 * Cancel current subscription.
 */
router.post('/cancel', billingController.cancelSubscription);

/**
 * POST /api/billing/refresh-usage
 * Manually refresh usage counts.
 */
router.post('/refresh-usage', billingController.refreshUsage);

export default router;
