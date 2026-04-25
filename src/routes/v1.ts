/**
 * Public API v1 Routes
 *
 * Versioned API for external integrations, MCP servers, and third-party tools.
 * Authenticated via API key (Authorization: Bearer sk_live_...) or OAuth token.
 * All responses follow { success, data?, error? } format.
 */

import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler';
import * as v1Controller from '../controllers/v1Controller';

const router = Router();

// ── Leads ───────────────────────────────────────────────────────────
router.post('/leads/bulk', asyncHandler(v1Controller.bulkImportLeads));
router.post('/leads/validate', asyncHandler(v1Controller.validateLeads));
router.get('/leads', asyncHandler(v1Controller.listLeads));
router.get('/leads/:id', asyncHandler(v1Controller.getLead));

// ── Campaigns ───────────────────────────────────────────────────────
router.post('/campaigns', asyncHandler(v1Controller.createCampaign));
router.get('/campaigns', asyncHandler(v1Controller.listCampaigns));
router.get('/campaigns/:id', asyncHandler(v1Controller.getCampaign));
router.patch('/campaigns/:id', asyncHandler(v1Controller.updateCampaign));
router.post('/campaigns/:id/launch', asyncHandler(v1Controller.launchCampaign));
router.post('/campaigns/:id/pause', asyncHandler(v1Controller.pauseCampaign));
router.get('/campaigns/:id/report', asyncHandler(v1Controller.getCampaignReport));
router.get('/campaigns/:id/replies', asyncHandler(v1Controller.getCampaignReplies));

// ── Replies ─────────────────────────────────────────────────────────
router.post('/replies', asyncHandler(v1Controller.sendReply));

// ── Validation ──────────────────────────────────────────────────────
router.get('/validation/results', asyncHandler(v1Controller.getValidationResults));

// ── Infrastructure ──────────────────────────────────────────────────
router.get('/mailboxes', asyncHandler(v1Controller.listMailboxes));
router.get('/domains', asyncHandler(v1Controller.listDomains));

// ── Account ─────────────────────────────────────────────────────────
router.get('/account', asyncHandler(v1Controller.getAccount));

export default router;
