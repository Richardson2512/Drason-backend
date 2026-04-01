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
    // 1. Upsert Lead (Held) — prevents duplicate constraint violations on re-ingestion
    const lead = await prisma.lead.upsert({
        where: {
            organization_id_email: {
                organization_id: organizationId,
                email: data.email,
            },
        },
        update: {
            persona: data.persona,
            lead_score: data.lead_score,
        },
        create: {
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
