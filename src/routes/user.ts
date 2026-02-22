/**
 * User Routes
 *
 * Routes for user-related operations.
 */

import { Router } from 'express';
import * as userController from '../controllers/userController';
import * as settingsController from '../controllers/settingsController';
import { validateBody, updateUserSchema, changePasswordSchema } from '../middleware/validation';
import { asyncHandler } from '../middleware/asyncHandler';

const router = Router();

/**
 * GET /api/user/me
 * Get current authenticated user's information.
 */
router.get('/me', userController.getCurrentUser);
router.patch('/me', validateBody(updateUserSchema), userController.updateCurrentUser);
router.post('/change-password', validateBody(changePasswordSchema), userController.changePassword);

router.post('/settings/slack/disconnect', asyncHandler(settingsController.disconnectSlack));

export default router;
