/**
 * AI routes — business profile + copy generation.
 *
 * Mounted at /api/ai. All routes are org-scoped via orgContext middleware
 * (already applied at the /api root in index.ts).
 */

import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler';
import * as profile from '../controllers/aiProfileController';
import * as gen from '../controllers/aiGenerateController';

const router = Router();

// Profile management (one per org)
router.get('/status', asyncHandler(profile.getStatus));
router.get('/profile', asyncHandler(profile.getProfile));
router.post('/profile', asyncHandler(profile.createProfile));
router.post('/profile/refresh', asyncHandler(profile.refreshProfile));
router.delete('/profile', asyncHandler(profile.deleteProfile));

// Copy generation
router.post('/generate-step', asyncHandler(gen.generateStep));
router.post('/generate-sequence', asyncHandler(gen.generateSequence));

export default router;
