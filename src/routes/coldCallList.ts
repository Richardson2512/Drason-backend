/**
 * Cold Call List routes.
 *
 * Mounted at /api/cold-call-list. Auth/org-context middleware is applied
 * globally in index.ts (extractOrgContext + requireOrgContext), same as
 * every other authenticated route file.
 */

import { Router } from 'express';
import * as controller from '../controllers/coldCallListController';

const router = Router();

router.get('/settings', controller.getSettings);
router.patch('/settings', controller.updateSettings);

router.get('/active-campaigns', controller.listActiveCampaigns);

router.get('/system', controller.getSystemList);
router.get('/system/csv', controller.downloadSystemListCsv);

router.post('/custom/generate', controller.generateCustomList);
router.post('/custom/csv', controller.downloadCustomListCsv);

// Manual trigger — useful for staging seeding. Same org-scoped middleware.
router.post('/system/trigger', controller.triggerDailyForOrg);

export default router;
