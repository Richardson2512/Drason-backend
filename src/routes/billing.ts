/**
 * Billing Routes
 *
 * Routes for subscription management, checkout, and Polar webhooks.
 */

import { Router } from 'express';
import * as billingController from '../controllers/billingController';
import { requireAuth } from '../middleware/auth';

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
// PROTECTED ROUTES (Auth Required)
// ============================================================================

/**
 * GET /api/billing/subscription
 * Get current subscription status, usage, and limits.
 */
router.get('/subscription', requireAuth, billingController.getSubscriptionStatus);

/**
 * POST /api/billing/create-checkout
 * Create a Polar checkout session for upgrading.
 * Body: { tier: 'starter' | 'growth' | 'scale' }
 */
router.post('/create-checkout', requireAuth, billingController.createCheckout);

/**
 * POST /api/billing/cancel
 * Cancel current subscription.
 */
router.post('/cancel', requireAuth, billingController.cancelSubscription);

/**
 * POST /api/billing/refresh-usage
 * Manually refresh usage counts.
 */
router.post('/refresh-usage', requireAuth, billingController.refreshUsage);

export default router;
