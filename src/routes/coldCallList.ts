/**
 * Cold Call List routes.
 *
 * Mounted at /api/cold-call-list. Auth/org-context middleware is applied
 * globally in index.ts (extractOrgContext + requireOrgContext), same as
 * every other authenticated route file.
 */

import { Router } from 'express';
import * as controller from '../controllers/coldCallListController';
import { requireAgencyOwner } from '../middleware/requireCapability';

const router = Router();

router.get('/settings', controller.getSettings);
router.patch('/settings', controller.updateSettings);

router.get('/active-campaigns', controller.listActiveCampaigns);

router.get('/system', controller.getSystemList);
router.get('/system/csv', controller.downloadSystemListCsv);

router.post('/custom/generate', controller.generateCustomList);
router.post('/custom/csv', controller.downloadCustomListCsv);

// Manual trigger - ops/staging seeding only. Operator-gated: the spec
// forbids regular users regenerating the official daily list, and the
// controller comment used to CLAIM "admin-only" without enforcing it.
// requireAgencyOwner is the real control (scoped clients can't reach it
// even with '*' caps); generateDailySnapshot is idempotent as a backstop.
router.post('/system/trigger', requireAgencyOwner, controller.triggerDailyForOrg);

export default router;
