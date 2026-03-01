/**
 * Lead Scoring Service
 *
 * Calculates dynamic lead quality scores based on engagement data from all platforms.
 * Scores range from 0-100 and help identify top-performing leads in campaigns.
 *
 * Additive Scoring Formula (all components sum to final score):
 * - Engagement (max 50): Base 20 + Opens(max +10) + Clicks(max +10) + Replies(max +15) - Bounces
 * - Recency   (max 30): Based on days since last engagement
 * - Frequency  (max 20): Based on total interaction count
 * - Score = Engagement + Recency + Frequency (capped 0-100)
 */

import { prisma } from '../index';
import { logger } from './observabilityService';
// Platform adapter now handles lead operations via PlatformAdapter interface

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
        engagement: number;   // max 50
        recency: number;      // max 30
        frequency: number;    // max 20
    };
}

/**
 * Calculate additive score components for a lead.
 * Returns { engagement, recency, frequency } that SUM to the final score.
 */
export function calculateEngagementScore(engagement: EngagementData): LeadScore['breakdown'] {
    // ── Engagement component (max 50) ──
    const base = 20;
    const opensScore = Math.min(engagement.opens * 2, 10);
    const clicksScore = Math.min(engagement.clicks * 4, 10);
    const repliesScore = Math.min(engagement.replies * 5, 15);
    const bouncePenalty = engagement.bounces * -10;
    const engagementTotal = Math.max(0, Math.min(50, base + opensScore + clicksScore + repliesScore + bouncePenalty));

    // ── Recency component (max 30) ──
    let recency = 5; // Default: no engagement data or very old
    if (engagement.lastEngagementDate) {
        const daysSinceEngagement = (Date.now() - engagement.lastEngagementDate.getTime()) / (1000 * 60 * 60 * 24);
        if (daysSinceEngagement <= 7) {
            recency = 30;
        } else if (daysSinceEngagement <= 30) {
            recency = 22;
        } else if (daysSinceEngagement <= 90) {
            recency = 12;
        }
        // else: 5 (old engagement)
    }

    // ── Frequency component (max 20) ──
    const totalInteractions = engagement.opens + engagement.clicks + engagement.replies;
    let frequency = 0;
    if (totalInteractions >= 11) {
        frequency = 20;
    } else if (totalInteractions >= 6) {
        frequency = 15;
    } else if (totalInteractions >= 3) {
        frequency = 10;
    } else if (totalInteractions >= 1) {
        frequency = 6;
    }

    return { engagement: engagementTotal, recency, frequency };
}

/**
 * Calculate final score from breakdown components.
 * Score = engagement + recency + frequency (capped 0-100).
 */
export function calculateFinalScore(breakdown: LeadScore['breakdown']): number {
    const rawScore = breakdown.engagement + breakdown.recency + breakdown.frequency;
    return Math.max(0, Math.min(100, Math.round(rawScore)));
}

/**
 * Recalculate lead_score from engagement counters using the proper formula.
 * Called after each open/click/reply webhook to keep scores accurate in real-time.
 * Platform-agnostic — works for all platforms (Smartlead, EmailBison, Instantly).
 */
export async function recalculateLeadScore(leadId: string): Promise<void> {
    const lead = await prisma.lead.findUnique({
        where: { id: leadId },
        select: {
            emails_opened: true,
            emails_clicked: true,
            emails_replied: true,
            last_activity_at: true,
        }
    });
    if (!lead) return;

    const breakdown = calculateEngagementScore({
        opens: lead.emails_opened || 0,
        clicks: lead.emails_clicked || 0,
        replies: lead.emails_replied || 0,
        bounces: 0,
        lastEngagementDate: lead.last_activity_at || undefined,
    });
    const newScore = calculateFinalScore(breakdown);

    await prisma.lead.update({
        where: { id: leadId },
        data: { lead_score: newScore }
    });
}

/**
 * Sync engagement data and update lead scores for all platforms.
 * This should be called periodically (e.g., daily) to keep scores fresh.
 */
export async function syncLeadScores(organizationId: string): Promise<{
    updated: number;
    topLeads: LeadScore[];
}> {
    logger.info('[LEAD-SCORING] Starting lead score sync', { organizationId });

    try {
        // Get all leads for this organization (all sources: api, clay, smartlead)
        const leads = await prisma.lead.findMany({
            where: {
                organization_id: organizationId,
            },
            select: {
                id: true,
                email: true,
                assigned_campaign_id: true
            }
        });

        logger.info(`[LEAD-SCORING] Found ${leads.length} leads to score`);

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
                const engagementData = await fetchEngagementData(
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
 * Fetch engagement data for leads.
 * Currently aggregates from our internal event store (populated by webhooks from all platforms).
 */
async function fetchEngagementData(
    organizationId: string,
    campaignId: string,
    emails: string[]
): Promise<Record<string, EngagementData>> {
    // Aggregate from our own event store (populated by webhooks from all platforms)
    return await aggregateEngagementFromEvents(organizationId, emails);
}

/**
 * Aggregate engagement data from our internal event store.
 * Uses lead activity counters populated by webhooks from all platforms.
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

    // Fetch lead activity data directly from Lead model
    // Activity stats are updated in real-time by webhooks from all platforms
    const leads = await prisma.lead.findMany({
        where: {
            organization_id: organizationId,
            email: { in: emails }
        },
        select: {
            email: true,
            emails_opened: true,
            emails_clicked: true,
            emails_replied: true,
            last_activity_at: true
        }
    });

    // Map lead activity to engagement data
    leads.forEach(lead => {
        if (lead.email && engagementMap[lead.email]) {
            engagementMap[lead.email] = {
                opens: lead.emails_opened || 0,
                clicks: lead.emails_clicked || 0,
                replies: lead.emails_replied || 0,
                bounces: 0, // Bounce data not stored per-lead currently
                lastEngagementDate: lead.last_activity_at || undefined
            };
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
): Promise<{
    score: number;
    breakdown: {
        engagement: number;
        recency: number;
        frequency: number;
    };
    factors: {
        totalOpens: number;
        totalClicks: number;
        totalReplies: number;
        lastEngagement: Date | null;
    };
} | null> {
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

    const engagement = engagementData[lead.email] || {
        opens: 0,
        clicks: 0,
        replies: 0,
        bounces: 0
    };

    const rawBreakdown = calculateEngagementScore(engagement);
    const score = calculateFinalScore(rawBreakdown);

    // Breakdown components now directly sum to the score — no transformation needed
    return {
        score,
        breakdown: {
            engagement: rawBreakdown.engagement,
            recency: rawBreakdown.recency,
            frequency: rawBreakdown.frequency
        },
        factors: {
            totalOpens: engagement.opens,
            totalClicks: engagement.clicks,
            totalReplies: engagement.replies,
            lastEngagement: engagement.lastEngagementDate || null
        }
    };
}
