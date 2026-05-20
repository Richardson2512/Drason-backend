/**
 * /api/webhooks - customer-facing webhook endpoint management.
 * Org-scoped via the global orgContext middleware. Subscription status is
 * checked inside createEndpoint so we don't block reads behind feature gate.
 */

import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler';
import * as wh from '../controllers/webhookController';
// Per-org rate-limit on the write paths that mutate webhook endpoints
// or trigger fan-out. Reads (list / get / deliveries) are intentionally
// NOT throttled here - they go through the global /api `general` tier.
// Notifications audit N3 root-cause fix.
import { webhookOpsRateLimit, webhookTestRateLimit } from '../middleware/rateLimitPerOrg';

const router = Router();

router.get('/events', asyncHandler(wh.listEvents));

router.get('/', asyncHandler(wh.listEndpoints));
router.post('/', webhookOpsRateLimit, asyncHandler(wh.createEndpoint));
router.get('/:id', asyncHandler(wh.getEndpoint));
router.patch('/:id', webhookOpsRateLimit, asyncHandler(wh.updateEndpoint));
router.delete('/:id', webhookOpsRateLimit, asyncHandler(wh.deleteEndpoint));

router.post('/:id/rotate', webhookOpsRateLimit, asyncHandler(wh.rotateSecret));
router.post('/:id/reactivate', webhookOpsRateLimit, asyncHandler(wh.reactivateEndpoint));
// Test endpoint gets the tighter bucket because every call fans out a
// real event to every active webhook in the org.
router.post('/:id/test', webhookTestRateLimit, asyncHandler(wh.testEndpoint));

router.get('/:id/deliveries', asyncHandler(wh.listDeliveries));
router.get('/:id/deliveries/:deliveryId', asyncHandler(wh.getDelivery));
router.post('/:id/deliveries/:deliveryId/replay', webhookOpsRateLimit, asyncHandler(wh.replay));

export default router;
