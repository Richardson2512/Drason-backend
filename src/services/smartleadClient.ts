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
 * Sync campaigns and mailboxes from Smartlead.
 */
export const syncSmartlead = async (organizationId: string): Promise<{
    campaigns: number;
    mailboxes: number;
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

    try {
        // Fetch campaigns (protected by circuit breaker)
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
                    last_synced_at: new Date()
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

        // Fetch email accounts (mailboxes) (protected by circuit breaker)
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

        await auditLogService.logAction({
            organizationId,
            entity: 'system',
            trigger: 'manual_sync',
            action: 'smartlead_synced',
            details: `Synced ${campaignCount} campaigns, ${mailboxCount} mailboxes`
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

        return { campaigns: campaignCount, mailboxes: mailboxCount };

    } catch (error: any) {
        await auditLogService.logAction({
            organizationId,
            entity: 'system',
            trigger: 'manual_sync',
            action: 'smartlead_sync_failed',
            details: error.message
        });
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
