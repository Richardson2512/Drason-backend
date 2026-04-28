/**
 * Healing Routes
 * 
 * Routes for the graduated healing system API.
 */

import { Router } from 'express';
import * as healingController from '../controllers/healingController';
import { validateBody, acknowledgeTransitionSchema } from '../middleware/validation';

const router = Router();

// Transition gate status (Phase 0 → Phase 1)
router.get('/transition-gate', healingController.getTransitionGate);

// Acknowledge low-score assessment to proceed
router.post('/acknowledge-transition', validateBody(acknowledgeTransitionSchema), healingController.acknowledgeTransition);

// Recovery status overview
router.get('/recovery-status', healingController.getRecoveryStatus);

// Clear manual-intervention flag (operator action — requires explanatory note)
router.post('/clear-manual-intervention', healingController.clearManualIntervention);

export default router;
