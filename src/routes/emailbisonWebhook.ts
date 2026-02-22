import { Router } from 'express';
import * as emailbisonWebhookController from '../controllers/emailbisonWebhookController';

const router = Router();

/**
 * EmailBison webhook endpoint
 *
 * This endpoint receives real-time events from EmailBison.
 */
router.post('/emailbison-webhook', emailbisonWebhookController.handleEmailBisonWebhook);

export default router;
