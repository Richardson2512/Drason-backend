import { Router } from 'express';
import * as slackController from '../controllers/slackController';
import { asyncHandler } from '../middleware/asyncHandler';
import { requireCapability } from '../middleware/requireCapability';

const router = Router();

// Mutations are gated by `access_integrations` (consistent with JustCall /
// Zapmail / CRM connect) so a low-capability workspace member can't install,
// rewire the alert channel, or change notification prefs on the agency's
// tenant. Reads (channels list, catalog, history) stay open so the UI card
// renders without elevation.

// Initiate Slack OAuth install flow - redirects to Slack's authorize page
router.get('/install', requireCapability('access_integrations'), asyncHandler(slackController.initiateInstall));

// Get the list of channels the bot is a member of (for UI dropdown)
router.get('/channels', asyncHandler(slackController.getSlackChannels));

// Save the selected channel (posts a validation message first)
router.post('/channel', requireCapability('access_integrations'), asyncHandler(slackController.saveSlackChannel));

// Notification preferences + history
router.get('/notifications/catalog',      asyncHandler(slackController.getNotificationCatalog));
router.put('/notifications/preferences',  requireCapability('access_integrations'), asyncHandler(slackController.updateNotificationPreferences));
router.get('/notifications/history',      asyncHandler(slackController.getNotificationHistory));

export default router;
