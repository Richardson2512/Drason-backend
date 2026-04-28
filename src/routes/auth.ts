import { Router } from 'express';
import * as authController from '../controllers/authController';
import * as googleAuthController from '../controllers/googleAuthController';
import { validateBody, loginSchema, registerSchema } from '../middleware/validation';

const router = Router();

// Public — current Terms / Privacy version identifiers (no auth required)
router.get('/legal-versions', authController.getLegalVersions);

// Authenticated — resolves the requireFreshConsent 412 by recording one or two
// new Consent rows for the current ToS / Privacy versions.
router.post('/accept-current-terms', authController.acceptCurrentTerms);

// Traditional email/password authentication
router.post('/login', validateBody(loginSchema), authController.login);
router.post('/register', validateBody(registerSchema), authController.register);
router.post('/refresh', authController.refreshToken);
router.post('/logout', authController.logout);

// Google OAuth 2.0 authentication
router.get('/google', googleAuthController.initiateGoogleAuth);
router.get('/google/callback', googleAuthController.handleGoogleCallback);

// Google OAuth onboarding (personal Gmail users — org name collection)
router.post('/onboarding/complete', googleAuthController.completeOnboarding);

export default router;
