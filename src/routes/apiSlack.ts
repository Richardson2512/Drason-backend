import { Router } from 'express';
import * as slackController from '../controllers/slackController';
import { asyncHandler } from '../middleware/asyncHandler';

const router = Router();

// Get the list of channels the bot is a member of (for UI dropdown)
router.get('/channels', asyncHandler(slackController.getSlackChannels));

// Save the selected channel (posts a validation message first)
router.post('/channel', asyncHandler(slackController.saveSlackChannel));

export default router;
