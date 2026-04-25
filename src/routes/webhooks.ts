/**
 * /api/webhooks — customer-facing webhook endpoint management.
 * Org-scoped via the global orgContext middleware. Subscription status is
 * checked inside createEndpoint so we don't block reads behind feature gate.
 */

import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler';
import * as wh from '../controllers/webhookController';

const router = Router();

router.get('/events', asyncHandler(wh.listEvents));

router.get('/', asyncHandler(wh.listEndpoints));
router.post('/', asyncHandler(wh.createEndpoint));
router.get('/:id', asyncHandler(wh.getEndpoint));
router.patch('/:id', asyncHandler(wh.updateEndpoint));
router.delete('/:id', asyncHandler(wh.deleteEndpoint));

router.post('/:id/rotate', asyncHandler(wh.rotateSecret));
router.post('/:id/reactivate', asyncHandler(wh.reactivateEndpoint));
router.post('/:id/test', asyncHandler(wh.testEndpoint));

router.get('/:id/deliveries', asyncHandler(wh.listDeliveries));
router.get('/:id/deliveries/:deliveryId', asyncHandler(wh.getDelivery));
router.post('/:id/deliveries/:deliveryId/replay', asyncHandler(wh.replay));

export default router;
