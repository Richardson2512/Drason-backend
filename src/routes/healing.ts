/**
 * Healing Routes
 * 
 * Routes for the graduated healing system API.
 */

import { Router } from 'express';
import * as healingController from '../controllers/healingController';
import { validateBody, acknowledgeTransitionSchema } from '../middleware/validation';
import { requireAgencyOwner } from '../middleware/requireCapability';
import { protectionConfigRateLimit } from '../middleware/rateLimitPerOrg';

const router = Router();

// Transition gate status (Phase 0 → Phase 1) - read
router.get('/transition-gate', healingController.getTransitionGate);

// Acknowledge low-score assessment to proceed - operator override of the
// healing gate; agency-owner only. Clients shouldn't be able to bypass
// the assessment that protects their own deliverability.
// Rate-limited via protectionConfigRateLimit (3/min/org) for Super Protect
// R2-SP3 - operator overrides of protection gates should be rare; >3/min
// is a script or a compromised credential, not a person. Same preset the
// suppression-mode flip uses, applied for the same reason.
router.post('/acknowledge-transition', requireAgencyOwner, protectionConfigRateLimit, validateBody(acknowledgeTransitionSchema), healingController.acknowledgeTransition);

// Recovery status overview - read
router.get('/recovery-status', healingController.getRecoveryStatus);

// Clear manual-intervention flag (operator action - requires explanatory note)
// Agency-owner only - same reasoning as acknowledge-transition.
// Same rate limiter as /acknowledge-transition. R2-SP3.
router.post('/clear-manual-intervention', requireAgencyOwner, protectionConfigRateLimit, healingController.clearManualIntervention);

export default router;
