import { Router } from 'express';
import * as dashboardController from '../controllers/dashboardController';
import { validateBody, validateQuery, routingRuleSchema, campaignActionSchema, paginationSchema, auditLogQuerySchema } from '../middleware/validation';

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

// Phase 1 endpoints
router.get('/state-transitions', dashboardController.getStateTransitions);
router.get('/events', dashboardController.getRawEvents);

// Lead Health Gate endpoints
router.get('/lead-health-stats', dashboardController.getLeadHealthStats);

// Campaign Health endpoints
router.get('/campaign-health-stats', dashboardController.getCampaignHealthStats);
router.post('/campaign/pause', validateBody(campaignActionSchema), dashboardController.pauseCampaign);
router.post('/campaign/resume', validateBody(campaignActionSchema), dashboardController.resumeCampaign);

// Notification endpoints
import * as notificationController from '../controllers/notificationController';
router.get('/notifications', notificationController.getNotifications);
router.get('/notifications/unread-count', notificationController.getUnreadCount);
router.post('/notifications/:id/read', notificationController.markAsRead);
router.post('/notifications/read-all', notificationController.markAllAsRead);

export default router;
