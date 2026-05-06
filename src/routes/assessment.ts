/**
 * Assessment Routes
 * 
 * Routes for infrastructure health assessment API.
 * DNS-based recovery requires manual re-assessment trigger via POST /run.
 */

import { Router } from 'express';
import * as assessmentController from '../controllers/assessmentController';
import { requireCapability } from '../middleware/requireCapability';

const router = Router();

// Get latest infrastructure report
router.get('/report', assessmentController.getReport);

// Get infrastructure reports over a window for score-history chart
router.get('/reports', assessmentController.getReports);

// Trigger manual re-assessment (required for DNS recovery verification)
router.post('/run', requireCapability('run_assessment'), assessmentController.runAssessment);

// Check if assessment is currently in progress
router.get('/status', assessmentController.getAssessmentStatus);

// Get live DNS details for a specific domain
router.get('/domain/:domainId/dns', assessmentController.getDomainDNS);

// Manual re-check that PERSISTS the result. Drives the "Check now" button on
// the Domains DNS Authentication card. Soft-cooldown at 30s.
router.post('/domain/:domainId/dns/recheck', requireCapability('run_assessment'), assessmentController.recheckDomainDNS);

export default router;
