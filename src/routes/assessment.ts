/**
 * Assessment Routes
 * 
 * Routes for infrastructure health assessment API.
 * DNS-based recovery requires manual re-assessment trigger via POST /run.
 */

import { Router } from 'express';
import * as assessmentController from '../controllers/assessmentController';
import { requireCapability } from '../middleware/requireCapability';
import { assessmentRateLimit } from '../middleware/rateLimitPerOrg';

const router = Router();

// Get latest infrastructure report
router.get('/report', assessmentController.getReport);

// Get infrastructure reports over a window for score-history chart
router.get('/reports', assessmentController.getReports);

// Trigger manual re-assessment (required for DNS recovery verification).
// Heavy DNS + DNSBL fanout - rate-limited per org so a retry-loop bug or
// a compromised account can't DOS the resolver pool. Super Protect R2-SP2.
router.post('/run', requireCapability('run_assessment'), assessmentRateLimit, assessmentController.runAssessment);

// Check if assessment is currently in progress
router.get('/status', assessmentController.getAssessmentStatus);

// Get live DNS details for a specific domain
router.get('/domain/:domainId/dns', assessmentController.getDomainDNS);

// Manual re-check that PERSISTS the result. Drives the "Check now" button on
// the Domains DNS Authentication card. Soft-cooldown at 30s.
// Same rate limit as /run - the persist path is just as expensive as the
// full assessment for the single domain it operates on. R2-SP2.
router.post('/domain/:domainId/dns/recheck', requireCapability('run_assessment'), assessmentRateLimit, assessmentController.recheckDomainDNS);

export default router;
