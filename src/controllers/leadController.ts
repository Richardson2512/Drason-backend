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
 * Platform-agnostic — queries local DB for all campaigns across all platforms.
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

        // Get the assigned campaign from our DB
        const assignedCampaign = lead.assigned_campaign_id
            ? await prisma.campaign.findUnique({
                where: { id: lead.assigned_campaign_id },
                select: { id: true, name: true, status: true, source_platform: true }
            })
            : null;

        // Query all campaigns this lead's email is associated with (platform-agnostic)
        // This finds campaigns where the lead email appears in bounce events or audit logs
        const allCampaigns = lead.assigned_campaign_id
            ? [assignedCampaign].filter(Boolean)
            : [];

        // Also check bounce events for cross-campaign associations
        const crossCampaignIds = await prisma.bounceEvent.findMany({
            where: {
                organization_id: orgId,
                email_address: lead.email,
                campaign_id: { not: null },
            },
            select: { campaign_id: true },
            distinct: ['campaign_id'],
        });

        if (crossCampaignIds.length > 0) {
            const additionalCampaigns = await prisma.campaign.findMany({
                where: {
                    id: { in: crossCampaignIds.map(b => b.campaign_id!).filter(Boolean) },
                    NOT: { id: lead.assigned_campaign_id || '' },
                },
                select: { id: true, name: true, status: true, source_platform: true },
            });
            allCampaigns.push(...additionalCampaigns);
        }

        res.json({
            success: true,
            data: {
                lead_id: lead.id,
                email: lead.email,
                lead_category: lead.lead_category,
                cross_campaign_count: lead.cross_campaign_count,
                assigned_campaign: assignedCampaign,
                all_campaigns: allCampaigns,
            }
        });
    } catch (error) {
        logger.error('Error fetching lead campaigns:', error as Error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
};
