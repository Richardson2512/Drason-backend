/**
 * Lead Controller
 * 
 * Alternative lead ingestion endpoint.
 * Delegates to lead service for processing.
 */

import { Request, Response } from 'express';
import * as leadService from '../services/leadService';
import { getOrgId } from '../middleware/orgContext';
import { logger } from '../services/observabilityService';
import { prisma } from '../index';
import { getLeadCampaigns as fetchSmartleadLeadCampaigns } from '../services/smartleadClient';

export const ingestLead = async (req: Request, res: Response): Promise<void> => {
    try {
        const { email, persona, lead_score, workable } = req.body;
        const orgId = getOrgId(req);

        // 1. Validate Payload
        if (!email || !persona || lead_score === undefined || workable !== true) {
            res.status(400).json({ error: 'Invalid payload: Missing required fields or not workable' });
            return;
        }

        // 2. Create Lead (Held)
        const lead = await leadService.createLead(orgId, {
            email,
            persona,
            lead_score,
        });

        // 3. Increment usage count for billing/capacity tracking
        await prisma.organization.update({
            where: { id: orgId },
            data: { current_lead_count: { increment: 1 } }
        });

        res.status(201).json({ success: true, data: { message: 'Lead ingested successfully', lead } });
    } catch (error) {
        logger.error('Error ingesting lead:', error as Error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
};

/**
 * Get all campaigns a lead is enrolled in.
 * Combines local DB data with Smartlead API for comprehensive cross-campaign view.
 */
export const getLeadCampaigns = async (req: Request, res: Response): Promise<void> => {
    try {
        const orgId = getOrgId(req);
        const leadId = req.params.leadId as string;

        const lead = await prisma.lead.findFirst({
            where: { id: leadId, organization_id: orgId },
            select: {
                id: true,
                email: true,
                assigned_campaign_id: true,
                cross_campaign_count: true,
                lead_category: true,
            }
        });

        if (!lead) {
            res.status(404).json({ error: 'Lead not found' });
            return;
        }

        // Get campaign assignment from our DB
        const localCampaign = lead.assigned_campaign_id
            ? await prisma.campaign.findUnique({
                where: { id: lead.assigned_campaign_id },
                select: { id: true, name: true, status: true }
            })
            : null;

        // Try to fetch from Smartlead API for cross-campaign data
        let smartleadCampaigns: Array<{ campaign_id: string; campaign_name: string; status: string }> = [];
        try {
            // Use the Smartlead lead ID if available (it's typically the same as our campaign lead ID)
            smartleadCampaigns = await fetchSmartleadLeadCampaigns(orgId, leadId);
        } catch {
            // Non-fatal: Smartlead may not have this lead or API may be unavailable
            logger.debug('[LeadCampaigns] Could not fetch from Smartlead API', { leadId, orgId });
        }

        res.json({
            success: true,
            data: {
                lead_id: lead.id,
                email: lead.email,
                lead_category: lead.lead_category,
                cross_campaign_count: lead.cross_campaign_count,
                local_campaign: localCampaign,
                smartlead_campaigns: smartleadCampaigns,
            }
        });
    } catch (error) {
        logger.error('Error fetching lead campaigns:', error as Error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
};
