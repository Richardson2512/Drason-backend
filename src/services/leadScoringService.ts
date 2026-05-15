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

import { prisma } from '../prisma';
import { logger } from './observabilityService';
// Platform adapter now handles lead operations via PlatformAdapter interface

interface EngagementData {
    opens: number;
    clicks: number;
    replies: number;
    bounces: number;
    lastEngagementDate?: Date;
}

/// Built-in scoring weights - every knob exposed in the Lead Scoring config
/// UI. Defaults match the original hardcoded formula so an org that never
/// touches the config sees identical behavior. Stored as JSON on
/// LeadScoringConfig.builtin_weights and merged with these defaults so older
/// rows are forward-compatible when new knobs are added.
export interface BuiltinScoringWeights {
    base: number;
    per_open: number;
    max_open: number;
    per_click: number;
    max_click: number;
    per_reply: number;
    max_reply: number;
    per_bounce: number;        // negative number (penalty)
    recency_7d: number;
    recency_30d: number;
    recency_90d: number;
    recency_older: number;
    frequency_high: number;    // 11+ events
    frequency_mid: number;     // 6-10
    frequency_low: number;     // 3-5
    frequency_min: number;     // 1-2
}

export interface CustomScoringEvent {
    key: string;
    label: string;
    points: number;
    color?: string;
}

export const DEFAULT_BUILTIN_WEIGHTS: BuiltinScoringWeights = {
    base: 20,
    per_open: 2,
    max_open: 10,
    per_click: 4,
    max_click: 10,
    per_reply: 5,
    max_reply: 15,
    per_bounce: -10,
    recency_7d: 30,
    recency_30d: 22,
    recency_90d: 12,
    recency_older: 5,
    frequency_high: 20,
    frequency_mid: 15,
    frequency_low: 10,
    frequency_min: 6,
};

/// Load (lazy-create) the scoring config for an org. Merges stored values on
/// top of the defaults so new knobs added in future PRs don't break existing
/// rows. Cached briefly to avoid hammering the DB during burst webhook flow.
const configCache = new Map<string, { value: { weights: BuiltinScoringWeights; events: CustomScoringEvent[] }; expires: number }>();
const CONFIG_TTL_MS = 30_000;

export async function getScoringConfig(organizationId: string): Promise<{ weights: BuiltinScoringWeights; events: CustomScoringEvent[] }> {
    const now = Date.now();
    const hit = configCache.get(organizationId);
    if (hit && hit.expires > now) return hit.value;

    let row = await prisma.leadScoringConfig.findUnique({ where: { organization_id: organizationId } });
    if (!row) {
        row = await prisma.leadScoringConfig.create({
            data: {
                organization_id: organizationId,
                builtin_weights: DEFAULT_BUILTIN_WEIGHTS as unknown as object,
                custom_events: [],
            },
        });
    }
    const storedWeights = (row.builtin_weights || {}) as Partial<BuiltinScoringWeights>;
    const weights: BuiltinScoringWeights = { ...DEFAULT_BUILTIN_WEIGHTS, ...storedWeights };
    const events: CustomScoringEvent[] = Array.isArray(row.custom_events) ? row.custom_events as unknown as CustomScoringEvent[] : [];
    const value = { weights, events };
    configCache.set(organizationId, { value, expires: now + CONFIG_TTL_MS });
    return value;
}

export function invalidateScoringConfigCache(organizationId: string) {
    configCache.delete(organizationId);
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
export function calculateEngagementScore(engagement: EngagementData, weights: BuiltinScoringWeights = DEFAULT_BUILTIN_WEIGHTS): LeadScore['breakdown'] {
    // ── Engagement component (max 50) ──
    const opensScore = Math.min(engagement.opens * weights.per_open, weights.max_open);
    const clicksScore = Math.min(engagement.clicks * weights.per_click, weights.max_click);
    const repliesScore = Math.min(engagement.replies * weights.per_reply, weights.max_reply);
    const bouncePenalty = engagement.bounces * weights.per_bounce;
    const engagementTotal = Math.max(0, Math.min(50, weights.base + opensScore + clicksScore + repliesScore + bouncePenalty));

    // ── Recency component (max 30) ──
    let recency = weights.recency_older;
    if (engagement.lastEngagementDate) {
        const daysSinceEngagement = (Date.now() - engagement.lastEngagementDate.getTime()) / (1000 * 60 * 60 * 24);
        if (daysSinceEngagement <= 7) recency = weights.recency_7d;
        else if (daysSinceEngagement <= 30) recency = weights.recency_30d;
        else if (daysSinceEngagement <= 90) recency = weights.recency_90d;
    }

    // ── Frequency component (max 20) ──
    const totalInteractions = engagement.opens + engagement.clicks + engagement.replies;
    let frequency = 0;
    if (totalInteractions >= 11) frequency = weights.frequency_high;
    else if (totalInteractions >= 6) frequency = weights.frequency_mid;
    else if (totalInteractions >= 3) frequency = weights.frequency_low;
    else if (totalInteractions >= 1) frequency = weights.frequency_min;

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
 * Platform-agnostic - works for all platforms (Smartlead, EmailBison, Instantly).
 */
export async function recalculateLeadScore(leadId: string): Promise<void> {
    const lead = await prisma.lead.findUnique({
        where: { id: leadId },
        select: {
            organization_id: true,
            emails_opened: true,
            emails_clicked: true,
            emails_replied: true,
            last_activity_at: true,
            lead_score_adjustments: true,
        }
    });
    if (!lead) return;

    const { weights } = await getScoringConfig(lead.organization_id);
    const breakdown = calculateEngagementScore({
        opens: lead.emails_opened || 0,
        clicks: lead.emails_clicked || 0,
        replies: lead.emails_replied || 0,
        bounces: 0,
        lastEngagementDate: lead.last_activity_at || undefined,
    }, weights);
    // Final score = built-in engagement score + manual adjustments. The
    // adjustments column is bumped at event-insert time using whatever the
    // point value was THEN, so existing adjustments are immune to future
    // config edits.
    const builtin = calculateFinalScore(breakdown);
    const newScore = Math.max(0, Math.min(100, builtin + (lead.lead_score_adjustments || 0)));

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
        // Only score leads from active campaigns (skip deleted/archived)
        const activeCampaignIds = await prisma.campaign.findMany({
            where: {
                organization_id: organizationId,
                status: { notIn: ['deleted', 'DELETED', 'archived', 'ARCHIVED'] }
            },
            select: { id: true }
        }).then(cs => cs.map(c => c.id));

        const leads = await prisma.lead.findMany({
            where: {
                organization_id: organizationId,
                OR: [
                    { assigned_campaign_id: { in: activeCampaignIds } },
                    { assigned_campaign_id: null }
                ]
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

    // Breakdown components now directly sum to the score - no transformation needed
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

/// Update the scoring config for an org. Replaces whatever's stored - the
/// frontend always sends the full weights + custom events list. Defaults
/// fill in any missing keys so legacy payloads stay safe.
export async function updateScoringConfig(
    organizationId: string,
    weights: Partial<BuiltinScoringWeights>,
    events: CustomScoringEvent[],
): Promise<{ weights: BuiltinScoringWeights; events: CustomScoringEvent[] }> {
    const merged: BuiltinScoringWeights = { ...DEFAULT_BUILTIN_WEIGHTS, ...weights };
    // Dedupe event keys; preserve first-write order.
    const seen = new Set<string>();
    const cleaned: CustomScoringEvent[] = [];
    for (const e of events) {
        const key = String(e.key || '').trim();
        const label = String(e.label || '').trim();
        if (!key || !label || seen.has(key)) continue;
        seen.add(key);
        cleaned.push({
            key,
            label,
            points: Math.trunc(Number(e.points) || 0),
            color: e.color || undefined,
        });
    }
    await prisma.leadScoringConfig.upsert({
        where: { organization_id: organizationId },
        update: { builtin_weights: merged as unknown as object, custom_events: cleaned as unknown as object },
        create: {
            organization_id: organizationId,
            builtin_weights: merged as unknown as object,
            custom_events: cleaned as unknown as object,
        },
    });
    invalidateScoringConfigCache(organizationId);
    return { weights: merged, events: cleaned };
}

/// Record a custom score event for a lead and bump the running adjustments
/// total. Points are captured at insert time so historical events keep their
/// original value even if the operator later edits the event's point value
/// in config. Returns the inserted row + updated lead_score.
export async function recordLeadScoreEvent(opts: {
    organizationId: string;
    leadId: string;
    eventKey: string;
    createdByUserId?: string | null;
    note?: string | null;
    /// Optional explicit override. If omitted, the points are looked up from
    /// the org's current custom_events config.
    points?: number;
    /// Optional override for the label snapshot - useful for "manual one-off"
    /// adjustments that aren't tied to a configured event.
    label?: string;
}): Promise<{ event: { id: string; event_key: string; label: string; points: number; created_at: Date }; lead_score: number }> {
    const lead = await prisma.lead.findFirst({
        where: { id: opts.leadId, organization_id: opts.organizationId },
        select: { id: true },
    });
    if (!lead) throw new Error('Lead not found');

    let points = opts.points;
    let label = opts.label;
    if (points === undefined || !label) {
        const { events } = await getScoringConfig(opts.organizationId);
        const match = events.find(e => e.key === opts.eventKey);
        if (!match && (points === undefined || !label)) {
            throw new Error(`Unknown event key '${opts.eventKey}'`);
        }
        if (points === undefined) points = match!.points;
        if (!label) label = match!.label;
    }
    points = Math.trunc(Number(points) || 0);

    const event = await prisma.leadScoreEvent.create({
        data: {
            lead_id: opts.leadId,
            organization_id: opts.organizationId,
            event_key: opts.eventKey,
            label: label!,
            points,
            created_by_user_id: opts.createdByUserId || null,
            note: opts.note || null,
        },
        select: { id: true, event_key: true, label: true, points: true, created_at: true },
    });

    // Bump adjustments + recompute. Using update {increment} keeps it atomic
    // under concurrent webhook flow.
    await prisma.lead.update({
        where: { id: opts.leadId },
        data: { lead_score_adjustments: { increment: points } },
    });
    await recalculateLeadScore(opts.leadId);

    const updated = await prisma.lead.findUnique({ where: { id: opts.leadId }, select: { lead_score: true } });
    return { event, lead_score: updated?.lead_score ?? 0 };
}

/// Delete (undo) a score event and reverse its point contribution.
export async function deleteLeadScoreEvent(organizationId: string, leadId: string, eventId: string): Promise<{ lead_score: number }> {
    const event = await prisma.leadScoreEvent.findFirst({
        where: { id: eventId, lead_id: leadId, organization_id: organizationId },
        select: { id: true, points: true },
    });
    if (!event) throw new Error('Event not found');

    await prisma.leadScoreEvent.delete({ where: { id: event.id } });
    await prisma.lead.update({
        where: { id: leadId },
        data: { lead_score_adjustments: { decrement: event.points } },
    });
    await recalculateLeadScore(leadId);

    const updated = await prisma.lead.findUnique({ where: { id: leadId }, select: { lead_score: true } });
    return { lead_score: updated?.lead_score ?? 0 };
}

export async function listLeadScoreEvents(organizationId: string, leadId: string): Promise<Array<{ id: string; event_key: string; label: string; points: number; note: string | null; created_at: Date }>> {
    return prisma.leadScoreEvent.findMany({
        where: { organization_id: organizationId, lead_id: leadId },
        orderBy: { created_at: 'desc' },
        select: { id: true, event_key: true, label: true, points: true, note: true, created_at: true },
    });
}
