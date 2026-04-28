import { Router } from 'express';
import * as leadController from '../controllers/leadController';
import * as leadScoringController from '../controllers/leadScoringController';
import { validateBody, ingestLeadSchema } from '../middleware/validation';

const router = Router();

// Lead ingestion — protection coverage is unlimited at every tier; metering
// happens on monthly send volume + validation credits, not per-lead.
router.post('/', validateBody(ingestLeadSchema), leadController.ingestLead);

// Lead scoring endpoints
router.post('/scoring/sync', leadScoringController.syncLeadScores);
router.get('/top', leadScoringController.getTopLeads);
router.get('/:leadId/score-breakdown', leadScoringController.getLeadScoreBreakdown);
router.get('/:leadId/campaigns', leadController.getLeadCampaigns);

export default router;
