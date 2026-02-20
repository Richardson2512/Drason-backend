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

interface CampaignRiskScore {
    campaign_id: string;
    campaign_name: string;
    risk_score: number; // 0-100, higher = more risk
    risk_level: 'low' | 'medium' | 'high' | 'critical';
    stall_probability: number; // 0-1, probability of stalling in next 48h
    time_to_stall_hours: number | null; // Estimated hours until stall (if trending toward stall)
    signals: RiskSignal[];
    recommended_actions: string[];
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
                    mailbox: {
                        include: {
                            domain: true,
                            metrics: true
                        }
                    }
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

    for (const relation of campaign.mailboxes) {
        const mailbox = relation.mailbox;

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

    // ── Signal 3: Bounce Rate ──
    if (avgBounceRate >= 10) {
        signals.push({
            type: 'bounce_rate',
            severity: 'critical',
            message: `High bounce rate: ${avgBounceRate.toFixed(1)}% (threshold: 10%)`,
            score_impact: 35
        });
        totalRiskScore += 35;
    } else if (avgBounceRate >= 5) {
        signals.push({
            type: 'bounce_rate',
            severity: 'high',
            message: `Elevated bounce rate: ${avgBounceRate.toFixed(1)}% (threshold: 5%)`,
            score_impact: 20
        });
        totalRiskScore += 20;
    } else if (avgBounceRate >= 3) {
        signals.push({
            type: 'bounce_rate',
            severity: 'medium',
            message: `Warning: bounce rate ${avgBounceRate.toFixed(1)}% (approaching 5% threshold)`,
            score_impact: 10
        });
        totalRiskScore += 10;
    }

    // ── Signal 4: Domain Health ──
    const domains = new Map<string, any>();
    for (const relation of campaign.mailboxes) {
        const domain = relation.mailbox.domain;
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

    if (mailboxCount <= 2) {
        recommendations.push('Add more mailboxes to this campaign for redundancy');
    }

    if (unhealthyMailboxCount > 0) {
        recommendations.push('Remove unhealthy mailboxes and replace with healthy ones');
    }

    if (mailboxesInCooldown > 0) {
        recommendations.push('Wait for mailboxes to exit cooldown or add additional mailboxes');
    }

    if (avgBounceRate >= 5) {
        recommendations.push('Investigate bounce causes and pause campaign if necessary');
    }

    if (unhealthyDomainCount > 0) {
        recommendations.push('Address domain health issues before continuing campaign');
    }

    if (signals.length === 0) {
        recommendations.push('Campaign health looks good - no immediate action needed');
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
        recommended_actions: recommendations
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
            message,
            action_url: `/dashboard/campaigns?highlight=${campaign.campaign_id}`
        });

        logger.info(`[PREDICTIVE] Sent alert for campaign ${campaign.campaign_name} (risk: ${campaign.risk_level})`);
    }
};
