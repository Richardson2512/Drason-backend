import { Router } from 'express';
import * as leadController from '../controllers/leadController';
import * as leadScoringController from '../controllers/leadScoringController';
import { validateBody, ingestLeadSchema } from '../middleware/validation';
import { requireCapability } from '../middleware/requireCapability';

const router = Router();

// Lead ingestion — protection coverage is unlimited at every tier; metering
// happens on monthly send volume + validation credits, not per-lead.
router.post('/', requireCapability('add_leads'), validateBody(ingestLeadSchema), leadController.ingestLead);

// Lead scoring endpoints
router.post('/scoring/sync', requireCapability('edit_sequences'), leadScoringController.syncLeadScores);
router.get('/scoring/config', leadScoringController.getScoringConfig);
router.put('/scoring/config', requireCapability('edit_sequences'), leadScoringController.updateScoringConfig);
router.get('/top', leadScoringController.getTopLeads);
router.get('/:leadId/score-breakdown', leadScoringController.getLeadScoreBreakdown);
router.get('/:leadId/score-events', leadScoringController.listScoreEvents);
router.post('/:leadId/score-events', requireCapability('edit_sequences'), leadScoringController.createScoreEvent);
router.delete('/:leadId/score-events/:eventId', requireCapability('edit_sequences'), leadScoringController.deleteScoreEvent);
router.get('/:leadId/campaigns', leadController.getLeadCampaigns);

export default router;
