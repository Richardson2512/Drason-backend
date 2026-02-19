import { Router } from 'express';
import * as authController from '../controllers/authController';
import * as googleAuthController from '../controllers/googleAuthController';
import { validateBody, loginSchema, registerSchema } from '../middleware/validation';

const router = Router();

// Traditional email/password authentication
router.post('/login', validateBody(loginSchema), authController.login);
router.post('/register', validateBody(registerSchema), authController.register);
router.post('/refresh', authController.refreshToken);
router.post('/logout', authController.logout);

// Google OAuth 2.0 authentication
router.get('/google', googleAuthController.initiateGoogleAuth);
router.get('/google/callback', googleAuthController.handleGoogleCallback);

export default router;
