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

export const SMARTLEAD_API_BASE = 'https://server.smartlead.ai/api/v1';

/**
 * Get Smartlead API key for an organization.
 */
export async function getApiKey(organizationId: string): Promise<string | null> {
    const setting = await prisma.organizationSetting.findUnique({
        where: {
            organization_id_key: {
                organization_id: organizationId,
                key: 'SMARTLEAD_API_KEY'
            }
        }
    });

    if (!setting?.value) return null;

    // Decrypt the API key before returning (it's encrypted in the database)
    return decrypt(setting.value);
}


/**
 * Push a lead to a Smartlead campaign.
 *
 * Uses Smartlead API: POST /campaigns/{campaign_id}/leads
 * Max 100 leads per request, rate limit: 10 requests per 2 seconds
 */
export const pushLeadToCampaign = async (
    organizationId: string,
    campaignId: string,
    lead: {
        email: string;
        first_name?: string;
        last_name?: string;
        company?: string;
    }
): Promise<boolean> => {
    const apiKey = await getApiKey(organizationId);
    if (!apiKey) {
        throw new Error('Smartlead API key not configured');
    }

    try {
        // === IDEMPOTENCY CHECK ===
        // Check if lead already exists in this campaign in our DB
        const existingLead = await prisma.lead.findFirst({
            where: {
                organization_id: organizationId,
                email: lead.email,
                assigned_campaign_id: campaignId,
                status: LeadState.ACTIVE // Already pushed and active
            }
        });

        if (existingLead) {
            // Lead already pushed to this campaign - skip duplicate push
            logger.info(`[SMARTLEAD] Lead already exists in campaign (idempotent skip)`, {
                organizationId,
                campaignId,
                email: lead.email,
                leadId: existingLead.id
            });

            await auditLogService.logAction({
                organizationId,
                entity: 'lead',
                entityId: lead.email,
                trigger: 'execution',
                action: 'push_skipped_duplicate',
                details: `Lead already in campaign ${campaignId} (idempotent)`
            });

            return true; // Idempotent - treat as success
        }

        // Transform to Smartlead API format
        const smartleadLead = {
            email: lead.email,
            first_name: lead.first_name || '',
            last_name: lead.last_name || '',
            company_name: lead.company || '' // Smartlead expects 'company_name', not 'company'
        };

        // Rate limit: 10 requests per 2 seconds
        // Wrap API call in rate limiter to prevent 429 errors during bulk operations
        await smartleadRateLimiter.execute(() =>
            smartleadBreaker.call(() =>
                axios.post(
                    `${SMARTLEAD_API_BASE}/campaigns/${campaignId}/leads?api_key=${apiKey}`,
                    {
                        lead_list: [smartleadLead],
                        settings: {
                            ignore_global_block_list: false,
                            ignore_unsubscribe_list: false,
                            ignore_duplicate_leads_in_other_campaign: true
                        }
                    }
                )
            )
        );

        await auditLogService.logAction({
            organizationId,
            entity: 'lead',
            entityId: lead.email,
            trigger: 'execution',
            action: 'pushed_to_smartlead',
            details: `Pushed to campaign ${campaignId}`
        });

        logger.info(`[SMARTLEAD] Successfully pushed lead to campaign`, {
            organizationId,
            campaignId,
            email: lead.email
        });

        return true;
    } catch (error: any) {
        const errorMessage = error.response?.data?.message || error.message || '';
        const statusCode = error.response?.status;

        // === HANDLE DELETED CAMPAIGN (404 Error) ===
        const isCampaignNotFound = statusCode === 404 ||
            errorMessage.toLowerCase().includes('not found') ||
            errorMessage.toLowerCase().includes('campaign not found') ||
            errorMessage.toLowerCase().includes('does not exist');

        if (isCampaignNotFound) {
            // Campaign deleted in Smartlead - mark as inactive in our DB
            logger.error(`[SMARTLEAD] Campaign ${campaignId} not found in Smartlead (deleted externally)`, undefined, {
                organizationId,
                campaignId,
                email: lead.email,
                statusCode
            });

            try {
                // Mark campaign as inactive to prevent future routing
                await prisma.campaign.update({
                    where: { id: campaignId },
                    data: {
                        status: 'inactive',
                        paused_reason: 'Campaign deleted in Smartlead',
                        paused_at: new Date()
                    }
                });

                // Notify user about deleted campaign
                await notificationService.createNotification(organizationId, {
                    type: 'ERROR',
                    title: 'Campaign Deleted in Smartlead',
                    message: `Campaign ${campaignId} was deleted in Smartlead but still existed in Drason. It has been marked inactive. Please sync with Smartlead or update routing rules.`
                });

                await auditLogService.logAction({
                    organizationId,
                    entity: 'campaign',
                    entityId: campaignId,
                    trigger: 'external_deletion',
                    action: 'marked_inactive',
                    details: `Campaign not found in Smartlead (404 error). Marked as inactive to prevent routing failures.`
                });
            } catch (updateError: any) {
                logger.error('[SMARTLEAD] Failed to mark deleted campaign as inactive', updateError, {
                    organizationId,
                    campaignId
                });
            }

            return false; // Lead stays in HELD for potential rerouting
        }

        // === HANDLE DUPLICATE LEAD ===
        const isDuplicateError = errorMessage.toLowerCase().includes('duplicate') ||
            errorMessage.toLowerCase().includes('already exists') ||
            statusCode === 409; // Conflict status

        if (isDuplicateError) {
            // Lead already in Smartlead - treat as idempotent success
            logger.info(`[SMARTLEAD] Lead already in campaign (duplicate error caught)`, {
                organizationId,
                campaignId,
                email: lead.email,
                errorMessage
            });

            await auditLogService.logAction({
                organizationId,
                entity: 'lead',
                entityId: lead.email,
                trigger: 'execution',
                action: 'push_duplicate_caught',
                details: `Lead already in campaign ${campaignId} (Smartlead duplicate error)`
            });

            return true; // Idempotent - treat as success
        }

        // === HANDLE OTHER ERRORS ===
        logger.error(`[SMARTLEAD] Failed to push lead to campaign`, error, {
            organizationId,
            campaignId,
            email: lead.email,
            response: error.response?.data,
            status: statusCode
        });

        await auditLogService.logAction({
            organizationId,
            entity: 'lead',
            entityId: lead.email,
            trigger: 'execution',
            action: 'push_failed',
            details: `Failed to push to campaign ${campaignId}: ${error.message}`
        });
        return false;
    }
};

/**
 * ══════════════════════════════════════════════════════════════════════
 * WARMUP MANAGEMENT (AUTOMATED RECOVERY)
 * ══════════════════════════════════════════════════════════════════════
 */

/**
 * Enable or update warmup settings for a mailbox.
 * Used for automated recovery during RESTRICTED_SEND and WARM_RECOVERY phases.
 */
export const updateMailboxWarmup = async (
    organizationId: string,
    emailAccountId: number,
    settings: {
        warmup_enabled: boolean;
        total_warmup_per_day?: number;
        daily_rampup?: number;
        reply_rate_percentage?: number;
        warmup_key_id?: string;
    }
): Promise<{
    ok: boolean;
    message: string;
    emailAccountId: number;
    warmupKey: string;
}> => {
    const apiKey = await getApiKey(organizationId);
    if (!apiKey) {
        throw new Error('Smartlead API key not configured');
    }

    try {
        const response = await smartleadBreaker.call(() =>
            axios.post(
                `${SMARTLEAD_API_BASE}/email-accounts/${emailAccountId}/warmup`,
                settings,
                {
                    params: { api_key: apiKey }
                }
            )
        );

        logger.info('[SMARTLEAD-WARMUP] Updated warmup settings', {
            organizationId,
            emailAccountId,
            warmupEnabled: settings.warmup_enabled,
            warmupPerDay: settings.total_warmup_per_day,
            dailyRampup: settings.daily_rampup
        });

        return response.data;
    } catch (error: any) {
        logger.error('[SMARTLEAD-WARMUP] Failed to update warmup settings', error, {
            organizationId,
            emailAccountId,
            settings,
            response: error.response?.data
        });
        throw error;
    }
};

/**
 * Get warmup statistics for a mailbox.
 * Returns warmup progress, reputation score, and send counts.
 */
export const getWarmupStats = async (
    organizationId: string,
    emailAccountId: number
): Promise<{
    id: number;
    sent_count: string;
    spam_count: string;
    inbox_count: string;
    warmup_email_received_count: string;
    stats_by_date: Array<{
        id: number;
        date: string;
        sent_count: number;
        reply_count: number;
        save_from_spam_count: number;
    }>;
}> => {
    const apiKey = await getApiKey(organizationId);
    if (!apiKey) {
        throw new Error('Smartlead API key not configured');
    }

    try {
        const response = await smartleadBreaker.call(() =>
            axios.get(
                `${SMARTLEAD_API_BASE}/email-accounts/${emailAccountId}/warmup-stats`,
                {
                    params: { api_key: apiKey }
                }
            )
        );

        logger.info('[SMARTLEAD-WARMUP] Retrieved warmup stats', {
            organizationId,
            emailAccountId,
            totalSent: response.data.sent_count,
            spamCount: response.data.spam_count
        });

        return response.data;
    } catch (error: any) {
        logger.error('[SMARTLEAD-WARMUP] Failed to get warmup stats', error, {
            organizationId,
            emailAccountId,
            response: error.response?.data
        });
        throw error;
    }
};

/**
 * Get detailed email account information including warmup details.
 */
export const getEmailAccountDetails = async (
    organizationId: string,
    emailAccountId: number
): Promise<{
    id: number;
    from_email: string;
    warmup_details: {
        id: number;
        status: 'ACTIVE' | 'INACTIVE';
        reply_rate: number;
        warmup_key_id: string;
        total_sent_count: number;
        total_spam_count: number;
        warmup_max_count: number;
        warmup_min_count: number;
        is_warmup_blocked: boolean;
        max_email_per_day: number;
        warmup_reputation: string;
    };
}> => {
    const apiKey = await getApiKey(organizationId);
    if (!apiKey) {
        throw new Error('Smartlead API key not configured');
    }

    try {
        const response = await smartleadBreaker.call(() =>
            axios.get(
                `${SMARTLEAD_API_BASE}/email-accounts/${emailAccountId}`,
                {
                    params: { api_key: apiKey }
                }
            )
        );

        logger.info('[SMARTLEAD-WARMUP] Retrieved email account details', {
            organizationId,
            emailAccountId,
            warmupStatus: response.data.warmup_details?.status,
            warmupReputation: response.data.warmup_details?.warmup_reputation
        });

        return response.data;
    } catch (error: any) {
        logger.error('[SMARTLEAD-WARMUP] Failed to get email account details', error, {
            organizationId,
            emailAccountId,
            response: error.response?.data
        });
        throw error;
    }
};


