import { Router } from 'express';
import * as slackController from '../controllers/slackController';
import { asyncHandler } from '../middleware/asyncHandler';

const router = Router();

// Slack Event Subscriptions Endpoint
router.post('/events', asyncHandler(slackController.handleEvents));

// Slack Slash Commands Endpoint
router.post('/command', asyncHandler(slackController.handleCommand));

export default router;
