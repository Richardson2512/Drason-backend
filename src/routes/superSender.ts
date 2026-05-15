import { Router, json } from 'express';
import * as superSenderController from '../controllers/superSenderController';
import { handleSesNotification } from '../controllers/sesNotificationController';

const router = Router();

// SES SNS notification webhook - public (no auth) by allowlist in
// orgContext + subscription-gate exemption in index.ts. Mounted before
// the auth-gated routes so the unauth path is unambiguous.
//
// SNS POSTs the envelope with Content-Type: text/plain, which the global
// express.json() (application/json only) skips - so req.body would be
// empty and signature validation impossible. A route-scoped parser with
// type:'*/*' forces JSON parsing for this endpoint only. The global
// parsers don't consume a text/plain stream, so this runs cleanly.
router.post(
    '/ses-notification',
    json({ type: () => true, limit: '256kb' }),
    handleSesNotification,
);

router.get('/', superSenderController.getSuperSenderOverview);
router.post('/checkout', superSenderController.createCheckout);
router.post('/:id/assign', superSenderController.assignIp);
router.post('/:id/unassign', superSenderController.unassign);
router.post('/:id/pause', superSenderController.pauseHandler);
router.post('/:id/resume', superSenderController.resumeHandler);
router.get('/:id/mailboxes', superSenderController.getMailboxRouting);

export default router;
