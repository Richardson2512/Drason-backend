/**
 * Smart Routing Service
 *
 * Intelligent campaign matching for lead rerouting.
 * Analyzes lead characteristics and finds optimal target campaigns.
 *
 * Matching Criteria:
 * - ICP match (persona alignment)
 * - Lead score compatibility
 * - Campaign capacity
 * - Campaign health status
 * - Historical performance (if available)
 */

import { prisma } from '../index';
import { logger } from './observabilityService';
import { Lead } from '@prisma/client';

interface CampaignMatch {
    campaign_id: string;
    campaign_name: string;
    match_score: number; // 0-100, higher = better match
    confidence: 'low' | 'medium' | 'high';
    reasons: string[];
    warnings: string[];
    capacity_available: number; // Number of leads this campaign can accept
    current_load: number; // Current number of active leads
    mailbox_count: number;
    health_status: string;
}

interface SmartRoutingReport {
    lead_id: string;
    lead_email: string;
    lead_persona: string;
    lead_score: number;
    current_campaign_id: string | null;
    current_campaign_name: string | null;
    recommended_campaigns: CampaignMatch[];
    no_match_reason?: string;
}

/**
 * Calculate ICP match score between lead and campaign.
 */
function calculateICPMatch(
    leadPersona: string,
    leadScore: number,
    campaignPersonas: string[],
    campaignMinScore: number
): { score: number; reasons: string[] } {
    const reasons: string[] = [];
    let score = 0;

    // Persona match (60 points)
    const personaMatch = campaignPersonas.some(
        cp => cp.toLowerCase() === leadPersona.toLowerCase()
    );

    if (personaMatch) {
        score += 60;
        reasons.push(`✅ Persona match: ${leadPersona}`);
    } else {
        reasons.push(`⚠️ Persona mismatch: Lead is ${leadPersona}, campaign targets ${campaignPersonas.join(', ')}`);
    }

    // Score match (40 points)
    if (leadScore >= campaignMinScore) {
        const scoreDiff = leadScore - campaignMinScore;
        const scorePoints = Math.min(40, 20 + (scoreDiff * 2)); // Reward higher scores
        score += scorePoints;
        reasons.push(`✅ Score match: ${leadScore} >= ${campaignMinScore} (min required)`);
    } else {
        const scoreDiff = campaignMinScore - leadScore;
        reasons.push(`⚠️ Score below minimum: ${leadScore} < ${campaignMinScore} (deficit: ${scoreDiff})`);
    }

    return { score, reasons };
}

/**
 * Calculate campaign capacity score.
 */
function calculateCapacityScore(
    currentLoad: number,
    mailboxCount: number
): { score: number; reason: string; capacityAvailable: number } {
    // Ideal load: 50-100 leads per mailbox
    const idealLeadsPerMailbox = 75;
    const maxLeadsPerMailbox = 150;

    const idealCapacity = mailboxCount * idealLeadsPerMailbox;
    const maxCapacity = mailboxCount * maxLeadsPerMailbox;

    const capacityAvailable = Math.max(0, maxCapacity - currentLoad);

    if (currentLoad >= maxCapacity) {
        return {
            score: 0,
            reason: `⚠️ Campaign at max capacity (${currentLoad}/${maxCapacity} leads)`,
            capacityAvailable: 0
        };
    }

    if (currentLoad >= idealCapacity) {
        const utilizationPct = (currentLoad / maxCapacity) * 100;
        return {
            score: Math.max(0, 100 - utilizationPct),
            reason: `⚠️ Campaign above ideal capacity (${currentLoad}/${idealCapacity} leads, ${utilizationPct.toFixed(0)}% utilized)`,
            capacityAvailable
        };
    }

    const utilizationPct = (currentLoad / idealCapacity) * 100;
    return {
        score: 100 - utilizationPct,
        reason: `✅ Campaign has capacity (${currentLoad}/${idealCapacity} leads, ${utilizationPct.toFixed(0)}% utilized)`,
        capacityAvailable
    };
}

/**
 * Calculate campaign health score.
 */
function calculateHealthScore(
    campaignStatus: string,
    mailboxCount: number,
    healthyMailboxCount: number
): { score: number; reasons: string[] } {
    const reasons: string[] = [];
    let score = 0;

    // Campaign status (50 points)
    if (campaignStatus === 'active') {
        score += 50;
        reasons.push('✅ Campaign is active');
    } else {
        reasons.push(`⚠️ Campaign is ${campaignStatus}`);
    }

    // Mailbox health (50 points)
    if (mailboxCount === 0) {
        reasons.push('🚫 Campaign has no mailboxes');
    } else {
        const healthyPct = (healthyMailboxCount / mailboxCount) * 100;
        const healthScore = (healthyPct / 100) * 50;
        score += healthScore;

        if (healthyPct === 100) {
            reasons.push(`✅ All ${mailboxCount} mailboxes are healthy`);
        } else if (healthyPct >= 75) {
            reasons.push(`✅ ${healthyMailboxCount}/${mailboxCount} mailboxes are healthy (${healthyPct.toFixed(0)}%)`);
        } else if (healthyPct >= 50) {
            reasons.push(`⚠️ Only ${healthyMailboxCount}/${mailboxCount} mailboxes are healthy (${healthyPct.toFixed(0)}%)`);
        } else {
            reasons.push(`🚫 Only ${healthyMailboxCount}/${mailboxCount} mailboxes are healthy (${healthyPct.toFixed(0)}%)`);
        }
    }

    return { score, reasons };
}

/**
 * Find best campaign matches for a lead.
 */
export const findBestCampaignsForLead = async (
    organizationId: string,
    leadId: string,
    options: {
        excludeCurrentCampaign?: boolean;
        minMatchScore?: number;
        maxResults?: number;
    } = {}
): Promise<SmartRoutingReport> => {
    const {
        excludeCurrentCampaign = true,
        minMatchScore = 40,
        maxResults = 5
    } = options;

    logger.info(`[SMART_ROUTING] Finding campaigns for lead ${leadId}`);

    // Fetch lead
    const lead = await prisma.lead.findUnique({
        where: { id: leadId },
        include: {
            campaign: {
                select: {
                    id: true,
                    name: true
                }
            }
        }
    });

    if (!lead) {
        throw new Error(`Lead ${leadId} not found`);
    }

    // Fetch all active campaigns with routing rules and mailboxes
    const campaigns = await prisma.campaign.findMany({
        where: {
            organization_id: organizationId,
            status: 'active',
            ...(excludeCurrentCampaign && lead.assigned_campaign_id ? {
                id: { not: lead.assigned_campaign_id }
            } : {})
        },
        include: {
            routingRules: true,
            mailboxes: {
                include: {
                    mailbox: {
                        select: {
                            id: true,
                            status: true
                        }
                    }
                }
            },
            leads: {
                where: {
                    status: { in: ['active', 'held', 'paused'] } // Active leads
                },
                select: {
                    id: true
                }
            }
        }
    });

    const matches: CampaignMatch[] = [];

    for (const campaign of campaigns) {
        const matchReasons: string[] = [];
        const warnings: string[] = [];
        let totalScore = 0;

        // Get campaign personas and min score from routing rules
        const campaignPersonas = campaign.routingRules.map(r => r.persona);
        const campaignMinScore = campaign.routingRules.length > 0
            ? Math.min(...campaign.routingRules.map(r => r.min_score))
            : 0;

        if (campaignPersonas.length === 0) {
            warnings.push('Campaign has no routing rules - ICP unknown');
        }

        // 1. ICP Match (40% weight)
        const icpMatch = calculateICPMatch(
            lead.persona,
            lead.lead_score,
            campaignPersonas,
            campaignMinScore
        );
        totalScore += icpMatch.score * 0.4;
        matchReasons.push(...icpMatch.reasons);

        // 2. Capacity (30% weight)
        const mailboxCount = campaign.mailboxes.length;
        const currentLoad = campaign.leads.length;
        const capacityResult = calculateCapacityScore(currentLoad, mailboxCount);
        totalScore += capacityResult.score * 0.3;
        matchReasons.push(capacityResult.reason);

        if (capacityResult.capacityAvailable === 0) {
            warnings.push('Campaign is at max capacity');
        }

        // 3. Health (30% weight)
        const healthyMailboxCount = campaign.mailboxes.filter(
            m => m.mailbox.status === 'healthy'
        ).length;
        const healthResult = calculateHealthScore(
            campaign.status,
            mailboxCount,
            healthyMailboxCount
        );
        totalScore += healthResult.score * 0.3;
        matchReasons.push(...healthResult.reasons);

        // Determine confidence level
        let confidence: 'low' | 'medium' | 'high';
        if (totalScore >= 80) {
            confidence = 'high';
        } else if (totalScore >= 60) {
            confidence = 'medium';
        } else {
            confidence = 'low';
        }

        matches.push({
            campaign_id: campaign.id,
            campaign_name: campaign.name || 'Unnamed Campaign',
            match_score: Math.round(totalScore),
            confidence,
            reasons: matchReasons,
            warnings,
            capacity_available: capacityResult.capacityAvailable,
            current_load: currentLoad,
            mailbox_count: mailboxCount,
            health_status: campaign.status
        });
    }

    // Filter by min score and sort by match score
    const filteredMatches = matches
        .filter(m => m.match_score >= minMatchScore)
        .sort((a, b) => b.match_score - a.match_score)
        .slice(0, maxResults);

    const report: SmartRoutingReport = {
        lead_id: lead.id,
        lead_email: lead.email,
        lead_persona: lead.persona,
        lead_score: lead.lead_score,
        current_campaign_id: lead.assigned_campaign_id,
        current_campaign_name: lead.campaign?.name || null,
        recommended_campaigns: filteredMatches,
        no_match_reason: filteredMatches.length === 0
            ? `No campaigns found matching minimum score threshold (${minMatchScore})`
            : undefined
    };

    logger.info(`[SMART_ROUTING] Found ${filteredMatches.length} matching campaigns for lead ${leadId}`);

    return report;
};

/**
 * Batch find best campaigns for multiple leads.
 */
export const findBestCampaignsForLeads = async (
    organizationId: string,
    leadIds: string[],
    options: {
        excludeCurrentCampaign?: boolean;
        minMatchScore?: number;
        maxResults?: number;
    } = {}
): Promise<SmartRoutingReport[]> => {
    logger.info(`[SMART_ROUTING] Finding campaigns for ${leadIds.length} leads`);

    const reports: SmartRoutingReport[] = [];

    for (const leadId of leadIds) {
        try {
            const report = await findBestCampaignsForLead(organizationId, leadId, options);
            reports.push(report);
        } catch (error: any) {
            logger.error(`[SMART_ROUTING] Error finding campaigns for lead ${leadId}`, { error: error.message });
        }
    }

    return reports;
};
