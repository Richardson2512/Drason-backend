/**
 * Predictive Monitoring Service
 *
 * Analyzes campaign health trends to predict potential stalls before they happen.
 * Generates proactive alerts so users can take preventive action.
 *
 * Detection Signals:
 * - Mailbox health degradation trend
 * - Domain warning escalation
 * - Bounce rate increase
 * - Campaign mailbox count dropping
 * - Mailboxes entering cooldown
 */

import { prisma } from '../index';
import { logger } from './observabilityService';
import * as notificationService from './notificationService';
import { SlackAlertService } from './SlackAlertService';

interface Recommendation {
    action: 'add_mailboxes' | 'remove_unhealthy' | 'wait_cooldown' | 'investigate_bounces' | 'fix_domains' | 'no_action';
    label: string;
    campaign_id: string;
    mailbox_ids?: string[];
    domain_ids?: string[];
}

interface CampaignRiskScore {
    campaign_id: string;
    campaign_name: string;
    risk_score: number; // 0-100, higher = more risk
    risk_level: 'low' | 'medium' | 'high' | 'critical';
    stall_probability: number; // 0-1, probability of stalling in next 48h
    time_to_stall_hours: number | null; // Estimated hours until stall (if trending toward stall)
    signals: RiskSignal[];
    recommended_actions: string[];
    recommendations: Recommendation[];
}

interface RiskSignal {
    type: 'mailbox_health' | 'domain_health' | 'bounce_rate' | 'mailbox_count' | 'cooldown';
    severity: 'low' | 'medium' | 'high' | 'critical';
    message: string;
    score_impact: number; // Contribution to overall risk score
}

interface PredictiveReport {
    timestamp: Date;
    campaigns_analyzed: number;
    at_risk_campaigns: number;
    high_risk_campaigns: number;
    critical_risk_campaigns: number;
    campaign_risks: CampaignRiskScore[];
}

const RISK_THRESHOLDS = {
    LOW: 25,
    MEDIUM: 50,
    HIGH: 75,
    CRITICAL: 90
};

/**
 * Calculate risk level from risk score.
 */
function getRiskLevel(score: number): 'low' | 'medium' | 'high' | 'critical' {
    if (score >= RISK_THRESHOLDS.CRITICAL) return 'critical';
    if (score >= RISK_THRESHOLDS.HIGH) return 'high';
    if (score >= RISK_THRESHOLDS.MEDIUM) return 'medium';
    return 'low';
}

/**
 * Analyze a single campaign for stall risk.
 */
async function analyzeCampaignRisk(
    organizationId: string,
    campaignId: string
): Promise<CampaignRiskScore | null> {
    const campaign = await prisma.campaign.findUnique({
        where: { id: campaignId },
        include: {
            mailboxes: {
                include: {
                    domain: true,
                    metrics: true
                }
            }
        }
    });

    if (!campaign || campaign.status !== 'active') {
        return null; // Only analyze active campaigns
    }

    const signals: RiskSignal[] = [];
    let totalRiskScore = 0;

    // ── Signal 1: Mailbox Count ──
    const mailboxCount = campaign.mailboxes.length;
    if (mailboxCount === 0) {
        signals.push({
            type: 'mailbox_count',
            severity: 'critical',
            message: 'Campaign has no mailboxes assigned',
            score_impact: 50
        });
        totalRiskScore += 50;
    } else if (mailboxCount === 1) {
        signals.push({
            type: 'mailbox_count',
            severity: 'high',
            message: 'Campaign has only 1 mailbox (no redundancy)',
            score_impact: 30
        });
        totalRiskScore += 30;
    } else if (mailboxCount === 2) {
        signals.push({
            type: 'mailbox_count',
            severity: 'medium',
            message: 'Campaign has only 2 mailboxes (limited redundancy)',
            score_impact: 15
        });
        totalRiskScore += 15;
    }

    // ── Signal 2: Mailbox Health Degradation ──
    let unhealthyMailboxCount = 0;
    let mailboxesInCooldown = 0;
    let avgBounceRate = 0;
    let mailboxMetricsCount = 0;

    for (const mailbox of campaign.mailboxes) {
        // Check status
        if (mailbox.status !== 'healthy') {
            unhealthyMailboxCount++;
        }

        // Check cooldown
        if (mailbox.cooldown_until && new Date(mailbox.cooldown_until) > new Date()) {
            mailboxesInCooldown++;
        }

        // Check bounce rate
        if (mailbox.metrics) {
            mailboxMetricsCount++;
            const sent24h = mailbox.metrics.window_24h_sent || 1;
            const bounce24h = mailbox.metrics.window_24h_bounce || 0;
            avgBounceRate += (bounce24h / sent24h) * 100;
        }
    }

    if (mailboxMetricsCount > 0) {
        avgBounceRate = avgBounceRate / mailboxMetricsCount;
    }

    // Unhealthy mailboxes
    if (unhealthyMailboxCount > 0) {
        const unhealthyPct = (unhealthyMailboxCount / mailboxCount) * 100;
        if (unhealthyPct >= 75) {
            signals.push({
                type: 'mailbox_health',
                severity: 'critical',
                message: `${unhealthyMailboxCount}/${mailboxCount} mailboxes are unhealthy (${unhealthyPct.toFixed(0)}%)`,
                score_impact: 40
            });
            totalRiskScore += 40;
        } else if (unhealthyPct >= 50) {
            signals.push({
                type: 'mailbox_health',
                severity: 'high',
                message: `${unhealthyMailboxCount}/${mailboxCount} mailboxes are unhealthy (${unhealthyPct.toFixed(0)}%)`,
                score_impact: 25
            });
            totalRiskScore += 25;
        } else if (unhealthyPct >= 25) {
            signals.push({
                type: 'mailbox_health',
                severity: 'medium',
                message: `${unhealthyMailboxCount}/${mailboxCount} mailboxes are unhealthy (${unhealthyPct.toFixed(0)}%)`,
                score_impact: 15
            });
            totalRiskScore += 15;
        }
    }

    // Mailboxes in cooldown
    if (mailboxesInCooldown > 0) {
        const cooldownPct = (mailboxesInCooldown / mailboxCount) * 100;
        if (cooldownPct >= 50) {
            signals.push({
                type: 'cooldown',
                severity: 'high',
                message: `${mailboxesInCooldown}/${mailboxCount} mailboxes in cooldown (${cooldownPct.toFixed(0)}%)`,
                score_impact: 30
            });
            totalRiskScore += 30;
        } else if (cooldownPct >= 25) {
            signals.push({
                type: 'cooldown',
                severity: 'medium',
                message: `${mailboxesInCooldown}/${mailboxCount} mailboxes in cooldown (${cooldownPct.toFixed(0)}%)`,
                score_impact: 20
            });
            totalRiskScore += 20;
        }
    }

    // ── Signal 3: Mailbox Bounce Rate (informational — campaigns are NOT paused on bounce rate) ──
    // NOTE: Bounce rate is tracked per-mailbox. Campaign-level avg is shown for awareness only.
    // Campaigns only pause when ALL mailboxes are paused/removed, never on bounce rate.
    if (avgBounceRate >= 10) {
        signals.push({
            type: 'bounce_rate',
            severity: 'high',
            message: `Mailbox avg bounce rate: ${avgBounceRate.toFixed(1)}%. Individual mailboxes may auto-pause at 3%.`,
            score_impact: 20
        });
        totalRiskScore += 20;
    } else if (avgBounceRate >= 5) {
        signals.push({
            type: 'bounce_rate',
            severity: 'medium',
            message: `Mailbox avg bounce rate: ${avgBounceRate.toFixed(1)}%. Monitor individual mailbox health.`,
            score_impact: 10
        });
        totalRiskScore += 10;
    } else if (avgBounceRate >= 3) {
        signals.push({
            type: 'bounce_rate',
            severity: 'low',
            message: `Mailbox avg bounce rate: ${avgBounceRate.toFixed(1)}%. Some mailboxes approaching 3% auto-pause threshold.`,
            score_impact: 5
        });
        totalRiskScore += 5;
    }

    // ── Signal 4: Domain Health ──
    const domains = new Map<string, any>();
    for (const mailbox of campaign.mailboxes) {
        const domain = mailbox.domain;
        if (domain && !domains.has(domain.id)) {
            domains.set(domain.id, domain);
        }
    }

    let unhealthyDomainCount = 0;
    for (const domain of domains.values()) {
        if (domain.status !== 'healthy') {
            unhealthyDomainCount++;
        }
    }

    if (unhealthyDomainCount > 0) {
        const domainPct = (unhealthyDomainCount / domains.size) * 100;
        if (domainPct >= 50) {
            signals.push({
                type: 'domain_health',
                severity: 'high',
                message: `${unhealthyDomainCount}/${domains.size} domains are unhealthy (${domainPct.toFixed(0)}%)`,
                score_impact: 25
            });
            totalRiskScore += 25;
        } else {
            signals.push({
                type: 'domain_health',
                severity: 'medium',
                message: `${unhealthyDomainCount}/${domains.size} domains are unhealthy (${domainPct.toFixed(0)}%)`,
                score_impact: 15
            });
            totalRiskScore += 15;
        }
    }

    // ── Calculate Stall Probability and ETA ──
    // Probability increases with risk score
    const stallProbability = Math.min(totalRiskScore / 100, 1);

    // Estimate time to stall based on signal severity
    let timeToStallHours: number | null = null;
    if (totalRiskScore >= RISK_THRESHOLDS.CRITICAL) {
        timeToStallHours = 6; // Critical: stall likely within 6 hours
    } else if (totalRiskScore >= RISK_THRESHOLDS.HIGH) {
        timeToStallHours = 24; // High: stall likely within 24 hours
    } else if (totalRiskScore >= RISK_THRESHOLDS.MEDIUM) {
        timeToStallHours = 48; // Medium: stall possible within 48 hours
    }

    // ── Generate Recommendations ──
    const recommendations: string[] = [];
    const structuredRecs: Recommendation[] = [];

    // Collect unhealthy mailbox/domain IDs for actionable recommendations
    const unhealthyMailboxIds = campaign.mailboxes
        .filter(m => m.status !== 'healthy')
        .map(m => m.id);
    const unhealthyDomainIds = Array.from(domains.entries())
        .filter(([, d]) => d.status !== 'healthy')
        .map(([id]) => id);

    if (mailboxCount <= 2) {
        recommendations.push('Add more mailboxes to this campaign for redundancy');
        structuredRecs.push({
            action: 'add_mailboxes',
            label: 'Add more mailboxes for redundancy',
            campaign_id: campaignId
        });
    }

    if (unhealthyMailboxCount > 0) {
        recommendations.push('Remove unhealthy mailboxes and replace with healthy ones');
        structuredRecs.push({
            action: 'remove_unhealthy',
            label: `Remove ${unhealthyMailboxCount} unhealthy mailbox${unhealthyMailboxCount > 1 ? 'es' : ''}`,
            campaign_id: campaignId,
            mailbox_ids: unhealthyMailboxIds
        });
    }

    if (mailboxesInCooldown > 0) {
        recommendations.push('Wait for mailboxes to exit cooldown or add additional mailboxes');
        structuredRecs.push({
            action: 'wait_cooldown',
            label: `${mailboxesInCooldown} mailbox${mailboxesInCooldown > 1 ? 'es' : ''} in cooldown — add more or wait`,
            campaign_id: campaignId
        });
    }

    if (avgBounceRate >= 5) {
        recommendations.push('Investigate bounce causes and pause campaign if necessary');
        structuredRecs.push({
            action: 'investigate_bounces',
            label: `Investigate bounces (avg ${avgBounceRate.toFixed(1)}%)`,
            campaign_id: campaignId
        });
    }

    if (unhealthyDomainCount > 0) {
        recommendations.push('Address domain health issues before continuing campaign');
        structuredRecs.push({
            action: 'fix_domains',
            label: `Fix ${unhealthyDomainCount} unhealthy domain${unhealthyDomainCount > 1 ? 's' : ''}`,
            campaign_id: campaignId,
            domain_ids: unhealthyDomainIds
        });
    }

    if (signals.length === 0) {
        recommendations.push('Campaign health looks good - no immediate action needed');
        structuredRecs.push({
            action: 'no_action',
            label: 'No action needed',
            campaign_id: campaignId
        });
    }

    const riskLevel = getRiskLevel(totalRiskScore);

    return {
        campaign_id: campaignId,
        campaign_name: campaign.name || 'Unnamed Campaign',
        risk_score: Math.min(totalRiskScore, 100),
        risk_level: riskLevel,
        stall_probability: stallProbability,
        time_to_stall_hours: timeToStallHours,
        signals,
        recommended_actions: recommendations,
        recommendations: structuredRecs
    };
}

/**
 * Run predictive analysis on all active campaigns for an organization.
 */
export const analyzePredictiveRisks = async (
    organizationId: string
): Promise<PredictiveReport> => {
    logger.info(`[PREDICTIVE] Running analysis for org ${organizationId}`);

    const campaigns = await prisma.campaign.findMany({
        where: {
            organization_id: organizationId,
            status: 'active'
        },
        select: {
            id: true,
            name: true
        }
    });

    const campaignRisks: CampaignRiskScore[] = [];

    for (const campaign of campaigns) {
        const risk = await analyzeCampaignRisk(organizationId, campaign.id);
        if (risk) {
            campaignRisks.push(risk);
        }
    }

    // Sort by risk score (highest first)
    campaignRisks.sort((a, b) => b.risk_score - a.risk_score);

    const atRiskCampaigns = campaignRisks.filter(c => c.risk_level !== 'low');
    const highRiskCampaigns = campaignRisks.filter(c => c.risk_level === 'high');
    const criticalRiskCampaigns = campaignRisks.filter(c => c.risk_level === 'critical');

    const report: PredictiveReport = {
        timestamp: new Date(),
        campaigns_analyzed: campaignRisks.length,
        at_risk_campaigns: atRiskCampaigns.length,
        high_risk_campaigns: highRiskCampaigns.length,
        critical_risk_campaigns: criticalRiskCampaigns.length,
        campaign_risks: campaignRisks
    };

    logger.info(`[PREDICTIVE] Analysis complete: ${criticalRiskCampaigns.length} critical, ${highRiskCampaigns.length} high risk`);

    return report;
};

/**
 * Send proactive alerts for high-risk campaigns.
 * Should be called periodically (e.g., every 4 hours).
 */
export const sendPredictiveAlerts = async (organizationId: string): Promise<void> => {
    logger.info(`[PREDICTIVE] Checking for campaigns to alert on`);

    const report = await analyzePredictiveRisks(organizationId);

    // Alert on critical and high risk campaigns
    const campaignsToAlert = report.campaign_risks.filter(
        c => c.risk_level === 'critical' || c.risk_level === 'high'
    );

    for (const campaign of campaignsToAlert) {
        // Check if we've already sent a recent alert for this campaign
        const recentAlert = await prisma.notification.findFirst({
            where: {
                organization_id: organizationId,
                title: {
                    contains: campaign.campaign_name
                },
                type: 'WARNING',
                created_at: {
                    gte: new Date(Date.now() - 24 * 60 * 60 * 1000) // Last 24 hours
                }
            }
        });

        if (recentAlert) {
            logger.info(`[PREDICTIVE] Skipping alert for ${campaign.campaign_name} - recent alert exists`);
            continue;
        }

        // Create notification
        const message = campaign.time_to_stall_hours
            ? `Campaign may stall within ${campaign.time_to_stall_hours} hours. ${campaign.signals.length} warning signals detected.`
            : `Campaign health degrading. ${campaign.signals.length} warning signals detected.`;

        await notificationService.createNotification(organizationId, {
            type: campaign.risk_level === 'critical' ? 'ERROR' : 'WARNING',
            title: `⚠️ Campaign At Risk: ${campaign.campaign_name}`,
            message
        });

        // Send Slack alert
        const signalSummary = campaign.signals
            .map(s => `• ${s.message}`)
            .join('\n');
        const actionSummary = campaign.recommended_actions
            .map(a => `• ${a}`)
            .join('\n');

        SlackAlertService.sendAlert({
            organizationId,
            eventType: 'predictive_risk',
            entityId: campaign.campaign_id,
            severity: campaign.risk_level === 'critical' ? 'critical' : 'warning',
            title: `⚠️ Campaign At Risk: ${campaign.campaign_name}`,
            message: [
                `*Risk Score:* ${campaign.risk_score}/100 (${campaign.risk_level.toUpperCase()})`,
                campaign.time_to_stall_hours ? `*Est. Time to Stall:* ~${campaign.time_to_stall_hours}h` : '',
                `*Stall Probability:* ${(campaign.stall_probability * 100).toFixed(0)}%`,
                '',
                '*Warning Signals:*',
                signalSummary,
                '',
                '*Recommended Actions:*',
                actionSummary
            ].filter(Boolean).join('\n')
        }).catch(err => logger.warn('[PREDICTIVE] Non-fatal Slack alert error', { error: String(err) }));

        logger.info(`[PREDICTIVE] Sent alert for campaign ${campaign.campaign_name} (risk: ${campaign.risk_level})`);
    }
};

/**
 * Apply a structured recommendation for a campaign.
 */
export const applyRecommendation = async (
    organizationId: string,
    recommendation: Recommendation
): Promise<{ success: boolean; message: string }> => {
    logger.info(`[PREDICTIVE] Applying recommendation: ${recommendation.action} for campaign ${recommendation.campaign_id}`);

    try {
        switch (recommendation.action) {
            case 'remove_unhealthy': {
                if (!recommendation.mailbox_ids || recommendation.mailbox_ids.length === 0) {
                    return { success: false, message: 'No unhealthy mailboxes to remove' };
                }
                // Disconnect unhealthy mailboxes from the campaign
                for (const mailboxId of recommendation.mailbox_ids) {
                    await prisma.campaign.update({
                        where: { id: recommendation.campaign_id },
                        data: {
                            mailboxes: {
                                disconnect: { id: mailboxId }
                            }
                        }
                    });
                }
                const count = recommendation.mailbox_ids.length;
                const removeMsg = `Removed ${count} unhealthy mailbox${count > 1 ? 'es' : ''} from campaign`;

                SlackAlertService.sendAlert({
                    organizationId,
                    eventType: 'predictive_action_remove',
                    entityId: recommendation.campaign_id,
                    severity: 'warning',
                    title: '🔮 Predictive Action: Unhealthy Mailboxes Removed',
                    message: `${removeMsg}\n*Campaign:* ${recommendation.campaign_id}`
                }).catch(err => logger.warn('[PREDICTIVE] Non-fatal Slack alert error', { error: String(err) }));

                return { success: true, message: removeMsg };
            }

            case 'add_mailboxes': {
                // Find healthy, underutilized mailboxes in the org not already in this campaign
                const campaign = await prisma.campaign.findUnique({
                    where: { id: recommendation.campaign_id },
                    select: { mailboxes: { select: { id: true } } }
                });
                const existingIds = campaign?.mailboxes.map(m => m.id) || [];

                const available = await prisma.mailbox.findMany({
                    where: {
                        organization_id: organizationId,
                        status: 'healthy',
                        id: { notIn: existingIds }
                    },
                    orderBy: { created_at: 'asc' },
                    take: 3,
                    select: { id: true, email: true }
                });

                if (available.length === 0) {
                    return { success: false, message: 'No healthy mailboxes available to add' };
                }

                for (const mb of available) {
                    await prisma.campaign.update({
                        where: { id: recommendation.campaign_id },
                        data: {
                            mailboxes: { connect: { id: mb.id } }
                        }
                    });
                }

                const emails = available.map(m => m.email).join(', ');
                const addMsg = `Added ${available.length} mailbox${available.length > 1 ? 'es' : ''}: ${emails}`;

                SlackAlertService.sendAlert({
                    organizationId,
                    eventType: 'predictive_action_add',
                    entityId: recommendation.campaign_id,
                    severity: 'info',
                    title: '🔮 Predictive Action: Mailboxes Added',
                    message: `${addMsg}\n*Campaign:* ${recommendation.campaign_id}`
                }).catch(err => logger.warn('[PREDICTIVE] Non-fatal Slack alert error', { error: String(err) }));

                return { success: true, message: addMsg };
            }

            case 'investigate_bounces': {
                // Navigate user to campaign — no automated action, just acknowledge
                return {
                    success: true,
                    message: 'Navigate to the campaign to review bounce details and take action'
                };
            }

            case 'fix_domains': {
                // Navigate user to domains — no automated action
                return {
                    success: true,
                    message: 'Navigate to Domains page to address health issues'
                };
            }

            case 'wait_cooldown':
            case 'no_action':
                return { success: true, message: 'No automated action required' };

            default:
                return { success: false, message: `Unknown action: ${recommendation.action}` };
        }
    } catch (error: any) {
        logger.error(`[PREDICTIVE] Failed to apply recommendation:`, error);
        return { success: false, message: `Failed: ${error.message}` };
    }
};
