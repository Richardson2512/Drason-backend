import { Router } from 'express';
import * as leadController from '../controllers/leadController';
import * as leadScoringController from '../controllers/leadScoringController';
import { validateBody, ingestLeadSchema } from '../middleware/validation';
import { checkLeadCapacity } from '../middleware/featureGate';

const router = Router();

// Lead ingestion - with capacity check to enforce tier limits
router.post('/', checkLeadCapacity, validateBody(ingestLeadSchema), leadController.ingestLead);

// Lead scoring endpoints
router.post('/scoring/sync', leadScoringController.syncLeadScores);
router.get('/top', leadScoringController.getTopLeads);
router.get('/:leadId/score-breakdown', leadScoringController.getLeadScoreBreakdown);

export default router;
