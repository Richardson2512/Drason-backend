import { Router } from 'express';
import * as smartleadWebhookController from '../controllers/smartleadWebhookController';

const router = Router();

/**
 * Smartlead webhook endpoint
 *
 * This endpoint receives real-time events from Smartlead including:
 * - Bounces (hard/soft)
 * - Email sent
 * - Email opened
 * - Email clicked
 * - Replies
 * - Unsubscribes
 * - Spam complaints
 *
 * Critical for maintaining accurate bounce rates and deliverability metrics.
 */
router.post('/smartlead-webhook', smartleadWebhookController.handleSmartleadWebhook);

export default router;
