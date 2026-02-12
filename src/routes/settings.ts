import { Router } from 'express';
import * as settingsController from '../controllers/settingsController';
import { validateBody, updateSettingsSchema } from '../middleware/validation';

const router = Router();

router.get('/', settingsController.getSettings);
router.post('/', validateBody(updateSettingsSchema), settingsController.updateSettings);
router.get('/clay-webhook-url', settingsController.getClayWebhookUrl);

export default router;
