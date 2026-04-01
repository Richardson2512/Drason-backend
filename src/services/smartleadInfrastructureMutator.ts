/**
 * Smartlead API Client
 * 
 * Handles integration with Smartlead API for campaign and mailbox sync.
 * API key is now organization-scoped for multi-tenancy.
 * 
 * Section 13 of Audit: API Rate Limits & External Constraints
 */

import axios from 'axios';
import { prisma } from '../index';
import { Request } from 'express';
import { getOrgId } from '../middleware/orgContext';
import * as auditLogService from './auditLogService';
import * as eventService from './eventService';
import * as assessmentService from './infrastructureAssessmentService';
import * as notificationService from './notificationService';
import { EventType, LeadState } from '../types';
import { logger } from './observabilityService';
import { smartleadBreaker } from '../utils/circuitBreaker';
import { smartleadRateLimiter } from '../utils/rateLimiter';
import { acquireLock, releaseLock } from '../utils/redis';
import { calculateEngagementScore, calculateFinalScore } from './leadScoringService';
import { syncProgressService } from './syncProgressService';
import { TIER_LIMITS } from './polarClient';
import { decrypt } from '../utils/encryption';
import { parse } from 'csv-parse/sync';

import { getApiKey, SMARTLEAD_API_BASE } from './smartleadClient';

// ============================================================================
// CAMPAIGN & MAILBOX CONTROL (Infrastructure Health Integration)
// ============================================================================

/**
 * Pause a Smartlead campaign.
 * Called when Superkabe detects infrastructure health degradation.
 */
export const pauseSmartleadCampaign = async (
    organizationId: string,
    campaignId: string
): Promise<boolean> => {
    const apiKey = await getApiKey(organizationId);
    if (!apiKey) {
        throw new Error('Smartlead API key not configured');
    }

    try {
        await smartleadRateLimiter.execute(() =>
            axios.post(
                `${SMARTLEAD_API_BASE}/campaigns/${campaignId}/status`,
                { status: 'PAUSED' },
                { params: { api_key: apiKey } }
            )
        );

        await auditLogService.logAction({
            organizationId,
            entity: 'campaign',
            entityId: campaignId,
            trigger: 'infrastructure_health',
            action: 'paused_in_smartlead',
            details: 'Campaign paused in Smartlead due to infrastructure health degradation'
        });

        logger.info(`[SMARTLEAD] Paused campaign ${campaignId} in Smartlead`, { organizationId });
        return true;
    } catch (error: any) {
        logger.error(`[SMARTLEAD] Failed to pause campaign ${campaignId}`, error, {
            organizationId,
            response: error.response?.data,
            status: error.response?.status
        });

        await auditLogService.logAction({
            organizationId,
            entity: 'campaign',
            entityId: campaignId,
            trigger: 'infrastructure_health',
            action: 'smartlead_pause_failed',
            details: `Failed to pause in Smartlead: ${error.message}`
        });

        return false;
    }
};

/**
 * Remove mailbox from all campaigns in Smartlead.
 * Called when mailbox exceeds bounce threshold for infrastructure hygiene.
 */
export const removeMailboxFromCampaigns = async (
    organizationId: string,
    mailboxId: string,
    smartleadEmailAccountId: number
): Promise<{
    success: boolean;
    campaignsRemoved: number;
    campaignsFailed: number;
}> => {
    const apiKey = await getApiKey(organizationId);
    if (!apiKey) {
        throw new Error('Smartlead API key not configured');
    }

    // Get all campaigns this mailbox is linked to
    const mailbox = await prisma.mailbox.findUnique({
        where: { id: mailboxId },
        select: {
            email: true,
            campaigns: {
                select: {
                    id: true,
                    name: true,
                    external_id: true
                }
            }
        }
    });

    if (!mailbox || !mailbox.campaigns || mailbox.campaigns.length === 0) {
        logger.info(`[SMARTLEAD] No campaigns found for mailbox ${mailboxId}`, { organizationId });
        return { success: true, campaignsRemoved: 0, campaignsFailed: 0 };
    }

    const campaigns = mailbox.campaigns;

    // Fetch Smartlead campaigns to get their IDs
    const smartleadCampaigns = await smartleadRateLimiter.execute(() =>
        axios.get(`${SMARTLEAD_API_BASE}/campaigns`, {
            params: { api_key: apiKey }
        })
    );

    let successCount = 0;
    let failCount = 0;

    // Remove from each campaign
    for (const campaign of smartleadCampaigns.data) {
        // Match by external_id (Smartlead campaign ID), fall back to name if external_id not set
        const ourCampaign = campaigns.find(c =>
            (c.external_id && c.external_id === String(campaign.id)) || c.name === campaign.name
        );
        if (!ourCampaign) continue;

        try {
            await smartleadRateLimiter.execute(() =>
                axios.delete(
                    `${SMARTLEAD_API_BASE}/campaigns/${campaign.id}/email-accounts`,
                    {
                        params: { api_key: apiKey },
                        data: {
                            email_account_ids: [smartleadEmailAccountId]
                        }
                    }
                )
            );

            successCount++;

            await auditLogService.logAction({
                organizationId,
                entity: 'mailbox',
                entityId: mailboxId,
                trigger: 'bounce_threshold',
                action: 'removed_from_smartlead_campaign',
                details: `Removed from campaign ${campaign.name} (Smartlead ID: ${campaign.id}) due to high bounce rate`
            });

            logger.info(`[SMARTLEAD] Removed mailbox from campaign ${campaign.name}`, {
                organizationId,
                mailboxId,
                smartleadCampaignId: campaign.id,
                smartleadEmailAccountId
            });
        } catch (error: any) {
            failCount++;
            logger.error(`[SMARTLEAD] Failed to remove mailbox from campaign ${campaign.name}`, error, {
                organizationId,
                mailboxId,
                smartleadCampaignId: campaign.id,
                response: error.response?.data
            });
        }
    }

    return {
        success: successCount > 0,
        campaignsRemoved: successCount,
        campaignsFailed: failCount
    };
};

/**
 * Resume a Smartlead campaign.
 * Called when Superkabe detects infrastructure health recovery.
 */
export const resumeSmartleadCampaign = async (
    organizationId: string,
    campaignId: string
): Promise<boolean> => {
    const apiKey = await getApiKey(organizationId);
    if (!apiKey) {
        throw new Error('Smartlead API key not configured');
    }

    try {
        await smartleadRateLimiter.execute(() =>
            axios.post(
                `${SMARTLEAD_API_BASE}/campaigns/${campaignId}/status`,
                { status: 'START' },
                { params: { api_key: apiKey } }
            )
        );

        await auditLogService.logAction({
            organizationId,
            entity: 'campaign',
            entityId: campaignId,
            trigger: 'infrastructure_health',
            action: 'resumed_in_smartlead',
            details: 'Campaign resumed in Smartlead after infrastructure recovery'
        });

        logger.info(`[SMARTLEAD] Resumed campaign ${campaignId} in Smartlead`, { organizationId });
        return true;
    } catch (error: any) {
        logger.error(`[SMARTLEAD] Failed to resume campaign ${campaignId}`, error, {
            organizationId,
            response: error.response?.data,
            status: error.response?.status
        });

        await auditLogService.logAction({
            organizationId,
            entity: 'campaign',
            entityId: campaignId,
            trigger: 'infrastructure_health',
            action: 'smartlead_resume_failed',
            details: `Failed to resume in Smartlead: ${error.message}`
        });

        return false;
    }
};

/**
 * Remove a mailbox from a Smartlead campaign.
 * Called when a mailbox is paused due to health degradation.
 */
export const removeMailboxFromSmartleadCampaign = async (
    organizationId: string,
    campaignId: string,
    mailboxId: string
): Promise<boolean> => {
    const apiKey = await getApiKey(organizationId);
    if (!apiKey) {
        throw new Error('Smartlead API key not configured');
    }

    try {
        // Smartlead API: DELETE /campaigns/{id}/email-accounts with body { email_account_ids: [...] }
        // mailboxId here is the Smartlead external_email_account_id (numeric string)
        const numericId = Number(mailboxId);
        if (isNaN(numericId)) {
            throw new Error(`Invalid Smartlead email account ID: ${mailboxId} — expected numeric external_email_account_id`);
        }

        await smartleadRateLimiter.execute(() =>
            axios.delete(
                `${SMARTLEAD_API_BASE}/campaigns/${campaignId}/email-accounts`,
                {
                    params: { api_key: apiKey },
                    data: { email_account_ids: [numericId] }
                }
            )
        );

        await auditLogService.logAction({
            organizationId,
            entity: 'mailbox',
            entityId: mailboxId,
            trigger: 'infrastructure_health',
            action: 'removed_from_smartlead_campaign',
            details: `Removed from campaign ${campaignId} in Smartlead`
        });

        logger.info(`[SMARTLEAD] Removed mailbox ${mailboxId} from campaign ${campaignId}`, { organizationId });
        return true;
    } catch (error: any) {
        logger.error(`[SMARTLEAD] Failed to remove mailbox ${mailboxId} from campaign ${campaignId}`, error, {
            organizationId,
            response: error.response?.data,
            status: error.response?.status
        });

        await auditLogService.logAction({
            organizationId,
            entity: 'mailbox',
            entityId: mailboxId,
            trigger: 'infrastructure_health',
            action: 'smartlead_remove_failed',
            details: `Failed to remove from Smartlead campaign: ${error.message}`
        });

        return false;
    }
};

/**
 * Add a mailbox back to a Smartlead campaign.
 * Called when a mailbox recovers to healthy status.
 */
export const addMailboxToSmartleadCampaign = async (
    organizationId: string,
    campaignId: string,
    mailboxId: string
): Promise<boolean> => {
    const apiKey = await getApiKey(organizationId);
    if (!apiKey) {
        throw new Error('Smartlead API key not configured');
    }

    try {
        // Add the email account back to the campaign
        // Smartlead API expects email_account_ids as an array (plural), not singular
        const numericId = parseInt(String(mailboxId), 10);
        await smartleadRateLimiter.execute(() =>
            axios.post(
                `${SMARTLEAD_API_BASE}/campaigns/${campaignId}/email-accounts`,
                { email_account_ids: [isNaN(numericId) ? mailboxId : numericId] },
                { params: { api_key: apiKey } }
            )
        );

        await auditLogService.logAction({
            organizationId,
            entity: 'mailbox',
            entityId: mailboxId,
            trigger: 'infrastructure_health',
            action: 'added_to_smartlead_campaign',
            details: `Added back to campaign ${campaignId} in Smartlead after recovery`
        });

        logger.info(`[SMARTLEAD] Added mailbox ${mailboxId} to campaign ${campaignId}`, { organizationId });
        return true;
    } catch (error: any) {
        logger.error(`[SMARTLEAD] Failed to add mailbox ${mailboxId} to campaign ${campaignId}`, error, {
            organizationId,
            response: error.response?.data,
            status: error.response?.status
        });

        await auditLogService.logAction({
            organizationId,
            entity: 'mailbox',
            entityId: mailboxId,
            trigger: 'infrastructure_health',
            action: 'smartlead_add_failed',
            details: `Failed to add to Smartlead campaign: ${error.message}`
        });

        return false;
    }
};

/**
 * Remove a lead from a Smartlead campaign.
 * Called during inter-campaign rerouting.
 */
export const removeLeadFromSmartleadCampaign = async (
    organizationId: string,
    campaignId: string,
    leadEmail: string
): Promise<boolean> => {
    const apiKey = await getApiKey(organizationId);
    if (!apiKey) {
        throw new Error('Smartlead API key not configured');
    }

    try {
        await smartleadBreaker.call(() =>
            axios.post(
                `${SMARTLEAD_API_BASE}/campaigns/${campaignId}/leads/delete`, // Smartlead uses POST /delete usually for bulk, or a specific delete endpoint
                {
                    lead_list: [leadEmail]
                },
                { params: { api_key: apiKey } }
            )
        );

        return true;
    } catch (error: any) {
        logger.error(`[SMARTLEAD] Failed to remove lead ${leadEmail} from campaign ${campaignId}`, error, {
            organizationId,
            response: error.response?.data
        });
        return false;
    }
};

/**
 * Add a lead to a Smartlead campaign (used for rerouting).
 */
export const addLeadToSmartleadCampaign = async (
    organizationId: string,
    campaignId: string,
    leadData: { email: string; first_name?: string; last_name?: string; company_name?: string }
): Promise<boolean> => {
    const apiKey = await getApiKey(organizationId);
    if (!apiKey) {
        throw new Error('Smartlead API key not configured');
    }

    try {
        await smartleadBreaker.call(() =>
            axios.post(
                `${SMARTLEAD_API_BASE}/campaigns/${campaignId}/leads`,
                {
                    lead_list: [leadData],
                    settings: {
                        ignore_global_block_list: false,
                        ignore_unsubscribe_list: false,
                        ignore_duplicate_leads_in_other_campaign: true
                    }
                },
                { params: { api_key: apiKey } }
            )
        );

        return true;
    } catch (error: any) {
        logger.error(`[SMARTLEAD] Failed to add lead ${leadData.email} to campaign ${campaignId}`, error, {
            organizationId,
            response: error.response?.data
        });
        return false;
    }
};

/**
 * Remove all mailboxes from a domain from their assigned Smartlead campaigns.
 * Called when an entire domain is paused.
 */
export const removeDomainMailboxesFromSmartlead = async (
    organizationId: string,
    domainId: string
): Promise<{ success: number; failed: number }> => {
    // Get all mailboxes for this domain with their campaign assignments
    const mailboxes = await prisma.mailbox.findMany({
        where: { domain_id: domainId },
        include: {
            campaigns: {
                select: { id: true, external_id: true, name: true }
            }
        }
    });

    let successCount = 0;
    let failedCount = 0;

    for (const mailbox of mailboxes) {
        const externalMailboxId = mailbox.external_email_account_id;
        if (!externalMailboxId) {
            logger.warn(`[SMARTLEAD] Mailbox ${mailbox.id} has no external_email_account_id, skipping platform removal`);
            continue;
        }

        // Remove this mailbox from all assigned campaigns
        for (const campaign of mailbox.campaigns) {
            const externalCampaignId = campaign.external_id || campaign.id;
            const removed = await removeMailboxFromSmartleadCampaign(
                organizationId,
                externalCampaignId,
                externalMailboxId
            );
            if (removed) {
                successCount++;
            } else {
                failedCount++;
            }
        }
    }

    logger.info(`[SMARTLEAD] Removed domain ${domainId} mailboxes from Smartlead campaigns`, {
        organizationId,
        domainId,
        successCount,
        failedCount,
        totalMailboxes: mailboxes.length
    });

    return { success: successCount, failed: failedCount };
};