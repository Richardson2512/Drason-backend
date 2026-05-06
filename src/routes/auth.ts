import { Router } from 'express';
import * as authController from '../controllers/authController';
import * as googleAuthController from '../controllers/googleAuthController';
import * as inviteController from '../controllers/inviteController';
import { validateBody, loginSchema, registerSchema, forgotPasswordSchema, resetPasswordSchema } from '../middleware/validation';

const router = Router();

// Public — current Terms / Privacy version identifiers (no auth required)
router.get('/legal-versions', authController.getLegalVersions);

// Authenticated — resolves the requireFreshConsent 412 by recording one or two
// new Consent rows for the current ToS / Privacy versions.
router.post('/accept-current-terms', authController.acceptCurrentTerms);

// Traditional email/password authentication
router.post('/login', validateBody(loginSchema), authController.login);
// Workspace-scoped client login (slug + email + password).
router.post('/login/client', authController.clientLogin);
router.post('/register', validateBody(registerSchema), authController.register);
router.post('/refresh', authController.refreshToken);
router.post('/logout', authController.logout);

// Password reset (public — no auth required)
router.post('/forgot-password', validateBody(forgotPasswordSchema), authController.forgotPassword);
router.get('/reset-password/verify', authController.verifyResetToken);
router.post('/reset-password', validateBody(resetPasswordSchema), authController.resetPassword);

// Google OAuth 2.0 authentication
router.get('/google', googleAuthController.initiateGoogleAuth);
router.get('/google/callback', googleAuthController.handleGoogleCallback);

// Google OAuth onboarding (personal Gmail users — org name collection)
router.post('/onboarding/complete', googleAuthController.completeOnboarding);

// Workspace invite magic-link flow (public — no auth required).
// 1. Validate token (used by /set-password to render the form).
router.get('/invite', inviteController.validateInviteToken);
// 2. Complete the invite (set password, create user + membership).
router.post('/invite/complete', inviteController.completeInvite);

export default router;
