import { Router } from 'express';
import * as trackingController from '../controllers/trackingController';

const router = Router();

// Health probe used by the custom-tracking-domain verifier. A user-supplied
// hostname (e.g. links.clientdomain.com) that has been CNAMEd to our edge
// will hit this when verifyAndPersistForAccount runs DNS + HTTP checks.
// The X-Superkabe-Tracking header confirms TLS termination + the proxy
// is actually pointing at OUR backend rather than someone else's app.
router.head('/__tracking_health', (_req, res) => {
    res.setHeader('X-Superkabe-Tracking', 'ok');
    res.status(200).end();
});
router.get('/__tracking_health', (_req, res) => {
    res.setHeader('X-Superkabe-Tracking', 'ok');
    res.status(200).json({ ok: true });
});

router.get('/o/:id', trackingController.trackOpen);
router.get('/c/:id', trackingController.trackClick);
router.get('/u/:id', trackingController.unsubscribe);
router.post('/u/:id', trackingController.processUnsubscribe);

export default router;
