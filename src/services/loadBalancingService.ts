/**
 * Load Balancing Service
 *
 * Analyzes mailbox-campaign distribution and suggests optimal rebalancing.
 * Considers mailbox health, domain health, and campaign load.
 *
 * Load is measured by "effective load share" — the fraction of each campaign's
 * sending burden that falls on a single mailbox. A mailbox in 5 campaigns that
 * each have 20 mailboxes carries 5 × (1/20) = 0.25 effective load. A mailbox
 * that is the sole sender in 3 campaigns carries 3.0 effective load.
 *
 * Thresholds (effective load share):
 * - Overloaded: >= 3.0 effective load (equivalent to being the sole mailbox in 3+ campaigns)
 * - Optimal: 1.0 - 2.99 effective load
 * - Underutilized: < 1.0 effective load
 *
 * Fallback: If a mailbox has no send data and is in 0 campaigns, it's underutilized.
 */

import { prisma } from '../index';
import { logger } from './observabilityService';
import { getAdapterForMailbox } from '../adapters/platformRegistry';
import { SlackAlertService } from './SlackAlertService';

interface MailboxLoad {
    id: string;
    email: string;
    status: string;
    domain_id: string;
    domain_status: string;
    campaign_count: number;
    effective_load: number; // Sum of (1 / mailboxes_in_campaign) across all campaigns
    load_category: 'overloaded' | 'optimal' | 'underutilized';
    health_score: number; // 0-100, based on metrics
    total_sent: number; // Lifetime send volume from sync + webhooks
    bounce_rate: number; // Lifetime bounce rate (0-100)
    engagement_rate: number; // Lifetime engagement rate (0-100)
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
    // Effective load share thresholds
    OVERLOADED: 3.0,   // Carrying the load of 3+ solo campaigns
    OPTIMAL_MIN: 1.0,
    OPTIMAL_MAX: 2.99,
    UNDERUTILIZED: 1.0, // Less than 1 solo-campaign equivalent
    // Campaign-level: campaigns with fewer than this many mailboxes need more
    MIN_MAILBOXES_PER_CAMPAIGN: 3
};

/**
 * Calculate health score for a mailbox based on metrics.
 */
function calculateMailboxHealthScore(mailbox: any): number {
    // Start with perfect score
    let score = 100;

    // Factor 1: 24h window metrics (real-time signal)
    if (mailbox.metrics) {
        const metrics = mailbox.metrics;
        const sent24h = metrics.window_24h_sent || 1;
        const bounce24h = metrics.window_24h_bounce || 0;
        const failure24h = metrics.window_24h_failure || 0;

        const bounceRate24h = (bounce24h / sent24h) * 100;
        const failureRate24h = (failure24h / sent24h) * 100;

        score -= bounceRate24h * 10;
        score -= failureRate24h * 5;
    }

    // Factor 2: Lifetime bounce rate (from sync + webhooks)
    // Weighted lower than 24h since it's a longer-term trend
    if (mailbox.total_sent_count > 0) {
        const lifetimeBounceRate = (mailbox.hard_bounce_count / mailbox.total_sent_count) * 100;
        score -= lifetimeBounceRate * 5;
    }

    // Factor 3: Engagement rate (from sync + webhooks)
    // Low engagement suggests spam folder issues
    if (mailbox.total_sent_count > 0 && mailbox.engagement_rate !== undefined) {
        if (mailbox.engagement_rate < 2) {
            score -= 15; // Very low engagement
        } else if (mailbox.engagement_rate < 5) {
            score -= 8; // Low engagement
        }
    }

    // Factor 4: Cooldown status
    if (mailbox.cooldown_until && new Date(mailbox.cooldown_until) > new Date()) {
        score -= 30;
    }

    // Factor 5: Domain warnings
    const domainWarnings = mailbox.domain?.warning_count || 0;
    score -= domainWarnings * 5;

    // If no metrics at all and no lifetime data, return neutral
    if (!mailbox.metrics && mailbox.total_sent_count === 0) {
        return 50;
    }

    return Math.max(0, Math.min(100, score));
}

/**
 * Calculate effective load share for a mailbox.
 * For each campaign the mailbox belongs to, its share is 1/N where N is
 * how many mailboxes that campaign has. The sum across all campaigns gives
 * the effective load.
 *
 * Example: mailbox in 5 campaigns each with 20 mailboxes = 5 × (1/20) = 0.25 (underutilized)
 * Example: mailbox as sole sender in 2 campaigns = 2 × (1/1) = 2.0 (optimal)
 * Example: mailbox as sole sender in 4 campaigns = 4 × (1/1) = 4.0 (overloaded)
 */
function calculateEffectiveLoad(
    mailboxCampaignIds: string[],
    campaignMailboxCounts: Map<string, number>
): number {
    let effectiveLoad = 0;
    for (const campaignId of mailboxCampaignIds) {
        const mailboxesInCampaign = campaignMailboxCounts.get(campaignId) || 1;
        effectiveLoad += 1 / mailboxesInCampaign;
    }
    return effectiveLoad;
}

/**
 * Categorize mailbox load based on effective load share.
 */
function categorizeLoad(effectiveLoad: number): 'overloaded' | 'optimal' | 'underutilized' {
    if (effectiveLoad >= THRESHOLDS.OVERLOADED) return 'overloaded';
    if (effectiveLoad >= THRESHOLDS.OPTIMAL_MIN) return 'optimal';
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
                select: {
                    id: true,
                    name: true,
                    status: true
                }
            }
        }
    });

    // Fetch all campaigns (exclude deleted)
    const campaigns = await prisma.campaign.findMany({
        where: { organization_id: organizationId, status: { not: 'deleted' } },
        include: {
            mailboxes: true
        }
    });

    const healthWarnings: string[] = [];
    const suggestions: LoadBalancingSuggestion[] = [];

    // Build a map of campaign → active mailbox count (for effective load calculation)
    const campaignMailboxCounts = new Map<string, number>();
    for (const campaign of campaigns) {
        campaignMailboxCounts.set(campaign.id, campaign.mailboxes.length);
    }

    // Analyze each mailbox
    const mailboxLoads: MailboxLoad[] = mailboxes.map(mailbox => {
        const campaignCount = mailbox.campaigns.length;
        const campaignIds = mailbox.campaigns.map(c => c.id);
        const effectiveLoad = calculateEffectiveLoad(campaignIds, campaignMailboxCounts);
        const healthScore = calculateMailboxHealthScore(mailbox);
        const loadCategory = categorizeLoad(effectiveLoad);

        const totalSent = mailbox.total_sent_count || 0;
        const bounceRate = totalSent > 0 ? (mailbox.hard_bounce_count / totalSent) * 100 : 0;

        const load: MailboxLoad = {
            id: mailbox.id,
            email: mailbox.email,
            status: mailbox.status,
            domain_id: mailbox.domain_id,
            domain_status: mailbox.domain?.status || 'unknown',
            campaign_count: campaignCount,
            effective_load: Number(effectiveLoad.toFixed(2)),
            load_category: loadCategory,
            health_score: healthScore,
            total_sent: totalSent,
            bounce_rate: Number(bounceRate.toFixed(2)),
            engagement_rate: Number((mailbox.engagement_rate || 0).toFixed(2)),
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
    // Sort overloaded by highest effective load first
    for (const overloadedMailbox of overloadedMailboxes.sort((a, b) => b.effective_load - a.effective_load)) {
        if (overloadedMailbox.status !== 'healthy') continue;

        // Find underutilized mailboxes from the same domain
        const underutilizedSameDomain = underutilizedMailboxes.filter(
            m => m.domain_id === overloadedMailbox.domain_id &&
                m.status === 'healthy' &&
                m.health_score >= 70
        );

        if (underutilizedSameDomain.length > 0) {
            const mailbox = mailboxes.find(m => m.id === overloadedMailbox.id);
            const activeCampaigns = mailbox?.campaigns.filter(c => c.status === 'active') || [];

            // Sort campaigns by fewest mailboxes first (move from campaigns where this mailbox carries the most load)
            const sortedCampaigns = [...activeCampaigns].sort((a, b) => {
                const countA = campaignMailboxCounts.get(a.id) || 1;
                const countB = campaignMailboxCounts.get(b.id) || 1;
                return countA - countB; // Campaigns with fewer mailboxes first (highest load share)
            });

            // Suggest adding underutilized mailboxes to campaigns where this mailbox is carrying heavy load
            let suggestionsAdded = 0;
            for (const campaign of sortedCampaigns) {
                if (suggestionsAdded >= underutilizedSameDomain.length) break;
                const mailboxesInCampaign = campaignMailboxCounts.get(campaign.id) || 1;
                // Only suggest if this campaign has few mailboxes (high per-mailbox load)
                if (mailboxesInCampaign >= 5) continue;

                const targetMailbox = underutilizedSameDomain[suggestionsAdded];
                suggestions.push({
                    type: 'move_mailbox',
                    mailbox_id: overloadedMailbox.id,
                    mailbox_email: overloadedMailbox.email,
                    from_campaign_id: campaign.id,
                    from_campaign_name: campaign.name || undefined,
                    to_campaign_id: undefined,
                    to_campaign_name: undefined,
                    reason: `Mailbox ${overloadedMailbox.email} has high effective load (${overloadedMailbox.effective_load} — equivalent to being sole sender in ${overloadedMailbox.effective_load} campaigns). Campaign "${campaign.name}" only has ${mailboxesInCampaign} mailbox(es). Add ${targetMailbox.email} (effective load: ${targetMailbox.effective_load}) to share the burden.`,
                    expected_impact: `Reduces effective load on ${overloadedMailbox.email} and adds redundancy to "${campaign.name}"`,
                    priority: overloadedMailbox.effective_load >= 4.0 ? 'high' : 'medium'
                });
                suggestionsAdded++;
            }
        }
    }

    // Strategy 2: Add healthy underutilized mailboxes to campaigns lacking mailboxes
    const campaignsWithFewMailboxes = campaigns.filter(c =>
        c.status === 'active' && c.mailboxes.length < THRESHOLDS.MIN_MAILBOXES_PER_CAMPAIGN
    );

    for (const campaign of campaignsWithFewMailboxes) {
        // Find healthy underutilized mailboxes not in this campaign
        const availableMailboxes = underutilizedMailboxes.filter(m =>
            m.status === 'healthy' &&
            m.health_score >= 70 &&
            !campaign.mailboxes.some(cm => cm.id === m.id)
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
            const activeCampaigns = mailboxData?.campaigns.filter(c => c.status === 'active') || [];

            for (const campaignRel of activeCampaigns) {
                suggestions.push({
                    type: 'remove_mailbox',
                    mailbox_id: mailbox.id,
                    mailbox_email: mailbox.email,
                    from_campaign_id: campaignRel.id,
                    from_campaign_name: campaignRel.name || undefined,
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
        health_warnings: healthWarnings
    };

    logger.info(`[LOAD_BALANCING] Analysis complete: ${suggestions.length} suggestions, ${healthWarnings.length} warnings`);

    // Send Slack alert if there are high-priority suggestions
    const highPrioritySuggestions = suggestions.filter(s => s.priority === 'high');
    if (highPrioritySuggestions.length > 0) {
        const suggestionLines = highPrioritySuggestions
            .map(s => `• *${s.type.replace('_', ' ')}* — \`${s.mailbox_email}\`: ${s.reason}`)
            .join('\n');

        SlackAlertService.sendAlert({
            organizationId,
            eventType: 'load_balancing_report',
            severity: 'warning',
            title: `⚖️ Load Balancing: ${highPrioritySuggestions.length} High-Priority Issue${highPrioritySuggestions.length > 1 ? 's' : ''}`,
            message: [
                `*${overloadedMailboxes.length}* overloaded · *${underutilizedMailboxes.length}* underutilized · *${optimalMailboxes.length}* optimal`,
                `Avg campaigns/mailbox: *${avgCampaignsPerMailbox.toFixed(1)}*`,
                '',
                '*High-Priority Actions:*',
                suggestionLines
            ].join('\n')
        }).catch(err => logger.warn('[LOAD_BALANCING] Non-fatal Slack alert error', { error: String(err) }));
    }

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
                await prisma.campaign.update({
                    where: { id: suggestion.to_campaign_id },
                    data: {
                        mailboxes: {
                            connect: { id: suggestion.mailbox_id }
                        }
                    }
                });

                // Fetch mailbox for platform adapter resolution
                const mailboxAdd = await prisma.mailbox.findUnique({
                    where: { id: suggestion.mailbox_id },
                    select: { organization_id: true, external_email_account_id: true }
                });

                if (mailboxAdd?.external_email_account_id) {
                    try {
                        const adapter = await getAdapterForMailbox(suggestion.mailbox_id);
                        const campaign = await prisma.campaign.findUnique({
                            where: { id: suggestion.to_campaign_id },
                            select: { external_id: true }
                        });
                        const externalCampaignId = campaign?.external_id || suggestion.to_campaign_id;
                        await adapter.addMailboxToCampaign(
                            mailboxAdd.organization_id,
                            externalCampaignId,
                            mailboxAdd.external_email_account_id
                        );
                    } catch (adapterError: any) {
                        logger.warn(`[LOAD_BALANCING] Platform API call failed for add`, { error: adapterError.message });
                    }
                } else {
                    logger.warn(`[LOAD_BALANCING] Mailbox ${suggestion.mailbox_id} missing external ID, skipping platform API call`);
                }
                SlackAlertService.sendAlert({
                    organizationId,
                    eventType: 'load_balancing_add',
                    entityId: suggestion.mailbox_id,
                    severity: 'info',
                    title: '⚖️ Load Balancing: Mailbox Added',
                    message: `Mailbox \`${suggestion.mailbox_email}\` added to campaign *${suggestion.to_campaign_name}*.\n*Reason:* ${suggestion.reason}`
                }).catch(err => logger.warn('[LOAD_BALANCING] Non-fatal Slack alert error', { error: String(err) }));

                return {
                    success: true,
                    message: `Added ${suggestion.mailbox_email} to campaign ${suggestion.to_campaign_name}`
                };

            case 'remove_mailbox':
                if (!suggestion.from_campaign_id) {
                    throw new Error('from_campaign_id required for remove_mailbox');
                }
                // Remove mailbox from campaign (both in DB and Smartlead)
                await prisma.campaign.update({
                    where: { id: suggestion.from_campaign_id },
                    data: {
                        mailboxes: {
                            disconnect: { id: suggestion.mailbox_id }
                        }
                    }
                });
                // Fetch mailbox for platform adapter resolution
                const mailboxRemove = await prisma.mailbox.findUnique({
                    where: { id: suggestion.mailbox_id },
                    select: { organization_id: true, external_email_account_id: true }
                });

                if (mailboxRemove?.external_email_account_id) {
                    try {
                        const adapter = await getAdapterForMailbox(suggestion.mailbox_id);
                        const campaign = await prisma.campaign.findUnique({
                            where: { id: suggestion.from_campaign_id },
                            select: { external_id: true }
                        });
                        const externalCampaignId = campaign?.external_id || suggestion.from_campaign_id;
                        await adapter.removeMailboxFromCampaign(
                            mailboxRemove.organization_id,
                            externalCampaignId,
                            mailboxRemove.external_email_account_id
                        );
                    } catch (adapterError: any) {
                        logger.warn(`[LOAD_BALANCING] Platform API call failed for remove`, { error: adapterError.message });
                    }
                } else {
                    logger.warn(`[LOAD_BALANCING] Mailbox ${suggestion.mailbox_id} missing external ID, skipping platform API call`);
                }
                SlackAlertService.sendAlert({
                    organizationId,
                    eventType: 'load_balancing_remove',
                    entityId: suggestion.mailbox_id,
                    severity: 'warning',
                    title: '⚖️ Load Balancing: Mailbox Removed',
                    message: `Mailbox \`${suggestion.mailbox_email}\` removed from campaign *${suggestion.from_campaign_name}*.\n*Reason:* ${suggestion.reason}`
                }).catch(err => logger.warn('[LOAD_BALANCING] Non-fatal Slack alert error', { error: String(err) }));

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
        logger.error(`[LOAD_BALANCING] Failed to apply suggestion:`, error);
        return {
            success: false,
            message: `Failed to apply suggestion: ${error.message}`
        };
    }
};
