/**
 * Lead Scoring Routes
 */

import { Router } from 'express';
import * as leadScoringController from '../controllers/leadScoringController';

const router = Router();

// Manually trigger lead score sync
router.post('/scoring/sync', leadScoringController.syncLeadScores);

// Get top leads across all campaigns
router.get('/top', leadScoringController.getTopLeads);

// Get score breakdown for a specific lead
router.get('/:leadId/score-breakdown', leadScoringController.getLeadScoreBreakdown);

export default router;
