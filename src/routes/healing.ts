/**
 * Healing Routes
 * 
 * Routes for the graduated healing system API.
 */

import { Router } from 'express';
import * as healingController from '../controllers/healingController';
import { validateBody, acknowledgeTransitionSchema } from '../middleware/validation';
import { requireAgencyOwner } from '../middleware/requireCapability';

const router = Router();

// Transition gate status (Phase 0 → Phase 1) — read
router.get('/transition-gate', healingController.getTransitionGate);

// Acknowledge low-score assessment to proceed — operator override of the
// healing gate; agency-owner only. Clients shouldn't be able to bypass
// the assessment that protects their own deliverability.
router.post('/acknowledge-transition', requireAgencyOwner, validateBody(acknowledgeTransitionSchema), healingController.acknowledgeTransition);

// Recovery status overview — read
router.get('/recovery-status', healingController.getRecoveryStatus);

// Clear manual-intervention flag (operator action — requires explanatory note)
// Agency-owner only — same reasoning as acknowledge-transition.
router.post('/clear-manual-intervention', requireAgencyOwner, healingController.clearManualIntervention);

export default router;
