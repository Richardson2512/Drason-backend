/**
 * Routing Service
 * 
 * Deterministic rule-based routing for leads.
 * Section 9 of Audit: Execution Gate Logic - deterministic decisions.
 * 
 * Rules are evaluated in priority order (highest first).
 * Matching is based on persona (case-insensitive) and minimum lead score.
 */

import { prisma } from '../index';
import { Lead } from '@prisma/client';
import * as auditLogService from './auditLogService';
import { logger } from './observabilityService';

/**
 * Resolve the target campaign for a lead based on routing rules.
 * Returns campaign ID if matched, null if no match (lead stays in holding pool).
 */
export const resolveCampaignForLead = async (
    organizationId: string,
    lead: Lead
): Promise<string | null> => {
    // Fetch all rules for this organization, ordered by priority (highest first)
    const rules = await prisma.routingRule.findMany({
        where: { organization_id: organizationId },
        orderBy: { priority: 'desc' }
    });

    logger.info(`[ROUTING] Org: ${organizationId} | Found ${rules.length} rules | Lead: ${lead.persona}, ${lead.lead_score}`);

    // Iterate and match
    for (const rule of rules) {
        logger.info(`[ROUTING] Checking rule ${rule.id}: Persona=${rule.persona}, MinScore=${rule.min_score}`);

        // Check Persona Match (Case-insensitive)
        const personaMatch = rule.persona.toLowerCase() === lead.persona.toLowerCase();

        // Check Score Match
        const scoreMatch = lead.lead_score >= rule.min_score;

        logger.info(`[ROUTING] Match Result: Persona=${personaMatch}, Score=${scoreMatch}`);

        if (personaMatch && scoreMatch) {
            await auditLogService.logAction({
                organizationId,
                entity: 'lead',
                entityId: lead.id,
                trigger: 'ingestion_routing',
                action: 'route_matched',
                details: `Matched rule ${rule.id} -> Campaign ${rule.target_campaign_id}`
            });
            return rule.target_campaign_id;
        }
    }

    // No match - log and return null
    await auditLogService.logAction({
        organizationId,
        entity: 'lead',
        entityId: lead.id,
        trigger: 'ingestion_routing',
        action: 'no_route_matched',
        details: `No matching rule found for Persona: ${lead.persona}, Score: ${lead.lead_score}`
    });

    return null;
};

/**
 * Get all routing rules for an organization.
 */
export const getRules = async (organizationId: string): Promise<any[]> => {
    return prisma.routingRule.findMany({
        where: { organization_id: organizationId },
        orderBy: { priority: 'desc' }
    });
};

/**
 * Create a new routing rule.
 */
export const createRule = async (
    organizationId: string,
    data: {
        persona: string;
        min_score: number;
        target_campaign_id: string;
        priority: number;
    }
): Promise<any> => {
    const rule = await prisma.routingRule.create({
        data: {
            ...data,
            organization_id: organizationId
        }
    });

    await auditLogService.logAction({
        organizationId,
        entity: 'routing_rule',
        entityId: rule.id,
        trigger: 'manual',
        action: 'created',
        details: `Rule: ${data.persona} >= ${data.min_score} -> ${data.target_campaign_id}`
    });

    return rule;
};
