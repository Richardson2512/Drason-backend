import { Router } from 'express';
import * as superSenderController from '../controllers/superSenderController';
import { handleSesNotification } from '../controllers/sesNotificationController';

const router = Router();

// SES SNS notification webhook - public (no auth) by allowlist in
// orgContext + subscription-gate exemption in index.ts. Mounted before
// the auth-gated routes so the unauth path is unambiguous.
router.post('/ses-notification', handleSesNotification);

router.get('/', superSenderController.getSuperSenderOverview);
router.post('/checkout', superSenderController.createCheckout);
router.post('/:id/assign', superSenderController.assignIp);
router.post('/:id/unassign', superSenderController.unassign);
router.post('/:id/pause', superSenderController.pauseHandler);
router.post('/:id/resume', superSenderController.resumeHandler);
router.get('/:id/mailboxes', superSenderController.getMailboxRouting);

export default router;
