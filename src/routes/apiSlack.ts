import { Router } from 'express';
import * as slackController from '../controllers/slackController';
import { asyncHandler } from '../middleware/asyncHandler';

const router = Router();

// Initiate Slack OAuth install flow - redirects to Slack's authorize page
router.get('/install', asyncHandler(slackController.initiateInstall));

// Get the list of channels the bot is a member of (for UI dropdown)
router.get('/channels', asyncHandler(slackController.getSlackChannels));

// Save the selected channel (posts a validation message first)
router.post('/channel', asyncHandler(slackController.saveSlackChannel));

// Notification preferences + history
router.get('/notifications/catalog',      asyncHandler(slackController.getNotificationCatalog));
router.put('/notifications/preferences',  asyncHandler(slackController.updateNotificationPreferences));
router.get('/notifications/history',      asyncHandler(slackController.getNotificationHistory));

export default router;
