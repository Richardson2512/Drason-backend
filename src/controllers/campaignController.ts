/**
 * Campaign Controller
 *
 * Handles campaign-level operations including bulk actions
 */

import { Request, Response } from 'express';
import { prisma } from '../index';
import { getOrgId } from '../middleware/orgContext';
import { pauseSmartleadCampaign } from '../services/smartleadClient';
import { logger } from '../services/observabilityService';

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
                    paused_at: new Date(),
                    paused_by: 'system'
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
