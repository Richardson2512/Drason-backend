import { Router } from 'express';
import * as findingsController from '../controllers/findingsController';

const router = Router();

/**
 * GET /api/findings/entity
 * Get findings for a specific entity (mailbox, domain, campaign)
 * Query params: entity_type, entity_id
 */
router.get('/entity', findingsController.getEntityFindings);

/**
 * GET /api/findings
 * Get all findings for the organization
 */
router.get('/', findingsController.getAllFindings);

export default router;
