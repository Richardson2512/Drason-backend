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
import { EventType } from '../types';
import { logger } from './observabilityService';
import { smartleadBreaker } from '../utils/circuitBreaker';

const SMARTLEAD_API_BASE = 'https://server.smartlead.ai/api/v1';

/**
 * Get Smartlead API key for an organization.
 */
async function getApiKey(organizationId: string): Promise<string | null> {
    const setting = await prisma.organizationSetting.findUnique({
        where: {
            organization_id_key: {
                organization_id: organizationId,
                key: 'SMARTLEAD_API_KEY'
            }
        }
    });
    return setting?.value || null;
}

/**
 * Sync campaigns, mailboxes, AND leads from Smartlead.
 */
export const syncSmartlead = async (organizationId: string): Promise<{
    campaigns: number;
    mailboxes: number;
    leads: number;
}> => {
    const apiKey = await getApiKey(organizationId);
    if (!apiKey) {
        throw new Error('Smartlead API key not configured');
    }

    // Store sync event
    await eventService.storeEvent({
        organizationId,
        eventType: EventType.SMARTLEAD_SYNC,
        entityType: 'system',
        payload: { action: 'sync_started' }
    });

    let campaignCount = 0;
    let mailboxCount = 0;
    let leadCount = 0;

    try {
        // ── 1. Fetch campaigns (protected by circuit breaker) ──
        const campaignsRes = await smartleadBreaker.call(() =>
            axios.get(`${SMARTLEAD_API_BASE}/campaigns?api_key=${apiKey}`)
        );
        const campaigns = campaignsRes.data || [];

        logger.info(`[DEBUG] Smartlead Campaigns Fetch: ${JSON.stringify({
            organizationId,
            apiKeyLen: apiKey?.length,
            count: campaigns.length,
            isArray: Array.isArray(campaigns),
            firstItem: campaigns.length > 0 ? campaigns[0] : null
        })}`);

        for (const campaign of campaigns) {
            await prisma.campaign.upsert({
                where: { id: campaign.id.toString() },
                update: {
                    name: campaign.name,
                    status: campaign.status || 'active',
                    last_synced_at: new Date(),
                    organization_id: organizationId // Force ownership update
                },
                create: {
                    id: campaign.id.toString(),
                    name: campaign.name,
                    status: campaign.status || 'active',
                    organization_id: organizationId
                }
            });
            campaignCount++;
        }

        // ── 2. Fetch email accounts (mailboxes) (protected by circuit breaker) ──
        const mailboxesRes = await smartleadBreaker.call(() =>
            axios.get(`${SMARTLEAD_API_BASE}/email-accounts?api_key=${apiKey}`)
        );
        const mailboxes = mailboxesRes.data || [];

        for (const mailbox of mailboxes) {
            // Extract domain from email
            const email = mailbox.from_email || mailbox.email || '';
            const domainName = email.split('@')[1] || 'unknown.com';

            // Ensure domain exists
            let domain = await prisma.domain.findFirst({
                where: {
                    organization_id: organizationId,
                    domain: domainName
                }
            });

            if (!domain) {
                domain = await prisma.domain.create({
                    data: {
                        domain: domainName,
                        status: 'healthy',
                        organization_id: organizationId
                    }
                });
            }

            // Upsert mailbox
            await prisma.mailbox.upsert({
                where: { id: mailbox.id.toString() },
                update: {
                    email,
                    status: mailbox.status === 'ACTIVE' ? 'healthy' : 'paused'
                },
                create: {
                    id: mailbox.id.toString(),
                    email,
                    status: mailbox.status === 'ACTIVE' ? 'healthy' : 'paused',
                    domain_id: domain.id,
                    organization_id: organizationId
                }
            });
            mailboxCount++;
        }

        // ── 3. Fetch leads for each campaign from Smartlead ──
        for (const campaign of campaigns) {
            const campaignId = campaign.id.toString();
            try {
                logger.info(`[LeadSync] Starting lead sync for campaign`, {
                    campaignId,
                    campaignName: campaign.name,
                    organizationId
                });

                let offset = 0;
                const limit = 100;
                let hasMore = true;
                let campaignLeadCount = 0;

                while (hasMore) {
                    // Log before API call
                    logger.debug(`[LeadSync] Fetching leads page`, { campaignId, offset, limit });

                    const leadsRes = await smartleadBreaker.call(() =>
                        axios.get(`${SMARTLEAD_API_BASE}/campaigns/${campaignId}/leads`, {
                            params: { api_key: apiKey, offset, limit }
                        })
                    );

                    const leadsData = leadsRes.data || [];
                    const leadsList = Array.isArray(leadsData) ? leadsData : (leadsData.data || []);

                    // Log API response structure
                    logger.info(`[LeadSync] API Response`, {
                        campaignId,
                        offset,
                        responseIsArray: Array.isArray(leadsData),
                        responseHasDataProp: !!leadsData.data,
                        leadsFound: leadsList.length,
                        rawResponseSample: offset === 0 ? JSON.stringify(leadsData).substring(0, 500) : undefined
                    });

                    if (leadsList.length === 0) {
                        hasMore = false;
                        break;
                    }

                    // Log first lead structure for debugging
                    if (offset === 0 && leadsList.length > 0) {
                        logger.info(`[LeadSync] First lead structure sample`, {
                            campaignId,
                            sample: leadsList[0],
                            keys: Object.keys(leadsList[0])
                        });
                    }

                    for (const lead of leadsList) {
                        // Try multiple field name variations for email
                        const email = lead.email ||
                                    lead.lead_email ||
                                    lead.Email ||
                                    lead.EMAIL ||
                                    lead.emailId ||
                                    lead.email_address ||
                                    (lead.custom_fields && lead.custom_fields.email) ||
                                    '';

                        if (!email) {
                            logger.warn(`[LeadSync] Skipping lead with no email`, {
                                campaignId,
                                leadKeys: Object.keys(lead),
                                leadSample: lead
                            });
                            continue;
                        }

                        const firstName = lead.first_name || lead.firstName || '';
                        const lastName = lead.last_name || lead.lastName || '';
                        const company = lead.company_name || lead.company || '';
                        const persona = company || 'general';

                        await prisma.lead.upsert({
                            where: {
                                organization_id_email: {
                                    organization_id: organizationId,
                                    email
                                }
                            },
                            update: {
                                assigned_campaign_id: campaignId,
                                updated_at: new Date()
                            },
                            create: {
                                email,
                                persona,
                                lead_score: 50, // Default neutral score
                                source: 'smartlead',
                                status: 'held',
                                health_classification: 'green',
                                assigned_campaign_id: campaignId,
                                organization_id: organizationId
                            }
                        });
                        leadCount++;
                        campaignLeadCount++;
                    }

                    // If we got fewer than the limit, no more pages
                    if (leadsList.length < limit) {
                        hasMore = false;
                    } else {
                        offset += limit;
                    }
                }

                logger.info(`Synced ${campaignLeadCount} leads for campaign ${campaignId}`, {
                    organizationId,
                    campaignId,
                    campaignName: campaign.name
                });
            } catch (leadError: any) {
                // Lead sync failure for one campaign doesn't block the others
                // CRITICAL: Log full error details
                logger.error(`Failed to sync leads for campaign ${campaignId}`, leadError, {
                    organizationId,
                    campaignId,
                    response: leadError.response?.data,
                    status: leadError.response?.status
                });
            }
        }

        await auditLogService.logAction({
            organizationId,
            entity: 'system',
            trigger: 'manual_sync',
            action: 'smartlead_synced',
            details: `Synced ${campaignCount} campaigns, ${mailboxCount} mailboxes, ${leadCount} leads`
        });

        // ── STRICT ORDER: Sync complete → Trigger Infrastructure Assessment ──
        // Assessment runs inline (not async) to maintain the strict ordering guarantee.
        // The execution gate remains locked until assessment completes.
        try {
            logger.info('Triggering infrastructure assessment after Smartlead sync', { organizationId });
            await assessmentService.assessInfrastructure(organizationId, 'onboarding');
            logger.info('Infrastructure assessment completed after sync', { organizationId });
        } catch (assessError: any) {
            // Assessment failure does NOT fail the sync — sync data is already persisted.
            // But the gate stays locked — manual re-assessment required.
            logger.error(`Post-sync assessment failed for org ${organizationId}: ${assessError.message}`);
            await auditLogService.logAction({
                organizationId,
                entity: 'system',
                trigger: 'infrastructure_assessment',
                action: 'post_sync_assessment_failed',
                details: assessError.message
            });
        }

        // ── Notify user of successful sync ──
        try {
            await notificationService.createNotification(organizationId, {
                type: 'SUCCESS',
                title: 'Smartlead Sync Complete',
                message: `Successfully synced ${campaignCount} campaigns, ${mailboxCount} mailboxes, and ${leadCount} leads from Smartlead.`,
            });
        } catch (notifError) {
            logger.warn('Failed to create sync success notification', { organizationId });
        }

        return { campaigns: campaignCount, mailboxes: mailboxCount, leads: leadCount };

    } catch (error: any) {
        await auditLogService.logAction({
            organizationId,
            entity: 'system',
            trigger: 'manual_sync',
            action: 'smartlead_sync_failed',
            details: error.message
        });

        // Notify user of sync failure
        try {
            await notificationService.createNotification(organizationId, {
                type: 'ERROR',
                title: 'Smartlead Sync Failed',
                message: `Smartlead sync failed: ${error.message}. Check your API key in Configuration and try again.`,
            });
        } catch (notifError) {
            logger.warn('Failed to create sync failure notification', { organizationId });
        }

        throw error;
    }
};

/**
 * Push a lead to a Smartlead campaign.
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
        await smartleadBreaker.call(() =>
            axios.post(
                `${SMARTLEAD_API_BASE}/campaigns/${campaignId}/leads?api_key=${apiKey}`,
                { lead_list: [lead] }
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

        return true;
    } catch (error: any) {
        await auditLogService.logAction({
            organizationId,
            entity: 'lead',
            entityId: lead.email,
            trigger: 'execution',
            action: 'push_failed',
            details: error.message
        });
        return false;
    }
};
