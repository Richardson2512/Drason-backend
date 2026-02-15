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
            error: 'Failed to get campaign top leads',
            message: error.message
        });
    }
};
