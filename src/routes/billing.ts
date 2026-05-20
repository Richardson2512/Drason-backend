/**
 * Billing Routes
 *
 * Routes for subscription management, checkout, and Polar webhooks.
 * Note: Authentication is handled by extractOrgContext middleware applied to all /api routes.
 */

import { Router } from 'express';
import * as billingController from '../controllers/billingController';
import { validateBody, createCheckoutSchema, changePlanSchema, cancelSubscriptionSchema } from '../middleware/validation';
// Per-org rate-limit on the write paths that either hit Polar or run
// expensive count() queries. Reads (status / tiers / invoices) intentionally
// fall through to the global /api `general` tier. Billing audit B2.
import { billingOpsRateLimit } from '../middleware/rateLimitPerOrg';

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

router.post('/create-checkout', billingOpsRateLimit, validateBody(createCheckoutSchema), billingController.createCheckout);

/**
 * POST /api/billing/change-plan
 * Change subscription plan (upgrade or downgrade).
 * Requires active subscription. Downgrades may return warnings requiring confirmation.
 */
router.post('/change-plan', billingOpsRateLimit, validateBody(changePlanSchema), billingController.changePlan);

/**
 * POST /api/billing/cancel
 * Cancel current subscription. Requires explicit data-retention consent
 * (GDPR/DPDP) - body must include `data_retention: 'keep' | 'delete'`.
 */
router.post('/cancel', billingOpsRateLimit, validateBody(cancelSubscriptionSchema), billingController.cancelSubscription);

/**
 * POST /api/billing/refresh-usage
 * Manually refresh usage counts.
 */
router.post('/refresh-usage', billingOpsRateLimit, billingController.refreshUsage);

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
