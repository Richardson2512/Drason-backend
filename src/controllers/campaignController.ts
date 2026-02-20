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

        logger.info('[CAMPAIGNS] Pausing all campaigns', {
            organizationId: orgId,
            totalCampaigns: campaigns.length
        });

        // Pause each campaign in Smartlead
        const results = await Promise.allSettled(
            campaigns.map(c => pauseSmartleadCampaign(orgId, c.id))
        );

        // Count successes and failures
        const successCount = results.filter(r => r.status === 'fulfilled' && r.value === true).length;
        const failedCount = campaigns.length - successCount;

        // Update local campaign status for successful pauses
        const successfulIds = campaigns
            .filter((_, index) => results[index].status === 'fulfilled' && (results[index] as PromiseFulfilledResult<boolean>).value === true)
            .map(c => c.id);

        if (successfulIds.length > 0) {
            await prisma.campaign.updateMany({
                where: {
                    id: { in: successfulIds }
                },
                data: {
                    status: 'paused',
                    paused_reason: 'Infrastructure health enforcement',
                    paused_at: new Date()
                    // paused_by: 'system'
                }
            });
        }

        logger.info('[CAMPAIGNS] Pause all campaigns completed', {
            organizationId: orgId,
            total: campaigns.length,
            paused: successCount,
            failed: failedCount
        });

        return res.json({
            success: true,
            total: campaigns.length,
            paused: successCount,
            failed: failedCount,
            message: failedCount > 0
                ? `Paused ${successCount} of ${campaigns.length} campaigns. ${failedCount} failed.`
                : `Successfully paused all ${successCount} campaigns`
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
