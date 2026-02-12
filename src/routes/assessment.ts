/**
 * Assessment Routes
 * 
 * Routes for infrastructure health assessment API.
 * DNS-based recovery requires manual re-assessment trigger via POST /run.
 */

import { Router } from 'express';
import * as assessmentController from '../controllers/assessmentController';

const router = Router();

// Get latest infrastructure report
router.get('/report', assessmentController.getReport);

// Get all reports (up to 10 most recent)
router.get('/reports', assessmentController.getReports);

// Trigger manual re-assessment (required for DNS recovery verification)
router.post('/run', assessmentController.runAssessment);

// Get live DNS details for a specific domain
router.get('/domain/:domainId/dns', assessmentController.getDomainDNS);

export default router;
