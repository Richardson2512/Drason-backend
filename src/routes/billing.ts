/**
 * Billing Routes
 *
 * Routes for subscription management, checkout, and Polar webhooks.
 * Note: Authentication is handled by extractOrgContext middleware applied to all /api routes.
 */

import { Router } from 'express';
import * as billingController from '../controllers/billingController';
import { validateBody, createCheckoutSchema, changePlanSchema } from '../middleware/validation';

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
 * GET /api/billing/tiers
 * Full tier catalog with limits, pricing, and metadata.
 */
router.get('/tiers', billingController.getTiers);

router.post('/create-checkout', validateBody(createCheckoutSchema), billingController.createCheckout);

/**
 * POST /api/billing/change-plan
 * Change subscription plan (upgrade or downgrade).
 * Requires active subscription. Downgrades may return warnings requiring confirmation.
 */
router.post('/change-plan', validateBody(changePlanSchema), billingController.changePlan);

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

/**
 * GET /api/billing/invoices
 * Get invoice/payment history.
 */
router.get('/invoices', billingController.getInvoices);

/**
 * GET /api/billing/invoices/:id/pdf
 * Download invoice as PDF.
 */
router.get('/invoices/:id/pdf', billingController.downloadInvoicePdf);

export default router;
