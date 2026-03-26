/**
 * Super Admin Routes
 *
 * Cross-organization admin endpoints protected by super_admin role.
 */

import { Router } from 'express';
import * as adminController from '../controllers/adminController';
import { requireSuperAdmin } from '../middleware/orgContext';
import { asyncHandler } from '../middleware/asyncHandler';

const router = Router();

// All routes require super_admin role
router.use(requireSuperAdmin);

router.get('/organizations', asyncHandler(adminController.getOrganizations));
router.get('/organizations/:orgId/impact', asyncHandler(adminController.getOrgImpactReport));
router.get('/organizations/:orgId/impact/csv', asyncHandler(adminController.getOrgImpactCsv));

export default router;
