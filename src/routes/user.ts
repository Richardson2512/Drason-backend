/**
 * User Routes
 *
 * Routes for user-related operations.
 */

import { Router } from 'express';
import * as userController from '../controllers/userController';

const router = Router();

/**
 * GET /api/user/me
 * Get current authenticated user's information.
 */
router.get('/me', userController.getCurrentUser);

export default router;
