/**
 * Lead Scoring Service
 *
 * Calculates dynamic lead quality scores based on engagement data from Smartlead.
 * Scores range from 0-100 and help identify top-performing leads in campaigns.
 *
 * Scoring Formula:
 * - Base: 50 (neutral)
 * - Opens: +2 each (max +15)
 * - Clicks: +5 each (max +20)
 * - Replies: +15 each (max +30)
 * - Bounces: -20 each
 * - Recency multiplier (0.5x - 1.0x based on last engagement)
 */

import { prisma } from '../index';
import { logger } from './observabilityService';
import * as smartleadClient from './smartleadClient';

interface EngagementData {
    opens: number;
    clicks: number;
    replies: number;
    bounces: number;
    lastEngagementDate?: Date;
}

interface LeadScore {
    leadId: string;
    email: string;
    score: number;
    breakdown: {
        base: number;
        opensScore: number;
        clicksScore: number;
        repliesScore: number;
        bouncePenalty: number;
        recencyMultiplier: number;
    };
}

/**
 * Calculate engagement score for a lead based on their interaction history.
 */
export function calculateEngagementScore(engagement: EngagementData): LeadScore['breakdown'] {
    const base = 50;

    // Opens: +2 each, capped at +15
    const opensScore = Math.min(engagement.opens * 2, 15);

    // Clicks: +5 each, capped at +20
    const clicksScore = Math.min(engagement.clicks * 5, 20);

    // Replies: +15 each, capped at +30
    const repliesScore = Math.min(engagement.replies * 15, 30);

    // Bounces: -20 each (heavily penalize)
    const bouncePenalty = engagement.bounces * -20;

    // Recency multiplier
    let recencyMultiplier = 0.5; // Default: old engagement

    if (engagement.lastEngagementDate) {
        const daysSinceEngagement = (Date.now() - engagement.lastEngagementDate.getTime()) / (1000 * 60 * 60 * 24);

        if (daysSinceEngagement <= 30) {
            recencyMultiplier = 1.0; // Recent engagement
        } else if (daysSinceEngagement <= 90) {
            recencyMultiplier = 0.7; // Medium recency
        }
        // else: 0.5 (old engagement)
    }

    return {
        base,
        opensScore,
        clicksScore,
        repliesScore,
        bouncePenalty,
        recencyMultiplier
    };
}

/**
 * Calculate final score from breakdown components.
 */
export function calculateFinalScore(breakdown: LeadScore['breakdown']): number {
    const rawScore = (
        breakdown.base +
        breakdown.opensScore +
        breakdown.clicksScore +
        breakdown.repliesScore +
        breakdown.bouncePenalty
    ) * breakdown.recencyMultiplier;

    // Clamp to 0-100 range
    return Math.max(0, Math.min(100, Math.round(rawScore)));
}

/**
 * Sync engagement data from Smartlead and update lead scores.
 * This should be called periodically (e.g., daily) to keep scores fresh.
 */
export async function syncLeadScoresFromSmartlead(organizationId: string): Promise<{
    updated: number;
    topLeads: LeadScore[];
}> {
    logger.info('[LEAD-SCORING] Starting lead score sync', { organizationId });

    try {
        // Get all Smartlead leads for this organization
        const leads = await prisma.lead.findMany({
            where: {
                organization_id: organizationId,
                source: 'smartlead'
            },
            select: {
                id: true,
                email: true,
                assigned_campaign_id: true
            }
        });

        logger.info(`[LEAD-SCORING] Found ${leads.length} Smartlead leads to score`);

        if (leads.length === 0) {
            return { updated: 0, topLeads: [] };
        }

        // Group leads by campaign for efficient API calls
        const leadsByCampaign = leads.reduce((acc, lead) => {
            if (lead.assigned_campaign_id) {
                if (!acc[lead.assigned_campaign_id]) {
                    acc[lead.assigned_campaign_id] = [];
                }
                acc[lead.assigned_campaign_id].push(lead);
            }
            return acc;
        }, {} as Record<string, typeof leads>);

        let updatedCount = 0;
        const scoredLeads: LeadScore[] = [];

        // Process each campaign
        for (const [campaignId, campaignLeads] of Object.entries(leadsByCampaign)) {
            try {
                // Fetch engagement data from Smartlead API
                // Note: This requires Smartlead API support for lead-level analytics
                const engagementData = await fetchSmartleadEngagementData(
                    organizationId,
                    campaignId,
                    campaignLeads.map(l => l.email)
                );

                // Calculate scores for each lead
                for (const lead of campaignLeads) {
                    const engagement = engagementData[lead.email];

                    if (!engagement) {
                        // No engagement data - keep default score
                        continue;
                    }

                    const breakdown = calculateEngagementScore(engagement);
                    const finalScore = calculateFinalScore(breakdown);

                    // Update lead score in database
                    await prisma.lead.update({
                        where: { id: lead.id },
                        data: {
                            lead_score: finalScore,
                            updated_at: new Date()
                        }
                    });

                    updatedCount++;

                    scoredLeads.push({
                        leadId: lead.id,
                        email: lead.email,
                        score: finalScore,
                        breakdown
                    });
                }
            } catch (campaignError: any) {
                logger.error(`[LEAD-SCORING] Failed to score leads in campaign ${campaignId}`, campaignError);
                // Continue with other campaigns
            }
        }

        // Sort by score descending to get top leads
        const topLeads = scoredLeads
            .sort((a, b) => b.score - a.score)
            .slice(0, 20); // Top 20 leads

        logger.info(`[LEAD-SCORING] Sync complete`, {
            organizationId,
            totalLeads: leads.length,
            updated: updatedCount,
            topScore: topLeads[0]?.score || 0
        });

        return { updated: updatedCount, topLeads };

    } catch (error: any) {
        logger.error('[LEAD-SCORING] Sync failed', error);
        throw error;
    }
}

/**
 * Fetch engagement data from Smartlead API.
 *
 * TODO: Implement actual Smartlead API call when endpoint is available.
 * Current Smartlead API limitations:
 * - No single endpoint for lead-level engagement stats
 * - Need to aggregate from email activity logs
 *
 * Workaround: Parse campaign activity logs or use webhook events.
 */
async function fetchSmartleadEngagementData(
    organizationId: string,
    campaignId: string,
    emails: string[]
): Promise<Record<string, EngagementData>> {
    // This is a placeholder - actual implementation depends on Smartlead API capabilities

    // Option 1: Use Smartlead campaign analytics API (if available)
    // Option 2: Aggregate from email activity events stored in our database
    // Option 3: Parse from Smartlead webhook events we've received

    // For now, let's aggregate from our own event store
    return await aggregateEngagementFromEvents(organizationId, emails);
}

/**
 * Aggregate engagement data from our internal event store.
 * This uses events we've received from Smartlead webhooks.
 */
async function aggregateEngagementFromEvents(
    organizationId: string,
    emails: string[]
): Promise<Record<string, EngagementData>> {
    const engagementMap: Record<string, EngagementData> = {};

    // Initialize engagement data for all emails
    emails.forEach(email => {
        engagementMap[email] = {
            opens: 0,
            clicks: 0,
            replies: 0,
            bounces: 0
        };
    });

    // Query events from our event store
    // This assumes we're storing email events (opens, clicks, replies, bounces)
    const events = await prisma.event.findMany({
        where: {
            organization_id: organizationId,
            event_type: {
                in: ['EmailSent', 'EmailOpened', 'EmailClicked', 'EmailReplied', 'HardBounce', 'SoftBounce']
            }
        },
        select: {
            event_type: true,
            payload: true,
            created_at: true
        },
        orderBy: {
            created_at: 'desc'
        }
    });

    // Aggregate engagement by email
    events.forEach(event => {
        const email = (event.payload as any)?.email || (event.payload as any)?.lead_email;

        if (!email || !engagementMap[email]) {
            return;
        }

        const engagement = engagementMap[email];

        switch (event.event_type) {
            case 'EmailOpened':
                engagement.opens++;
                break;
            case 'EmailClicked':
                engagement.clicks++;
                break;
            case 'EmailReplied':
                engagement.replies++;
                break;
            case 'HardBounce':
            case 'SoftBounce':
                engagement.bounces++;
                break;
        }

        // Track most recent engagement
        if (!engagement.lastEngagementDate || event.created_at > engagement.lastEngagementDate) {
            engagement.lastEngagementDate = event.created_at;
        }
    });

    return engagementMap;
}

/**
 * Get top performing leads for a campaign.
 */
export async function getTopLeadsForCampaign(
    campaignId: string,
    limit: number = 10
): Promise<Array<{ email: string; score: number; assigned_campaign_id: string }>> {
    return prisma.lead.findMany({
        where: {
            assigned_campaign_id: campaignId,
            source: 'smartlead'
        },
        select: {
            email: true,
            lead_score: true,
            assigned_campaign_id: true
        },
        orderBy: {
            lead_score: 'desc'
        },
        take: limit
    }).then(leads =>
        leads.map(l => ({
            email: l.email,
            score: l.lead_score,
            assigned_campaign_id: l.assigned_campaign_id || ''
        }))
    );
}

/**
 * Get engagement score breakdown for a specific lead (for debugging/insights).
 */
export async function getLeadScoreBreakdown(
    leadId: string
): Promise<{ score: number; breakdown: LeadScore['breakdown'] } | null> {
    const lead = await prisma.lead.findUnique({
        where: { id: leadId },
        select: {
            email: true,
            organization_id: true,
            lead_score: true
        }
    });

    if (!lead) {
        return null;
    }

    // Fetch engagement data
    const engagementData = await aggregateEngagementFromEvents(
        lead.organization_id,
        [lead.email]
    );

    const engagement = engagementData[lead.email];

    if (!engagement) {
        return null;
    }

    const breakdown = calculateEngagementScore(engagement);
    const score = calculateFinalScore(breakdown);

    return { score, breakdown };
}
