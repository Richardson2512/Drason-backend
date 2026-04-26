/**
 * Lead Controller
 *
 * Alternative lead ingestion endpoint.
 * Delegates to ingestionController.processLead() so that ALL leads go through
 * the same pipeline: email validation → health gate → upsert → routing → push.
 *
 * BUG FIX (BE-3): Previously called leadService.createLead() which skipped
 * email validation, health gate, and platform push.
 */

import { Request, Response } from 'express';
import { getOrgId } from '../middleware/orgContext';
import { logger } from '../services/observabilityService';
import { prisma } from '../index';
import { processLead } from './ingestionController';

export const ingestLead = async (req: Request, res: Response): Promise<void> => {
    try {
        const { email, persona, lead_score, workable } = req.body;
        const orgId = getOrgId(req);

        // 1. Validate Payload
        if (!email || !persona || lead_score === undefined || workable !== true) {
            res.status(400).json({ success: false, error: 'Invalid payload: Missing required fields or not workable' });
            return;
        }

        // 2. Process through the unified ingestion pipeline (validation + health gate + routing + push)
        const result = await processLead(orgId, {
            email,
            persona,
            lead_score,
            source: 'api',
            first_name: req.body.first_name,
            last_name: req.body.last_name,
            company: req.body.company,
        });

        // 3. Increment usage count for billing/capacity tracking
        await prisma.organization.update({
            where: { id: orgId },
            data: { current_lead_count: { increment: 1 } }
        });

        res.status(201).json({ success: true, data: result });
    } catch (error) {
        logger.error('Error ingesting lead:', error as Error);
        res.status(500).json({ success: false, error: 'Internal Server Error' });
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
            res.status(404).json({ success: false, error: 'Lead not found' });
            return;
        }

        // Get the assigned campaign. Post-merge Campaign table holds both legacy
        // platform-synced rows and native sequencer rows (source_platform='sequencer'),
        // so a single findUnique resolves either type.
        const assignedCampaign = lead.assigned_campaign_id
            ? await prisma.campaign.findUnique({
                where: { id: lead.assigned_campaign_id },
                select: { id: true, name: true, status: true },
            })
            : null;

        // Also surface sequencer campaigns this lead's email is enrolled in via
        // CampaignLead — authoritative multi-campaign link for the sequencer,
        // since CampaignLead has no legacy-platform analog (legacy campaigns use
        // BounceEvent / Lead.assigned_campaign_id instead).
        const sequencerEnrollments = await prisma.campaignLead.findMany({
            where: {
                email: lead.email,
                campaign: { organization_id: orgId },
            },
            select: {
                campaign_id: true,
                campaign: { select: { id: true, name: true, status: true } },
            },
            distinct: ['campaign_id'],
        });

        // Assemble the final list of campaigns this lead is associated with.
        const allCampaigns: Array<{ id: string; name: string; status: string }> = [];
        if (assignedCampaign) allCampaigns.push(assignedCampaign);
        for (const enr of sequencerEnrollments) {
            if (!enr.campaign) continue;
            if (allCampaigns.some((c) => c.id === enr.campaign!.id)) continue; // dedupe
            allCampaigns.push(enr.campaign);
        }

        // Also check bounce events for cross-campaign associations on legacy platforms.
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
                select: { id: true, name: true, status: true },
            });
            for (const ac of additionalCampaigns) {
                if (allCampaigns.some((c) => c.id === ac.id)) continue;
                allCampaigns.push(ac);
            }
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
        res.status(500).json({ success: false, error: 'Internal Server Error' });
    }
};
