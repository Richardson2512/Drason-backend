/**
 * User Routes
 *
 * Routes for user-related operations.
 */

import { Router } from 'express';
import * as userController from '../controllers/userController';
import { validateBody, updateUserSchema, changePasswordSchema } from '../middleware/validation';

const router = Router();

/**
 * GET /api/user/me
 * Get current authenticated user's information.
 */
router.get('/me', userController.getCurrentUser);
router.patch('/me', validateBody(updateUserSchema), userController.updateCurrentUser);
router.post('/change-password', validateBody(changePasswordSchema), userController.changePassword);

export default router;
