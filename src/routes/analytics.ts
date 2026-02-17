import { Router } from 'express';
import * as analyticsController from '../controllers/analyticsController';

const router = Router();

/**
 * GET /api/analytics/bounces
 * Get detailed bounce analytics with lead-to-mailbox mapping
 * Query params: mailbox_id, campaign_id, bounce_type, start_date, end_date, limit
 */
router.get('/bounces', analyticsController.getBounceAnalytics);

export default router;
