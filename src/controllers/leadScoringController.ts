/**
 * Lead Scoring Controller
 *
 * API endpoints for lead scoring and top lead insights.
 */

import { Request, Response } from 'express';
import { getOrgId } from '../middleware/orgContext';
import * as leadScoringService from '../services/leadScoringService';
import * as leadScoringWorker from '../services/leadScoringWorker';
import { logger } from '../services/observabilityService';

/**
 * POST /api/leads/scoring/sync
 * Manually trigger lead score sync for the organization.
 */
export const syncLeadScores = async (req: Request, res: Response): Promise<void> => {
    try {
        const orgId = getOrgId(req);

        logger.info('[LEAD-SCORING] Manual sync triggered', { orgId });

        const result = await leadScoringWorker.triggerManualScoring(orgId);

        res.json({
            success: true,
            message: `Updated ${result.updated} lead scores`,
            data: {
                updated: result.updated,
                topLeads: result.topLeads.slice(0, 10) // Return top 10
            }
        });
    } catch (error: any) {
        logger.error('[LEAD-SCORING] Sync failed', error);
        res.status(500).json({
            success: false,
            error: 'Failed to sync lead scores',
            message: error.message
        });
    }
};

/**
 * GET /api/leads/top
 * Get top performing leads across all campaigns.
 */
export const getTopLeads = async (req: Request, res: Response): Promise<void> => {
    try {
        const orgId = getOrgId(req);
        const limit = parseInt(req.query.limit as string) || 20;

        const topLeads = await leadScoringService.getTopLeadsForCampaign('', limit);

        res.json({
            success: true,
            data: topLeads
        });
    } catch (error: any) {
        logger.error('[LEAD-SCORING] Failed to get top leads', error);
        res.status(500).json({
            success: false,
            error: 'Failed to get top leads',
            message: error.message
        });
    }
};

/**
 * GET /api/leads/:leadId/score-breakdown
 * Get detailed score breakdown for a specific lead.
 */
export const getLeadScoreBreakdown = async (req: Request, res: Response): Promise<void> => {
    try {
        const leadId = Array.isArray(req.params.leadId) ? req.params.leadId[0] : req.params.leadId;

        const breakdown = await leadScoringService.getLeadScoreBreakdown(leadId);

        if (!breakdown) {
            res.status(404).json({
                success: false,
                error: 'Lead not found or no engagement data'
            });
            return;
        }

        res.json({
            success: true,
            data: breakdown
        });
    } catch (error: any) {
        logger.error('[LEAD-SCORING] Failed to get score breakdown', error);
        res.status(500).json({
            success: false,
            error: 'Failed to get score breakdown',
            message: error.message
        });
    }
};

/**
 * GET /api/campaigns/:campaignId/top-leads
 * Get top performing leads for a specific campaign.
 */
export const getTopLeadsForCampaign = async (req: Request, res: Response): Promise<void> => {
    try {
        const campaignId = Array.isArray(req.params.campaignId) ? req.params.campaignId[0] : req.params.campaignId;
        const limit = parseInt(req.query.limit as string) || 10;

        const topLeads = await leadScoringService.getTopLeadsForCampaign(campaignId, limit);

        res.json({
            success: true,
            data: topLeads
        });
    } catch (error: any) {
        logger.error('[LEAD-SCORING] Failed to get campaign top leads', error);
        res.status(500).json({
            success: false,
            error: 'Failed to get campaign top leads',
            message: error.message
        });
    }
};

/**
 * GET /api/leads/scoring/config
 * Read the org's lead-scoring config (built-in weights + custom events).
 */
export const getScoringConfig = async (req: Request, res: Response): Promise<void> => {
    try {
        const orgId = getOrgId(req);
        const cfg = await leadScoringService.getScoringConfig(orgId);
        res.json({ success: true, data: cfg });
    } catch (error: any) {
        logger.error('[LEAD-SCORING] getScoringConfig failed', error);
        res.status(500).json({ success: false, error: 'Failed to load scoring config', message: error.message });
    }
};

/**
 * PUT /api/leads/scoring/config
 * Replace the org's lead-scoring config. Body: { weights, events }
 */
export const updateScoringConfig = async (req: Request, res: Response): Promise<void> => {
    try {
        const orgId = getOrgId(req);
        const { weights = {}, events = [] } = req.body || {};
        if (typeof weights !== 'object' || !Array.isArray(events)) {
            res.status(400).json({ success: false, error: 'weights must be object, events must be array' });
            return;
        }
        const saved = await leadScoringService.updateScoringConfig(orgId, weights, events);
        res.json({ success: true, data: saved });
    } catch (error: any) {
        logger.error('[LEAD-SCORING] updateScoringConfig failed', error);
        res.status(500).json({ success: false, error: 'Failed to save scoring config', message: error.message });
    }
};

/**
 * GET /api/leads/:leadId/score-events
 * List custom score events recorded for one lead (most recent first).
 */
export const listScoreEvents = async (req: Request, res: Response): Promise<void> => {
    try {
        const orgId = getOrgId(req);
        const leadId = String(req.params.leadId);
        const events = await leadScoringService.listLeadScoreEvents(orgId, leadId);
        res.json({ success: true, data: events });
    } catch (error: any) {
        logger.error('[LEAD-SCORING] listScoreEvents failed', error);
        res.status(500).json({ success: false, error: 'Failed to list score events', message: error.message });
    }
};

/**
 * POST /api/leads/:leadId/score-events
 * Record a custom score event. Body: { event_key, points?, label?, note? }
 *   - If event_key matches a configured custom event, points + label are
 *     pulled from config when omitted.
 *   - Pass explicit points/label for ad-hoc one-off adjustments.
 */
export const createScoreEvent = async (req: Request, res: Response): Promise<void> => {
    try {
        const orgId = getOrgId(req);
        const userId = (req as any).user?.id || (req as any).userId || null;
        const leadId = String(req.params.leadId);
        const { event_key, points, label, note } = req.body || {};
        if (!event_key || typeof event_key !== 'string') {
            res.status(400).json({ success: false, error: 'event_key required' });
            return;
        }
        const result = await leadScoringService.recordLeadScoreEvent({
            organizationId: orgId,
            leadId,
            eventKey: event_key,
            createdByUserId: userId,
            points: typeof points === 'number' ? points : undefined,
            label: typeof label === 'string' ? label : undefined,
            note: typeof note === 'string' ? note : undefined,
        });
        res.status(201).json({ success: true, data: result });
    } catch (error: any) {
        logger.error('[LEAD-SCORING] createScoreEvent failed', error);
        const status = /not found/i.test(error?.message || '') ? 404 : 400;
        res.status(status).json({ success: false, error: error.message || 'Failed to record event' });
    }
};

/**
 * DELETE /api/leads/:leadId/score-events/:eventId
 * Reverse a previously-recorded score event.
 */
export const deleteScoreEvent = async (req: Request, res: Response): Promise<void> => {
    try {
        const orgId = getOrgId(req);
        const leadId = String(req.params.leadId);
        const eventId = String(req.params.eventId);
        const result = await leadScoringService.deleteLeadScoreEvent(orgId, leadId, eventId);
        res.json({ success: true, data: result });
    } catch (error: any) {
        logger.error('[LEAD-SCORING] deleteScoreEvent failed', error);
        const status = /not found/i.test(error?.message || '') ? 404 : 500;
        res.status(status).json({ success: false, error: error.message || 'Failed to delete event' });
    }
};
