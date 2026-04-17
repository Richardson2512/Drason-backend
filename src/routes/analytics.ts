import { Router } from 'express';
import * as analyticsController from '../controllers/analyticsController';

const router = Router();

/**
 * GET /api/analytics/bounces
 * Get detailed bounce analytics with lead-to-mailbox mapping
 * Query params: mailbox_id, campaign_id, bounce_type, start_date, end_date, limit
 */
router.get('/bounces', analyticsController.getBounceAnalytics);

/**
 * GET /api/analytics/daily
 * Get date-bucketed campaign analytics for trend visualization
 * Query params: campaign_id, start_date, end_date
 */
router.get('/daily', analyticsController.getDailyAnalytics);

/**
 * GET /api/analytics/esp-performance
 * Get per-mailbox ESP performance matrix (30-day rolling)
 */
router.get('/esp-performance', analyticsController.getEspPerformance);

export default router;
