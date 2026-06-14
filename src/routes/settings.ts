import { Router } from 'express';
import * as settingsController from '../controllers/settingsController';
import { validateBody, updateSettingsSchema } from '../middleware/validation';
import { requireAgencyOwner } from '../middleware/requireCapability';

const router = Router();

router.get('/', settingsController.getSettings);
// Org-level settings (system_mode, mailing_address, etc.) - agency owners only.
// These knobs affect every workspace under the account; clients should never
// be able to change them, regardless of their per-workspace capabilities.
router.post('/', requireAgencyOwner, validateBody(updateSettingsSchema), settingsController.updateSettings);
router.get('/clay-webhook-url', settingsController.getClayWebhookUrl);

export default router;
