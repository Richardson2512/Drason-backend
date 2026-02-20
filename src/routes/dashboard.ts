import { Router } from 'express';
import * as dashboardController from '../controllers/dashboardController';
import * as campaignController from '../controllers/campaignController';
import { validateBody, validateQuery, routingRuleSchema, campaignActionSchema, paginationSchema, auditLogQuerySchema } from '../middleware/validation';
import { requireRole } from '../middleware/security';
import { UserRole } from '../types';

const router = Router();

// GET routes with pagination validation
router.get('/leads', validateQuery(paginationSchema), dashboardController.getLeads);
router.get('/campaigns', validateQuery(paginationSchema), dashboardController.getCampaigns);
router.get('/stats', dashboardController.getStats);
router.get('/domains', validateQuery(paginationSchema), dashboardController.getDomains);
router.get('/mailboxes', validateQuery(paginationSchema), dashboardController.getMailboxes);
router.get('/audit-logs', validateQuery(auditLogQuerySchema), dashboardController.getAuditLogs);
router.get('/routing-rules', dashboardController.getRoutingRules);
router.post('/routing-rules', validateBody(routingRuleSchema), dashboardController.createRoutingRule);

// Phase 1 endpoints - ADMIN ONLY (used by System Status page)
router.get('/state-transitions', requireRole(UserRole.ADMIN), dashboardController.getStateTransitions);
router.get('/events', requireRole(UserRole.ADMIN), dashboardController.getRawEvents);

// Lead Health Gate endpoints
router.get('/lead-health-stats', dashboardController.getLeadHealthStats);

// Campaign Health endpoints
// Removed: /campaign-health-stats - Duplicate of /campaigns endpoint (use that instead)
router.post('/campaign/pause', validateBody(campaignActionSchema), dashboardController.pauseCampaign);
router.post('/campaign/resume', validateBody(campaignActionSchema), dashboardController.resumeCampaign);
router.post('/campaigns/pause-all', campaignController.pauseAllCampaigns);

// Lead scoring endpoints
import * as leadScoringController from '../controllers/leadScoringController';
router.get('/campaigns/:campaignId/top-leads', leadScoringController.getTopLeadsForCampaign);

// Mailbox enrichment endpoints
import * as mailboxEnrichmentController from '../controllers/mailboxEnrichmentController';
router.post('/mailboxes/backfill-stats', mailboxEnrichmentController.backfillMailboxStats);
router.post('/mailboxes/:mailboxId/backfill-stats', mailboxEnrichmentController.backfillSingleMailbox);

// Notification endpoints
import * as notificationController from '../controllers/notificationController';
router.get('/notifications', notificationController.getNotifications);
router.get('/notifications/unread-count', notificationController.getUnreadCount);
router.post('/notifications/:id/read', notificationController.markAsRead);
router.post('/notifications/read-all', notificationController.markAllAsRead);

// Warmup recovery endpoints
router.get('/warmup-status', dashboardController.getWarmupStatus);
router.post('/warmup/check', dashboardController.checkWarmupProgress);

export default router;
