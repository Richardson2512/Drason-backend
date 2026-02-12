/**
 * Lead Service
 * 
 * Core lead creation and management logic.
 */

import { prisma } from '../index';
import * as routingService from './routingService';
import { LeadState } from '../types';

interface CreateLeadDTO {
    email: string;
    persona: string;
    lead_score: number;
}

export const createLead = async (organizationId: string, data: CreateLeadDTO) => {
    // 1. Create Lead (Held)
    const lead = await prisma.lead.create({
        data: {
            email: data.email,
            persona: data.persona,
            lead_score: data.lead_score,
            status: LeadState.HELD,
            health_state: 'healthy',
            source: 'clay',
            organization_id: organizationId,
        },
    });

    // 2. Resolve Route immediately
    const campaignId = await routingService.resolveCampaignForLead(organizationId, lead);

    if (campaignId) {
        return await prisma.lead.update({
            where: { id: lead.id },
            data: { assigned_campaign_id: campaignId },
        });
    }

    return lead;
};
