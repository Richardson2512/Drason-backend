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
    },
    options?: {
        assignedEmailAccounts?: string[];  // Email account IDs for ESP-aware mailbox pinning
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
        const smartleadLead: Record<string, any> = {
            email: lead.email,
            first_name: lead.first_name || '',
            last_name: lead.last_name || '',
            company_name: lead.company || '' // Smartlead expects 'company_name', not 'company'
        };

        // ESP-aware mailbox pinning: restrict which email accounts can send to this lead
        if (options?.assignedEmailAccounts?.length) {
            smartleadLead.assigned_email_accounts = options.assignedEmailAccounts;
        }

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
                    message: `Campaign ${campaignId} was deleted in Smartlead but still existed in Superkabe. It has been marked inactive. Please sync with Smartlead or update routing rules.`
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


// ============================================================================
// WEBHOOK MANAGEMENT
// ============================================================================

/**
 * List all webhooks registered for a campaign.
 * Uses Smartlead API: GET /campaigns/{campaign_id}/webhooks
 */
export const listCampaignWebhooks = async (
    organizationId: string,
    campaignId: string
): Promise<Array<{ id: number; name: string; webhook_url: string; event_types: string[] }>> => {
    const apiKey = await getApiKey(organizationId);
    if (!apiKey) throw new Error('Smartlead API key not configured');

    try {
        const response = await smartleadRateLimiter.execute(() =>
            smartleadBreaker.call(() =>
                axios.get(`${SMARTLEAD_API_BASE}/campaigns/${campaignId}/webhooks`, {
                    params: { api_key: apiKey }
                })
            )
        );
        return response.data || [];
    } catch (error: any) {
        logger.error('[SMARTLEAD-WEBHOOK-MGMT] Failed to list webhooks', error, {
            organizationId,
            campaignId,
            response: error.response?.data
        });
        return [];
    }
};

/**
 * Register a webhook for a campaign.
 * Uses Smartlead API: POST /campaigns/{campaign_id}/webhooks
 *
 * Event types: EMAIL_SENT, EMAIL_OPEN, EMAIL_LINK_CLICK, EMAIL_REPLY,
 *              LEAD_UNSUBSCRIBED, LEAD_CATEGORY_UPDATED,
 *              CAMPAIGN_STATUS_CHANGED, Email Bounce
 */
export const registerCampaignWebhook = async (
    organizationId: string,
    campaignId: string,
    webhookUrl: string,
    eventTypes?: string[]
): Promise<boolean> => {
    const apiKey = await getApiKey(organizationId);
    if (!apiKey) throw new Error('Smartlead API key not configured');

    const defaultEventTypes = [
        'EMAIL_SENT',
        'EMAIL_OPEN',
        'EMAIL_LINK_CLICK',
        'EMAIL_REPLY',
        'LEAD_UNSUBSCRIBED',
        'LEAD_CATEGORY_UPDATED',
        'CAMPAIGN_STATUS_CHANGED',
        'EMAIL_BOUNCE',
    ];

    try {
        await smartleadRateLimiter.execute(() =>
            smartleadBreaker.call(() =>
                axios.post(`${SMARTLEAD_API_BASE}/campaigns/${campaignId}/webhooks`, {
                    name: 'Superkabe Webhook',
                    webhook_url: webhookUrl,
                    event_types: eventTypes || defaultEventTypes,
                }, {
                    params: { api_key: apiKey }
                })
            )
        );

        logger.info('[SMARTLEAD-WEBHOOK-MGMT] Registered webhook for campaign', {
            organizationId,
            campaignId,
            webhookUrl,
            eventTypes: eventTypes || defaultEventTypes
        });

        return true;
    } catch (error: any) {
        logger.error('[SMARTLEAD-WEBHOOK-MGMT] Failed to register webhook', error, {
            organizationId,
            campaignId,
            webhookUrl,
            response: error.response?.data
        });
        return false;
    }
};

/**
 * Delete a webhook from a campaign.
 * Uses Smartlead API: DELETE /campaigns/{campaign_id}/webhooks/{webhook_id}
 */
export const deleteCampaignWebhook = async (
    organizationId: string,
    campaignId: string,
    webhookId: number
): Promise<boolean> => {
    const apiKey = await getApiKey(organizationId);
    if (!apiKey) throw new Error('Smartlead API key not configured');

    try {
        await smartleadRateLimiter.execute(() =>
            smartleadBreaker.call(() =>
                axios.delete(`${SMARTLEAD_API_BASE}/campaigns/${campaignId}/webhooks/${webhookId}`, {
                    params: { api_key: apiKey }
                })
            )
        );

        logger.info('[SMARTLEAD-WEBHOOK-MGMT] Deleted webhook', {
            organizationId,
            campaignId,
            webhookId
        });

        return true;
    } catch (error: any) {
        logger.error('[SMARTLEAD-WEBHOOK-MGMT] Failed to delete webhook', error, {
            organizationId,
            campaignId,
            webhookId,
            response: error.response?.data
        });
        return false;
    }
};

/**
 * Ensure webhooks are registered for all campaigns.
 * Checks existing webhooks and only registers where missing.
 * Called during sync to keep webhooks in sync with our infrastructure.
 */
export const ensureWebhooksRegistered = async (
    organizationId: string,
    campaignIds: string[],
    webhookUrl: string
): Promise<{ registered: number; skipped: number; failed: number }> => {
    let registered = 0;
    let skipped = 0;
    let failed = 0;

    for (const campaignId of campaignIds) {
        try {
            // Check if our webhook is already registered
            const existingWebhooks = await listCampaignWebhooks(organizationId, campaignId);
            const alreadyRegistered = existingWebhooks.some(
                wh => wh.webhook_url === webhookUrl
            );

            if (alreadyRegistered) {
                skipped++;
                continue;
            }

            const success = await registerCampaignWebhook(
                organizationId,
                campaignId,
                webhookUrl
            );

            if (success) {
                registered++;
            } else {
                failed++;
            }
        } catch (error: any) {
            failed++;
            logger.error('[SMARTLEAD-WEBHOOK-MGMT] Failed to ensure webhook for campaign', error, {
                organizationId,
                campaignId
            });
        }
    }

    logger.info('[SMARTLEAD-WEBHOOK-MGMT] Webhook registration complete', {
        organizationId,
        registered,
        skipped,
        failed,
        total: campaignIds.length
    });

    return { registered, skipped, failed };
};

// ============================================================================
// ANALYTICS & STATISTICS
// ============================================================================

/**
 * Get analytics by date for a campaign.
 * Uses Smartlead API: GET /campaigns/{campaign_id}/analytics-by-date
 * Returns date-bucketed historical analytics data.
 */
export const getAnalyticsByDate = async (
    organizationId: string,
    campaignId: string,
    startDate?: string,
    endDate?: string
): Promise<Array<{
    date: string;
    sent_count: number;
    open_count: number;
    click_count: number;
    reply_count: number;
    bounce_count: number;
    unsubscribe_count: number;
}>> => {
    const apiKey = await getApiKey(organizationId);
    if (!apiKey) throw new Error('Smartlead API key not configured');

    try {
        // Smartlead API requires start_date — default to 90 days ago
        const defaultStart = new Date();
        defaultStart.setDate(defaultStart.getDate() - 90);
        const params: any = {
            api_key: apiKey,
            start_date: startDate || defaultStart.toISOString().split('T')[0],
        };
        if (endDate) params.end_date = endDate;

        const response = await smartleadRateLimiter.execute(() =>
            axios.get(`${SMARTLEAD_API_BASE}/campaigns/${campaignId}/analytics-by-date`, {
                params
            })
        );

        return response.data || [];
    } catch (error: any) {
        logger.error('[SMARTLEAD-ANALYTICS] Failed to fetch analytics-by-date', error, {
            organizationId,
            campaignId,
            response: error.response?.data
        });
        return [];
    }
};

/**
 * Get campaign statistics with full email status support.
 * Uses Smartlead API: GET /campaigns/{campaign_id}/statistics
 *
 * @param emailStatus - Filter by status: 'sent', 'opened', 'clicked', 'replied', 'bounced', 'unsubscribed'
 */
export const getCampaignStatistics = async (
    organizationId: string,
    campaignId: string,
    emailStatus: string,
    offset: number = 0,
    limit: number = 100
): Promise<{ total_stats: number; data: any[] }> => {
    const apiKey = await getApiKey(organizationId);
    if (!apiKey) throw new Error('Smartlead API key not configured');

    try {
        const response = await smartleadRateLimiter.execute(() =>
            axios.get(`${SMARTLEAD_API_BASE}/campaigns/${campaignId}/statistics`, {
                params: {
                    api_key: apiKey,
                    email_status: emailStatus,
                    offset,
                    limit
                }
            })
        );

        return response.data || { total_stats: 0, data: [] };
    } catch (error: any) {
        logger.error('[SMARTLEAD-STATISTICS] Failed to fetch campaign statistics', error, {
            organizationId,
            campaignId,
            emailStatus,
            response: error.response?.data
        });
        return { total_stats: 0, data: [] };
    }
};

/**
 * Get all campaigns a lead is enrolled in.
 * Uses Smartlead API: GET /leads/{lead_id}/campaigns
 *
 * Useful for cross-campaign tracking and preventing over-emailing.
 */
export const getLeadCampaigns = async (
    organizationId: string,
    leadId: string
): Promise<Array<{ campaign_id: string; campaign_name: string; status: string }>> => {
    const apiKey = await getApiKey(organizationId);
    if (!apiKey) throw new Error('Smartlead API key not configured');

    try {
        const response = await smartleadRateLimiter.execute(() =>
            axios.get(`${SMARTLEAD_API_BASE}/leads/${leadId}/campaigns`, {
                params: { api_key: apiKey }
            })
        );

        return response.data || [];
    } catch (error: any) {
        logger.error('[SMARTLEAD-LEADS] Failed to fetch lead campaigns', error, {
            organizationId,
            leadId,
            response: error.response?.data
        });
        return [];
    }
};

/**
 * Fetch per-mailbox statistics for a campaign.
 * Uses Smartlead API: GET /campaigns/{campaign_id}/mailbox-statistics
 *
 * Returns per-mailbox sent/open/click/reply/bounce/unsubscribed counts
 * for the given campaign. Essential for populating accurate per-mailbox
 * historical stats without relying solely on webhooks.
 */
export interface MailboxStatisticsEntry {
    email_account_id: number;
    from_email: string;
    sent_count: number;
    open_count: number;
    click_count: number;
    reply_count: number;
    bounce_count: number;
    unsubscribed_count: number;
    sender_bounce_count: number;
    sent_time: string;
}

export const fetchCampaignMailboxStatistics = async (
    organizationId: string,
    campaignId: string
): Promise<MailboxStatisticsEntry[]> => {
    const apiKey = await getApiKey(organizationId);
    if (!apiKey) throw new Error('Smartlead API key not configured');

    const allEntries: MailboxStatisticsEntry[] = [];
    let offset = 0;
    const limit = 20; // Smartlead API enforces max 20 per page
    const MAX_PAGES = 50; // Safety cap: 20 * 50 = 1000 mailboxes max

    try {
        for (let page = 0; page < MAX_PAGES; page++) {
            // NOTE: No circuit breaker here — sync operations use rate limiter
            // retries (including transient error retries) instead. The breaker is
            // counterproductive for batch sync: one bad campaign would trip it and
            // block stats for all remaining campaigns.
            const response = await smartleadRateLimiter.execute(() =>
                axios.get(`${SMARTLEAD_API_BASE}/campaigns/${campaignId}/mailbox-statistics`, {
                    params: { api_key: apiKey, offset, limit }
                })
            );

            const data = response.data;

            let entries: MailboxStatisticsEntry[] = [];

            // API returns { ok: true, data: [...] }
            if (data?.ok && Array.isArray(data.data)) {
                entries = data.data;
            } else if (Array.isArray(data)) {
                // Fallback: direct array response
                entries = data;
            } else {
                logger.warn('[SMARTLEAD-MAILBOX-STATS] Unexpected response shape — no stats extracted', {
                    organizationId,
                    campaignId,
                    offset,
                    responseKeys: data ? Object.keys(data) : 'null',
                    responseType: typeof data,
                    responseSample: JSON.stringify(data)?.slice(0, 500),
                });
                break;
            }

            allEntries.push(...entries);

            // If we got fewer than the limit, we've reached the last page
            if (entries.length < limit) {
                break;
            }

            offset += limit;
        }

        logger.info('[SMARTLEAD-MAILBOX-STATS] Fetched mailbox statistics', {
            organizationId,
            campaignId,
            mailboxCount: allEntries.length,
            pagesRead: Math.ceil(offset / limit) + 1,
            emailAccountIds: allEntries.map(e => e.email_account_id),
        });

        return allEntries;
    } catch (error: any) {
        logger.error('[SMARTLEAD-MAILBOX-STATS] Failed to fetch mailbox statistics', error, {
            organizationId,
            campaignId,
            offset,
            entriesSoFar: allEntries.length,
            status: error.response?.status,
            responseData: JSON.stringify(error.response?.data)?.slice(0, 500),
        });
        // Return whatever we collected before the error — partial data is better than none
        return allEntries;
    }
};
