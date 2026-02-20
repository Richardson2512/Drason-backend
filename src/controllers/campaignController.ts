/**
 * Campaign Controller
 *
 * Handles campaign-level operations including bulk actions
 */

import { Request, Response } from 'express';
import { prisma } from '../index';
import { getOrgId } from '../middleware/orgContext';
import {
    pauseSmartleadCampaign,
    resumeSmartleadCampaign,
    addMailboxToSmartleadCampaign,
    removeLeadFromSmartleadCampaign,
    addLeadToSmartleadCampaign
} from '../services/smartleadClient';
import { logger } from '../services/observabilityService';
import { logAction } from '../services/auditLogService';
import * as loadBalancingService from '../services/loadBalancingService';
import * as predictiveMonitoringService from '../services/predictiveMonitoringService';
import * as smartRoutingService from '../services/smartRoutingService';
/**
 * Pause all active campaigns for an organization
 * Used by health enforcement when critical issues detected
 *
 * @route POST /api/dashboard/campaigns/pause-all
 */
export const pauseAllCampaigns = async (req: Request, res: Response) => {
    try {
        const orgId = getOrgId(req);

        // Get all active campaigns
        const campaigns = await prisma.campaign.findMany({
            where: {
                organization_id: orgId,
                status: 'active'
            },
            select: {
                id: true,
                name: true
            }
        });

        if (campaigns.length === 0) {
            return res.json({
                success: true,
                total: 0,
                paused: 0,
                failed: 0,
                message: 'No active campaigns to pause'
            });
        }

        // Attempt to pause each campaign
        let pausedCount = 0;
        let failedCount = 0;

        for (const campaign of campaigns) {
            try {
                await pauseSmartleadCampaign(orgId, campaign.id);
                await prisma.campaign.update({
                    where: { id: campaign.id },
                    data: {
                        status: 'paused',
                        paused_reason: 'Health enforcement - all campaigns paused',
                        paused_at: new Date(),
                        paused_by: 'system'
                    }
                });
                pausedCount++;
            } catch (pauseError) {
                logger.error(`[CAMPAIGNS] Failed to pause campaign ${campaign.id}`, pauseError as Error);
                failedCount++;
            }
        }

        await logAction({
            organizationId: orgId,
            entity: 'organization',
            entityId: orgId,
            trigger: 'health_enforcement',
            action: 'pause_all_campaigns',
            details: `Paused ${pausedCount} of ${campaigns.length} campaigns. ${failedCount} failed.`
        });

        return res.json({
            success: true,
            total: campaigns.length,
            paused: pausedCount,
            failed: failedCount,
            message: `Successfully paused ${pausedCount} campaigns`
        });

    } catch (error: any) {
        logger.error('[CAMPAIGNS] Error pausing all campaigns', error);
        return res.status(500).json({
            success: false,
            error: 'Failed to pause campaigns',
            message: error.message
        });
    }
};

/**
 * Get stalled campaign context with safety checks
 *
 * @route GET /api/campaigns/:id/stalled-context
 */
export const getStalledCampaignContext = async (req: Request, res: Response) => {
    try {
        const orgId = getOrgId(req);
        const campaignId = req.params.id as string;

        // Get campaign with mailboxes and routing rules
        const campaign = await prisma.campaign.findUnique({
            where: { id: campaignId, organization_id: orgId },
            include: {
                mailboxes: {
                    include: {
                        domain: true
                    }
                },
                routingRules: true
            }
        });

        if (!campaign) {
            return res.status(404).json({ success: false, error: 'Campaign not found' });
        }

        // Count affected leads and get sample lead for smart matching
        const leadsCount = await prisma.lead.count({
            where: {
                organization_id: orgId,
                assigned_campaign_id: campaignId,
                status: { notIn: ['completed', 'bounced', 'unsubscribed'] }
            }
        });

        // Get a sample lead for smart campaign matching
        const sampleLead = await prisma.lead.findFirst({
            where: {
                organization_id: orgId,
                assigned_campaign_id: campaignId,
                status: { notIn: ['completed', 'bounced', 'unsubscribed'] }
            },
            select: {
                id: true,
                persona: true,
                lead_score: true
            }
        });

        // Get available healthy mailboxes
        const healthyMailboxes = await prisma.mailbox.findMany({
            where: {
                organization_id: orgId,
                status: { in: ['healthy', 'active'] },
                domain: {
                    status: { in: ['healthy', 'active'] }
                }
            },
            include: {
                domain: true,
                campaigns: {
                    select: {
                        id: true,
                        name: true
                    }
                }
            }
        });

        // Filter out mailboxes already in this campaign
        const attachedMailboxIds = campaign.mailboxes.map(m => m.id);
        const availableMailboxes = healthyMailboxes.filter(m => !attachedMailboxIds.includes(m.id));

        // Check mailbox capacity (warn if mailbox is in 5+ campaigns)
        const mailboxWarnings = availableMailboxes.map(mb => ({
            id: mb.id,
            email: mb.email,
            campaignCount: mb.campaigns.length,
            warning: mb.campaigns.length >= 5 ? 'This mailbox is already in 5+ campaigns' : null
        }));

        // Get target campaign options for rerouting
        const targetCampaigns = await prisma.campaign.findMany({
            where: {
                organization_id: orgId,
                id: { not: campaignId },
                status: 'active'
            },
            include: {
                routingRules: true,
                mailboxes: {
                    where: {
                        status: { in: ['healthy', 'active'] }
                    }
                }
            }
        });

        // Calculate ICP compatibility for rerouting
        const campaignPersonas = campaign.routingRules.map(r => r.persona.toLowerCase());
        const rerouteWarnings = targetCampaigns.map(tc => {
            const targetPersonas = tc.routingRules.map(r => r.persona.toLowerCase());
            const personaMatch = targetPersonas.some(tp => campaignPersonas.includes(tp));

            return {
                id: tc.id,
                name: tc.name,
                healthyMailboxCount: tc.mailboxes.length,
                personaMatch,
                warning: !personaMatch ? 'Target campaign targets different persona/ICP' : (
                    tc.mailboxes.length === 0 ? 'Target campaign has no healthy mailboxes' : null
                )
            };
        });

        // Calculate recovery ETA if mailboxes are in cooldown
        const recoveringMailboxes = await prisma.mailbox.findMany({
            where: {
                organization_id: orgId,
                status: { in: ['paused', 'recovering'] },
                cooldown_until: { gte: new Date() }
            },
            select: {
                id: true,
                email: true,
                cooldown_until: true,
                recovery_phase: true
            },
            orderBy: {
                cooldown_until: 'asc'
            }
        });

        const earliestRecovery = recoveringMailboxes[0]?.cooldown_until || null;
        const recoveryETA = earliestRecovery ?
            Math.ceil((new Date(earliestRecovery).getTime() - Date.now()) / (1000 * 60 * 60)) : null; // hours

        return res.json({
            success: true,
            context: {
                campaign: {
                    id: campaign.id,
                    name: campaign.name,
                    status: campaign.status,
                    paused_reason: campaign.paused_reason,
                    paused_at: campaign.paused_at,
                    paused_by: campaign.paused_by
                },
                leads: {
                    total: leadsCount,
                    sampleLeadId: sampleLead?.id || null,
                    samplePersona: sampleLead?.persona || null,
                    sampleScore: sampleLead?.lead_score || null,
                    message: leadsCount === 0 ? 'No active leads' : `${leadsCount} leads waiting`
                },
                mailboxes: {
                    available: mailboxWarnings.length,
                    warnings: mailboxWarnings.filter(w => w.warning),
                    list: mailboxWarnings
                },
                rerouteOptions: {
                    available: rerouteWarnings.length,
                    warnings: rerouteWarnings.filter(w => w.warning),
                    list: rerouteWarnings
                },
                recovery: {
                    eta_hours: recoveryETA,
                    recovering_count: recoveringMailboxes.length,
                    earliest_mailbox: recoveringMailboxes[0] || null,
                    message: recoveryETA ? `${recoveringMailboxes.length} mailboxes recovering, ETA: ${recoveryETA}h` : 'No mailboxes currently recovering'
                }
            }
        });

    } catch (error: any) {
        logger.error('[CAMPAIGNS] Error getting stalled campaign context', error);
        return res.status(500).json({
            success: false,
            error: 'Failed to get campaign context',
            message: error.message
        });
    }
};

/**
 * Resolve a stalled campaign (0 healthy mailboxes)
 *
 * @route POST /api/campaigns/:id/resolve-stalled
 */
export const resolveStalledCampaign = async (req: Request, res: Response) => {
    try {
        const orgId = getOrgId(req);
        const campaignId = req.params.id as string;
        const { resolutionType, selectedMailboxIds, targetCampaignId } = req.body;

        logger.info(`[CAMPAIGNS] Resolving stalled campaign ${campaignId}`, {
            organizationId: orgId,
            resolutionType,
            targetCampaignId
        });

        // Ensure campaign exists
        const campaign = await prisma.campaign.findUnique({
            where: { id: campaignId, organization_id: orgId },
            include: { mailboxes: true }
        });

        if (!campaign) {
            return res.status(404).json({ success: false, error: 'Campaign not found' });
        }

        // --- OPTION A: Add Healthy Mailboxes & Restart ---
        if (resolutionType === 'add_mailboxes') {
            if (!selectedMailboxIds || !Array.isArray(selectedMailboxIds) || selectedMailboxIds.length === 0) {
                return res.status(400).json({ success: false, error: 'Must provide selectedMailboxIds' });
            }

            let successCount = 0;
            for (const mailboxId of selectedMailboxIds) {
                const added = await addMailboxToSmartleadCampaign(orgId, campaignId, mailboxId);
                if (added) successCount++;
            }

            if (successCount === 0) {
                return res.status(500).json({ success: false, error: 'Failed to add any mailboxes to Smartlead' });
            }

            // Sync Database
            await prisma.campaign.update({
                where: { id: campaignId },
                data: {
                    status: 'active',
                    paused_reason: null,
                    paused_at: null,
                    // paused_by: null, // removing as it might not be generated depending on Prisma version
                    mailboxes: {
                        connect: selectedMailboxIds.map(id => ({ id: id as string }))
                    }
                }
            });

            // Start the campaign in Smartlead
            await resumeSmartleadCampaign(orgId, campaignId);

            await logAction({
                organizationId: orgId,
                entity: 'campaign',
                entityId: campaignId,
                trigger: 'user_action',
                action: 'stalled_campaign_resolved',
                details: `Resolved via Option A: Added ${successCount} mailboxes and restarted`
            });

            return res.json({ success: true, message: `Successfully added ${successCount} mailboxes and restarted campaign` });
        }

        // --- OPTION B: Reroute Leads to Different Campaign ---
        else if (resolutionType === 'reroute_leads') {
            if (!targetCampaignId) {
                return res.status(400).json({ success: false, error: 'Must provide targetCampaignId' });
            }

            // Get all active leads currently assigned to this stalled campaign
            const leadsToMove = await prisma.lead.findMany({
                where: {
                    organization_id: orgId,
                    assigned_campaign_id: campaignId,
                    status: { notIn: ['completed', 'bounced', 'unsubscribed'] }
                }
            });

            if (leadsToMove.length === 0) {
                return res.json({ success: true, message: 'No active leads to reroute' });
            }

            let reroutedCount = 0;
            for (const lead of leadsToMove) {
                // Remove from old
                await removeLeadFromSmartleadCampaign(orgId, campaignId, lead.email);

                // Add to new
                const added = await addLeadToSmartleadCampaign(orgId, targetCampaignId, {
                    email: lead.email,
                    first_name: lead.persona, // Basic mapping, full details would require Smartlead sync
                    last_name: ''
                });

                if (added) {
                    await prisma.lead.update({
                        where: { id: lead.id },
                        data: { assigned_campaign_id: targetCampaignId }
                    });
                    reroutedCount++;
                }
            }

            await logAction({
                organizationId: orgId,
                entity: 'campaign',
                entityId: campaignId,
                trigger: 'user_action',
                action: 'stalled_campaign_resolved',
                details: `Resolved via Option B: Rerouted ${reroutedCount} leads to campaign ${targetCampaignId}`
            });

            return res.json({
                success: true,
                message: `Successfully rerouted ${reroutedCount} leads to new campaign`
            });
        }

        // --- OPTION C: Manual Handling ---
        else if (resolutionType === 'manual') {
            // Just clear the internal stalled warning logic (we'll use a specific paused_reason to differentiate)
            await prisma.campaign.update({
                where: { id: campaignId },
                data: {
                    paused_reason: 'User handling manually'
                    // paused_by: 'user'
                }
            });

            await logAction({
                organizationId: orgId,
                entity: 'campaign',
                entityId: campaignId,
                trigger: 'user_action',
                action: 'stalled_campaign_resolved',
                details: 'Resolved via Option C: User acknowledged and is handling manually'
            });

            return res.json({ success: true, message: 'Campaign marked for manual handling' });
        }

        return res.status(400).json({ success: false, error: 'Invalid resolution_type' });

    } catch (error: any) {
        logger.error('[CAMPAIGNS] Error resolving stalled campaign', error);
        return res.status(500).json({
            success: false,
            error: 'Failed to resolve stalled campaign',
            message: error.message
        });
    }
};

/**
 * Export leads from a campaign as CSV
 *
 * @route GET /api/campaigns/:id/export-leads
 */
export const exportCampaignLeads = async (req: Request, res: Response) => {
    try {
        const orgId = getOrgId(req);
        const campaignId = req.params.id as string;

        // Get campaign
        const campaign = await prisma.campaign.findUnique({
            where: { id: campaignId, organization_id: orgId },
            select: { name: true }
        });

        if (!campaign) {
            return res.status(404).json({ success: false, error: 'Campaign not found' });
        }

        // Get all leads for this campaign
        const leads = await prisma.lead.findMany({
            where: {
                organization_id: orgId,
                assigned_campaign_id: campaignId
            },
            select: {
                email: true,
                persona: true,
                lead_score: true,
                status: true,
                emails_opened: true,
                emails_clicked: true,
                emails_replied: true,
                bounced: true,
                created_at: true,
                last_activity_at: true
            },
            orderBy: {
                created_at: 'desc'
            }
        });

        if (leads.length === 0) {
            return res.status(404).json({ success: false, error: 'No leads found in this campaign' });
        }

        // Generate CSV
        const headers = ['Email', 'Persona', 'Score', 'Status', 'Opens', 'Clicks', 'Replies', 'Bounced', 'Created', 'Last Activity'];
        const rows = leads.map(lead => [
            lead.email,
            lead.persona || '',
            lead.lead_score.toString(),
            lead.status,
            lead.emails_opened?.toString() || '0',
            lead.emails_clicked?.toString() || '0',
            lead.emails_replied?.toString() || '0',
            lead.bounced ? 'Yes' : 'No',
            lead.created_at.toISOString(),
            lead.last_activity_at?.toISOString() || 'Never'
        ]);

        const csv = [
            headers.join(','),
            ...rows.map(row => row.map(cell => `"${cell}"`).join(','))
        ].join('\n');

        // Set headers for file download
        const filename = `${campaign.name.replace(/[^a-z0-9]/gi, '_')}_leads_${new Date().toISOString().split('T')[0]}.csv`;
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

        await logAction({
            organizationId: orgId,
            entity: 'campaign',
            entityId: campaignId,
            trigger: 'user_action',
            action: 'export_leads',
            details: `Exported ${leads.length} leads to CSV`
        });

        return res.send(csv);

    } catch (error: any) {
        logger.error('[CAMPAIGNS] Error exporting leads', error);
        return res.status(500).json({
            success: false,
            error: 'Failed to export leads',
            message: error.message
        });
    }
};

/**
 * Archive a campaign
 *
 * @route POST /api/campaigns/:id/archive
 */
export const archiveCampaign = async (req: Request, res: Response) => {
    try {
        const orgId = getOrgId(req);
        const campaignId = req.params.id as string;

        // Get campaign
        const campaign = await prisma.campaign.findUnique({
            where: { id: campaignId, organization_id: orgId },
            select: { name: true, status: true }
        });

        if (!campaign) {
            return res.status(404).json({ success: false, error: 'Campaign not found' });
        }

        // Update campaign status to archived
        await prisma.campaign.update({
            where: { id: campaignId },
            data: {
                status: 'paused', // Keep as paused in Smartlead
                paused_reason: 'Archived by user',
                paused_at: new Date(),
                paused_by: 'user'
            }
        });

        // Optionally pause in Smartlead too
        try {
            await pauseSmartleadCampaign(orgId, campaignId);
        } catch (smartleadError) {
            logger.warn(`[CAMPAIGNS] Failed to pause archived campaign ${campaignId} in Smartlead`, smartleadError as Error);
            // Don't block the archive if Smartlead fails
        }

        await logAction({
            organizationId: orgId,
            entity: 'campaign',
            entityId: campaignId,
            trigger: 'user_action',
            action: 'archive_campaign',
            details: `Campaign "${campaign.name}" archived by user`
        });

        return res.json({
            success: true,
            message: `Campaign "${campaign.name}" has been archived`
        });

    } catch (error: any) {
        logger.error('[CAMPAIGNS] Error archiving campaign', error);
        return res.status(500).json({
            success: false,
            error: 'Failed to archive campaign',
            message: error.message
        });
    }
};

/**
 * Get load balancing analysis and suggestions
 *
 * @route GET /api/dashboard/campaigns/load-balancing
 */
export const getLoadBalancingSuggestions = async (req: Request, res: Response) => {
    try {
        const orgId = getOrgId(req);

        logger.info(`[CAMPAIGNS] Getting load balancing analysis for org ${orgId}`);

        const report = await loadBalancingService.analyzeLoadBalancing(orgId);

        return res.json({
            success: true,
            report
        });

    } catch (error: any) {
        logger.error('[CAMPAIGNS] Error getting load balancing suggestions', error);
        return res.status(500).json({
            success: false,
            error: 'Failed to get load balancing suggestions',
            message: error.message
        });
    }
};

/**
 * Apply a load balancing suggestion
 *
 * @route POST /api/dashboard/campaigns/load-balancing/apply
 */
export const applyLoadBalancingSuggestion = async (req: Request, res: Response) => {
    try {
        const orgId = getOrgId(req);
        const { suggestion } = req.body;

        if (!suggestion) {
            return res.status(400).json({
                success: false,
                error: 'Suggestion is required'
            });
        }

        logger.info(`[CAMPAIGNS] Applying load balancing suggestion for org ${orgId}`, { suggestion });

        const result = await loadBalancingService.applySuggestion(orgId, suggestion);

        return res.json({
            success: result.success,
            message: result.message
        });

    } catch (error: any) {
        logger.error('[CAMPAIGNS] Error applying load balancing suggestion', error);
        return res.status(500).json({
            success: false,
            error: 'Failed to apply suggestion',
            message: error.message
        });
    }
};

/**
 * Get predictive risk analysis for all active campaigns
 *
 * @route GET /api/dashboard/campaigns/predictive-risks
 */
export const getPredictiveRisks = async (req: Request, res: Response) => {
    try {
        const orgId = getOrgId(req);

        logger.info(`[CAMPAIGNS] Getting predictive risk analysis for org ${orgId}`);

        const report = await predictiveMonitoringService.analyzePredictiveRisks(orgId);

        return res.json({
            success: true,
            report
        });

    } catch (error: any) {
        logger.error('[CAMPAIGNS] Error getting predictive risks', error);
        return res.status(500).json({
            success: false,
            error: 'Failed to get predictive risks',
            message: error.message
        });
    }
};

/**
 * Trigger predictive alerts for high-risk campaigns
 *
 * @route POST /api/dashboard/campaigns/predictive-alerts
 */
export const triggerPredictiveAlerts = async (req: Request, res: Response) => {
    try {
        const orgId = getOrgId(req);

        logger.info(`[CAMPAIGNS] Triggering predictive alerts for org ${orgId}`);

        await predictiveMonitoringService.sendPredictiveAlerts(orgId);

        return res.json({
            success: true,
            message: 'Predictive alerts sent'
        });

    } catch (error: any) {
        logger.error('[CAMPAIGNS] Error triggering predictive alerts', error);
        return res.status(500).json({
            success: false,
            error: 'Failed to trigger predictive alerts',
            message: error.message
        });
    }
};

/**
 * Get smart campaign recommendations for a lead
 *
 * @route GET /api/dashboard/leads/:leadId/campaign-recommendations
 */
export const getSmartCampaignRecommendations = async (req: Request, res: Response) => {
    try {
        const orgId = getOrgId(req);
        const { leadId } = req.params;
        const {
            excludeCurrentCampaign = 'true',
            minMatchScore = '40',
            maxResults = '5'
        } = req.query;

        logger.info(`[CAMPAIGNS] Getting smart recommendations for lead ${leadId}`);

        const report = await smartRoutingService.findBestCampaignsForLead(orgId, Array.isArray(leadId) ? leadId[0] : leadId, {
            excludeCurrentCampaign: excludeCurrentCampaign === 'true',
            minMatchScore: parseInt(minMatchScore as string),
            maxResults: parseInt(maxResults as string)
        });

        return res.json({
            success: true,
            report
        });

    } catch (error: any) {
        logger.error('[CAMPAIGNS] Error getting smart recommendations', error);
        return res.status(500).json({
            success: false,
            error: 'Failed to get campaign recommendations',
            message: error.message
        });
    }
};

/**
 * Get smart campaign recommendations for multiple leads (batch)
 *
 * @route POST /api/dashboard/leads/campaign-recommendations
 */
export const getSmartCampaignRecommendationsBatch = async (req: Request, res: Response) => {
    try {
        const orgId = getOrgId(req);
        const { leadIds, options = {} } = req.body;

        if (!leadIds || !Array.isArray(leadIds) || leadIds.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'leadIds array is required'
            });
        }

        logger.info(`[CAMPAIGNS] Getting smart recommendations for ${leadIds.length} leads`);

        const reports = await smartRoutingService.findBestCampaignsForLeads(orgId, leadIds, options);

        return res.json({
            success: true,
            reports
        });

    } catch (error: any) {
        logger.error('[CAMPAIGNS] Error getting batch smart recommendations', error);
        return res.status(500).json({
            success: false,
            error: 'Failed to get campaign recommendations',
            message: error.message
        });
    }
};
