/**
 * Super Admin Routes
 *
 * Cross-organization admin endpoints protected by super_admin role.
 */

import { Router } from 'express';
import * as adminController from '../controllers/adminController';
import { requireSuperAdmin } from '../middleware/orgContext';
import { asyncHandler } from '../middleware/asyncHandler';
import { exportRateLimit } from '../middleware/rateLimitPerOrg';

const router = Router();

// All routes require super_admin role
router.use(requireSuperAdmin);

router.get('/organizations', asyncHandler(adminController.getOrganizations));
router.get('/organizations/:orgId/impact', asyncHandler(adminController.getOrgImpactReport));
// exportRateLimit is per-admin-org (req.orgContext.organizationId), so a
// super_admin running a support session is throttled to 5 CSVs/min total
// across all targets - tight enough to catch a fat-fingered loop, loose
// enough that legitimate support work works. Reports audit R4.
router.get('/organizations/:orgId/impact/csv', exportRateLimit, asyncHandler(adminController.getOrgImpactCsv));

export default router;
