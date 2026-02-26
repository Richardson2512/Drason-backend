import { Router } from 'express';
import * as instantlyWebhookController from '../controllers/instantlyWebhookController';

const router = Router();

/**
 * Instantly webhook endpoint
 *
 * Configure this URL in Instantly → Settings → Integrations → Webhooks.
 * Full URL: {BACKEND_URL}/api/monitor/instantly-webhook
 */
router.post('/instantly-webhook', instantlyWebhookController.handleInstantlyWebhook);

export default router;
