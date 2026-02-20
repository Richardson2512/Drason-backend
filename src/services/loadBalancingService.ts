/**
 * Load Balancing Service
 *
 * Analyzes mailbox-campaign distribution and suggests optimal rebalancing.
 * Considers mailbox health, domain health, and campaign load.
 *
 * Thresholds:
 * - Overloaded: 5+ campaigns per mailbox
 * - Underutilized: < 3 campaigns per mailbox
 * - Ideal: 3-4 campaigns per mailbox
 */

import { prisma } from '../index';
import { logger } from './observabilityService';

interface MailboxLoad {
    id: string;
    email: string;
    status: string;
    domain_id: string;
    domain_status: string;
    campaign_count: number;
    load_category: 'overloaded' | 'optimal' | 'underutilized';
    health_score: number; // 0-100, based on metrics
}

interface LoadBalancingSuggestion {
    type: 'move_mailbox' | 'add_mailbox' | 'remove_mailbox';
    mailbox_id: string;
    mailbox_email: string;
    from_campaign_id?: string;
    from_campaign_name?: string;
    to_campaign_id?: string;
    to_campaign_name?: string;
    reason: string;
    expected_impact: string;
    priority: 'high' | 'medium' | 'low';
}

interface LoadBalancingReport {
    summary: {
        total_mailboxes: number;
        total_campaigns: number;
        overloaded_mailboxes: number;
        underutilized_mailboxes: number;
        optimal_mailboxes: number;
        avg_campaigns_per_mailbox: number;
    };
    mailbox_distribution: MailboxLoad[];
    suggestions: LoadBalancingSuggestion[];
    health_warnings: string[];
}

const THRESHOLDS = {
    OVERLOADED: 5,
    OPTIMAL_MIN: 3,
    OPTIMAL_MAX: 4,
    UNDERUTILIZED: 3
};

/**
 * Calculate health score for a mailbox based on metrics.
 */
function calculateMailboxHealthScore(mailbox: any): number {
    if (!mailbox.metrics) return 50; // Default neutral score

    const metrics = mailbox.metrics;
    const sent24h = metrics.window_24h_sent || 1;
    const bounce24h = metrics.window_24h_bounce || 0;
    const failure24h = metrics.window_24h_failure || 0;

    const bounceRate = (bounce24h / sent24h) * 100;
    const failureRate = (failure24h / sent24h) * 100;

    // Start with perfect score
    let score = 100;

    // Deduct for bounce rate
    score -= bounceRate * 10; // High bounce rate significantly reduces score

    // Deduct for failure rate
    score -= failureRate * 5;

    // Deduct if mailbox is in cooldown
    if (mailbox.cooldown_until && new Date(mailbox.cooldown_until) > new Date()) {
        score -= 30;
    }

    // Deduct if domain has warnings
    const domainWarnings = mailbox.domain?.warning_count || 0;
    score -= domainWarnings * 5;

    return Math.max(0, Math.min(100, score));
}

/**
 * Categorize mailbox load.
 */
function categorizeLoad(campaignCount: number): 'overloaded' | 'optimal' | 'underutilized' {
    if (campaignCount >= THRESHOLDS.OVERLOADED) return 'overloaded';
    if (campaignCount >= THRESHOLDS.OPTIMAL_MIN && campaignCount <= THRESHOLDS.OPTIMAL_MAX) return 'optimal';
    return 'underutilized';
}

/**
 * Analyze mailbox-campaign distribution for an organization.
 */
export const analyzeLoadBalancing = async (
    organizationId: string
): Promise<LoadBalancingReport> => {
    logger.info(`[LOAD_BALANCING] Analyzing for org ${organizationId}`);

    // Fetch all mailboxes with campaigns and metrics
    const mailboxes = await prisma.mailbox.findMany({
        where: { organization_id: organizationId },
        include: {
            domain: true,
            metrics: true,
            campaigns: {
                include: {
                    campaign: {
                        select: {
                            id: true,
                            name: true,
                            status: true
                        }
                    }
                }
            }
        }
    });

    // Fetch all campaigns
    const campaigns = await prisma.campaign.findMany({
        where: { organization_id: organizationId },
        include: {
            mailboxes: {
                include: {
                    mailbox: true
                }
            }
        }
    });

    const healthWarnings: string[] = [];
    const suggestions: LoadBalancingSuggestion[] = [];

    // Analyze each mailbox
    const mailboxLoads: MailboxLoad[] = mailboxes.map(mailbox => {
        const campaignCount = mailbox.campaigns.length;
        const healthScore = calculateMailboxHealthScore(mailbox);
        const loadCategory = categorizeLoad(campaignCount);

        const load: MailboxLoad = {
            id: mailbox.id,
            email: mailbox.email,
            status: mailbox.status,
            domain_id: mailbox.domain_id,
            domain_status: mailbox.domain?.status || 'unknown',
            campaign_count: campaignCount,
            load_category: loadCategory,
            health_score: healthScore
        };

        // Add health warnings
        if (mailbox.status !== 'healthy') {
            healthWarnings.push(`Mailbox ${mailbox.email} is ${mailbox.status}`);
        }
        if (mailbox.domain?.status !== 'healthy') {
            healthWarnings.push(`Domain for ${mailbox.email} is ${mailbox.domain?.status}`);
        }
        if (healthScore < 50) {
            healthWarnings.push(`Mailbox ${mailbox.email} has low health score: ${healthScore.toFixed(0)}`);
        }

        return load;
    });

    // Calculate summary stats
    const overloadedMailboxes = mailboxLoads.filter(m => m.load_category === 'overloaded');
    const underutilizedMailboxes = mailboxLoads.filter(m => m.load_category === 'underutilized');
    const optimalMailboxes = mailboxLoads.filter(m => m.load_category === 'optimal');

    const totalCampaignCount = mailboxLoads.reduce((sum, m) => sum + m.campaign_count, 0);
    const avgCampaignsPerMailbox = mailboxes.length > 0 ? totalCampaignCount / mailboxes.length : 0;

    // Generate suggestions
    // Strategy 1: Move mailboxes from overloaded to underutilized
    for (const overloadedMailbox of overloadedMailboxes) {
        if (overloadedMailbox.status !== 'healthy') continue; // Don't move unhealthy mailboxes

        // Find underutilized mailboxes from the same domain
        const underutilizedSameDomain = underutilizedMailboxes.filter(
            m => m.domain_id === overloadedMailbox.domain_id &&
                 m.status === 'healthy' &&
                 m.health_score >= 70
        );

        if (underutilizedSameDomain.length > 0) {
            // Find campaigns where this overloaded mailbox is used
            const mailbox = mailboxes.find(m => m.id === overloadedMailbox.id);
            const activeCampaigns = mailbox?.campaigns.filter(c => c.campaign.status === 'active') || [];

            // Suggest moving some campaigns to underutilized mailboxes
            const excessCampaigns = overloadedMailbox.campaign_count - THRESHOLDS.OPTIMAL_MAX;
            const campaignsToMove = Math.min(excessCampaigns, activeCampaigns.length);

            for (let i = 0; i < campaignsToMove && i < underutilizedSameDomain.length; i++) {
                const targetMailbox = underutilizedSameDomain[i];
                const campaignToMove = activeCampaigns[i];

                suggestions.push({
                    type: 'move_mailbox',
                    mailbox_id: overloadedMailbox.id,
                    mailbox_email: overloadedMailbox.email,
                    from_campaign_id: campaignToMove.campaign.id,
                    from_campaign_name: campaignToMove.campaign.name || undefined,
                    to_campaign_id: undefined,
                    to_campaign_name: undefined,
                    reason: `Mailbox ${overloadedMailbox.email} is overloaded (${overloadedMailbox.campaign_count} campaigns). Move to ${targetMailbox.email} which has only ${targetMailbox.campaign_count} campaigns.`,
                    expected_impact: `Reduces load from ${overloadedMailbox.campaign_count} to ${overloadedMailbox.campaign_count - 1} campaigns`,
                    priority: overloadedMailbox.campaign_count >= 7 ? 'high' : 'medium'
                });
            }
        }
    }

    // Strategy 2: Add healthy underutilized mailboxes to campaigns lacking mailboxes
    const campaignsWithFewMailboxes = campaigns.filter(c =>
        c.status === 'active' && c.mailboxes.length < 3
    );

    for (const campaign of campaignsWithFewMailboxes) {
        // Find healthy underutilized mailboxes not in this campaign
        const availableMailboxes = underutilizedMailboxes.filter(m =>
            m.status === 'healthy' &&
            m.health_score >= 70 &&
            !campaign.mailboxes.some(cm => cm.mailbox.id === m.id)
        );

        if (availableMailboxes.length > 0) {
            const bestMailbox = availableMailboxes.sort((a, b) => b.health_score - a.health_score)[0];

            suggestions.push({
                type: 'add_mailbox',
                mailbox_id: bestMailbox.id,
                mailbox_email: bestMailbox.email,
                to_campaign_id: campaign.id,
                to_campaign_name: campaign.name || undefined,
                reason: `Campaign "${campaign.name}" has only ${campaign.mailboxes.length} mailboxes. Add ${bestMailbox.email} (health score: ${bestMailbox.health_score.toFixed(0)}) to improve redundancy.`,
                expected_impact: `Increases campaign mailbox count from ${campaign.mailboxes.length} to ${campaign.mailboxes.length + 1}`,
                priority: campaign.mailboxes.length === 1 ? 'high' : 'medium'
            });
        }
    }

    // Strategy 3: Remove unhealthy mailboxes from campaigns
    for (const mailbox of mailboxLoads) {
        if (mailbox.status !== 'healthy' || mailbox.health_score < 50) {
            const mailboxData = mailboxes.find(m => m.id === mailbox.id);
            const activeCampaigns = mailboxData?.campaigns.filter(c => c.campaign.status === 'active') || [];

            for (const campaignRel of activeCampaigns) {
                suggestions.push({
                    type: 'remove_mailbox',
                    mailbox_id: mailbox.id,
                    mailbox_email: mailbox.email,
                    from_campaign_id: campaignRel.campaign.id,
                    from_campaign_name: campaignRel.campaign.name || undefined,
                    reason: `Mailbox ${mailbox.email} is unhealthy (status: ${mailbox.status}, health score: ${mailbox.health_score.toFixed(0)}). Remove from campaign to prevent deliverability issues.`,
                    expected_impact: 'Reduces risk of bounces and failures',
                    priority: 'high'
                });
            }
        }
    }

    // Sort suggestions by priority
    suggestions.sort((a, b) => {
        const priorityOrder = { high: 3, medium: 2, low: 1 };
        return priorityOrder[b.priority] - priorityOrder[a.priority];
    });

    const report: LoadBalancingReport = {
        summary: {
            total_mailboxes: mailboxes.length,
            total_campaigns: campaigns.length,
            overloaded_mailboxes: overloadedMailboxes.length,
            underutilized_mailboxes: underutilizedMailboxes.length,
            optimal_mailboxes: optimalMailboxes.length,
            avg_campaigns_per_mailbox: Number(avgCampaignsPerMailbox.toFixed(2))
        },
        mailbox_distribution: mailboxLoads,
        suggestions,
        health_warnings
    };

    logger.info(`[LOAD_BALANCING] Analysis complete: ${suggestions.length} suggestions, ${healthWarnings.length} warnings`);

    return report;
};

/**
 * Apply a load balancing suggestion.
 */
export const applySuggestion = async (
    organizationId: string,
    suggestion: LoadBalancingSuggestion
): Promise<{ success: boolean; message: string }> => {
    logger.info(`[LOAD_BALANCING] Applying suggestion: ${suggestion.type} for mailbox ${suggestion.mailbox_id}`);

    try {
        switch (suggestion.type) {
            case 'add_mailbox':
                if (!suggestion.to_campaign_id) {
                    throw new Error('to_campaign_id required for add_mailbox');
                }
                // Add mailbox to campaign (both in DB and Smartlead)
                await prisma.campaignToMailbox.create({
                    data: {
                        campaign_id: suggestion.to_campaign_id,
                        mailbox_id: suggestion.mailbox_id
                    }
                });
                // TODO: Call Smartlead API to add mailbox to campaign
                return {
                    success: true,
                    message: `Added ${suggestion.mailbox_email} to campaign ${suggestion.to_campaign_name}`
                };

            case 'remove_mailbox':
                if (!suggestion.from_campaign_id) {
                    throw new Error('from_campaign_id required for remove_mailbox');
                }
                // Remove mailbox from campaign (both in DB and Smartlead)
                await prisma.campaignToMailbox.deleteMany({
                    where: {
                        campaign_id: suggestion.from_campaign_id,
                        mailbox_id: suggestion.mailbox_id
                    }
                });
                // TODO: Call Smartlead API to remove mailbox from campaign
                return {
                    success: true,
                    message: `Removed ${suggestion.mailbox_email} from campaign ${suggestion.from_campaign_name}`
                };

            case 'move_mailbox':
                // This is essentially a remove + add operation
                // For now, we'll just log it as this requires user confirmation
                return {
                    success: false,
                    message: 'Move mailbox requires manual confirmation - use remove + add'
                };

            default:
                throw new Error(`Unknown suggestion type: ${suggestion.type}`);
        }
    } catch (error: any) {
        logger.error(`[LOAD_BALANCING] Failed to apply suggestion:`, { error: error.message });
        return {
            success: false,
            message: `Failed to apply suggestion: ${error.message}`
        };
    }
};
