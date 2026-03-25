/**
 * EmailBison Platform Adapter
 *
 * Implements the PlatformAdapter interface for the EmailBison API.
 * Base URL: https://dedi.emailbison.com
 * Auth: Bearer token (stored as EMAILBISON_API_KEY in OrganizationSetting)
 *
 * API Mapping:
 *   Campaigns:  GET /api/campaigns
 *   Mailboxes:  GET /api/sender-emails
 *   Leads:      GET /api/campaigns/{id}/leads, GET /api/leads
 *   Warmup:     GET/PATCH /api/warmup/sender-emails
 *   Pause:   PATCH /api/campaigns/{id}/pause
 *   Resume:  PATCH /api/campaigns/{id}/resume
 *   Attach mailbox: POST /api/campaigns/{id}/attach-sender-emails
 *   Remove mailbox: DELETE /api/campaigns/{id}/remove-sender-emails
 */

import axios, { AxiosInstance } from 'axios';
import { SourcePlatform } from '@prisma/client';
import { prisma } from '../index';
import { logger } from '../services/observabilityService';
import { decrypt } from '../utils/encryption';
import { syncProgressService } from '../services/syncProgressService';
import * as assessmentService from '../services/infrastructureAssessmentService';
import { TIER_LIMITS } from '../services/polarClient';
import { acquireLock, releaseLock } from '../utils/redis';
import { emailbisonRateLimiter } from '../utils/rateLimiter';
import { emailbisonBreaker } from '../utils/circuitBreaker';
import {
    PlatformAdapter,
    SyncResult,
    MailboxDetails,
    WarmupSettings,
    LeadPayload,
    PushLeadResult,
} from './platformAdapter';
import { LeadState } from '../types';
import * as auditLogService from '../services/auditLogService';

const EMAILBISON_API_BASE = 'https://dedi.emailbison.com';

const SYNC_CONCURRENCY = 5;

/**
 * Paginate through an EmailBison list endpoint.
 * EmailBison defaults to 15 items per page. Response shape:
 *   { data: [...], links: { next }, meta: { current_page, last_page } }
 */
async function fetchAllPages<T>(
    client: AxiosInstance,
    path: string,
    label: string,
): Promise<T[]> {
    const allItems: T[] = [];
    let page = 1;
    const MAX_PAGES = 100; // Safety cap

    for (let i = 0; i < MAX_PAGES; i++) {
        const res = await emailbisonRateLimiter.execute(() =>
            emailbisonBreaker.call(() => client.get(path, { params: { page } }))
        );

        const data = res.data?.data || res.data || [];
        const items: T[] = Array.isArray(data) ? data : [];
        allItems.push(...items);

        // Check if there are more pages via meta or links
        const lastPage = res.data?.meta?.last_page;
        const nextLink = res.data?.links?.next;

        if (items.length === 0 || (lastPage && page >= lastPage) || !nextLink) {
            break;
        }

        page++;
    }

    logger.info(`[EmailBisonSync] ${label} fetched all pages`, {
        totalItems: allItems.length,
        pagesRead: page,
    });

    return allItems;
}

async function parallelChunked<T, R>(
    items: T[],
    concurrency: number,
    fn: (item: T, index: number) => Promise<R>
): Promise<PromiseSettledResult<R>[]> {
    const results: PromiseSettledResult<R>[] = [];
    for (let i = 0; i < items.length; i += concurrency) {
        const chunk = items.slice(i, i + concurrency);
        const chunkResults = await Promise.allSettled(
            chunk.map((item, j) => fn(item, i + j))
        );
        results.push(...chunkResults);
    }
    return results;
}

export class EmailBisonAdapter implements PlatformAdapter {
    readonly platform = SourcePlatform.emailbison;

    // ── AUTH ────────────────────────────────────────────────────────────

    private async getApiKey(organizationId: string): Promise<string | null> {
        const setting = await prisma.organizationSetting.findUnique({
            where: {
                organization_id_key: {
                    organization_id: organizationId,
                    key: 'EMAILBISON_API_KEY'
                }
            }
        });

        if (!setting?.value) return null;
        return decrypt(setting.value);
    }

    private async getClient(organizationId: string): Promise<AxiosInstance> {
        const apiKey = await this.getApiKey(organizationId);
        if (!apiKey) {
            throw new Error('EmailBison API key not configured');
        }

        return axios.create({
            baseURL: EMAILBISON_API_BASE,
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json',
            },
            timeout: 30000,
        });
    }

    // ── SYNC ───────────────────────────────────────────────────────────

    async sync(organizationId: string, sessionId?: string): Promise<SyncResult> {
        // Fail fast: validate API key before acquiring lock
        const apiKey = await this.getApiKey(organizationId);
        if (!apiKey) {
            throw new Error('EmailBison API key not configured. Please add your API key in Settings.');
        }

        // ── Redis mutex — prevents concurrent syncs for the same org ──
        const lockKey = `sync:emailbison:org:${organizationId}`;
        const acquired = await acquireLock(lockKey, 15 * 60); // 15 min TTL
        if (!acquired) {
            const errMsg = `EmailBison sync already in progress for organization ${organizationId}`;
            logger.warn(`[EmailBisonSync] ${errMsg}`);
            throw new Error(errMsg);
        }

        try {
        const client = await this.getClient(organizationId);

        let campaignCount = 0;
        let mailboxCount = 0;
        let leadCount = 0;

        const org = await prisma.organization.findUnique({
            where: { id: organizationId },
            select: {
                subscription_tier: true,
                subscription_status: true,
                current_domain_count: true,
                current_mailbox_count: true,
                current_lead_count: true,
            }
        });

        if (!org) throw new Error('Organization not found');

        const blockedStatuses = ['expired', 'past_due', 'canceled'];
        if (blockedStatuses.includes(org.subscription_status)) {
            throw new Error(`Cannot sync: subscription ${org.subscription_status}`);
        }

        const limits = TIER_LIMITS[org.subscription_tier] || TIER_LIMITS.trial;

        // ── 1. Fetch campaigns ─────────────────────────────────────

            if (sessionId) {
                syncProgressService.emitProgress(sessionId, 'campaigns', 'in_progress', { total: 0 });
            }

            // ── Issue D: Rate-limited API call (paginated — default 15/page) ──
            const campaigns = await fetchAllPages<any>(client, '/api/campaigns', 'Campaigns');

            logger.info('[EmailBisonSync] Fetched campaigns', {
                organizationId,
                count: campaigns.length,
            });

            if (sessionId) {
                syncProgressService.emitProgress(sessionId, 'campaigns', 'in_progress', {
                    current: 0,
                    total: campaigns.length,
                });
            }

            let campaignUpserts = [];
            for (let i = 0; i < campaigns.length; i++) {
                const campaign = campaigns[i];
                const externalId = campaign.id.toString();
                const internalId = `eb-${externalId}`;

                const totalSent = parseInt(String(campaign.emails_sent || 0));
                const totalBounced = parseInt(String(campaign.bounced || 0));
                const totalOpens = parseInt(String(campaign.opened || campaign.unique_opens || 0));
                const totalReplies = parseInt(String(campaign.replied || campaign.unique_replies || 0));
                const totalUnsubscribed = parseInt(String(campaign.unsubscribed || 0));

                const bounceRate = totalSent > 0 ? (totalBounced / totalSent) * 100 : 0;
                const openRate = totalSent > 0 ? (totalOpens / totalSent) * 100 : 0;
                const replyRate = totalSent > 0 ? (totalReplies / totalSent) * 100 : 0;

                // Map EmailBison status to internal status
                let status = 'active';
                const ebStatus = (campaign.status || '').toLowerCase();
                if (ebStatus === 'paused' || ebStatus === 'stopped') status = 'paused';
                else if (ebStatus === 'draft' || ebStatus === 'launching') status = 'draft';
                else if (ebStatus === 'completed') status = 'completed';

                campaignUpserts.push(
                    prisma.campaign.upsert({
                        where: { id: internalId },
                        update: {
                            name: campaign.name,
                            status,
                            source_platform: SourcePlatform.emailbison,
                            external_id: externalId,
                            bounce_rate: bounceRate,
                            total_sent: totalSent,
                            total_bounced: totalBounced,
                            open_count: totalOpens,
                            reply_count: totalReplies,
                            unsubscribed_count: totalUnsubscribed,
                            open_rate: openRate,
                            reply_rate: replyRate,
                            analytics_updated_at: new Date(),
                            last_synced_at: new Date(),
                            organization_id: organizationId,
                        },
                        create: {
                            id: internalId,
                            name: campaign.name,
                            status,
                            source_platform: SourcePlatform.emailbison,
                            external_id: externalId,
                            bounce_rate: bounceRate,
                            total_sent: totalSent,
                            total_bounced: totalBounced,
                            open_count: totalOpens,
                            reply_count: totalReplies,
                            unsubscribed_count: totalUnsubscribed,
                            open_rate: openRate,
                            reply_rate: replyRate,
                            analytics_updated_at: new Date(),
                            organization_id: organizationId,
                        },
                    })
                );

                campaignCount++;

                if (campaignUpserts.length >= 50 || i === campaigns.length - 1) {
                    await prisma.$transaction(campaignUpserts);
                    campaignUpserts = [];
                    if (sessionId) {
                        syncProgressService.emitProgress(sessionId, 'campaigns', 'in_progress', {
                            current: campaignCount,
                            total: campaigns.length,
                        });
                    }
                }
            }

            // ── 1b. Clean up stale campaigns deleted from EmailBison ──
            try {
                const emailbisonCampaignIds = new Set(campaigns.map((c: any) => `eb-${c.id}`));

                const dbCampaigns = await prisma.campaign.findMany({
                    where: {
                        organization_id: organizationId,
                        source_platform: SourcePlatform.emailbison,
                        status: { not: 'deleted' },
                    },
                    select: { id: true, name: true, status: true },
                });

                const staleCampaigns = dbCampaigns.filter(c => !emailbisonCampaignIds.has(c.id));

                if (staleCampaigns.length > 0) {
                    logger.info('[EmailBisonSync] Found campaigns deleted from EmailBison', {
                        organizationId,
                        count: staleCampaigns.length,
                        campaigns: staleCampaigns.map(c => ({ id: c.id, name: c.name, previousStatus: c.status })),
                    });

                    for (const stale of staleCampaigns) {
                        await prisma.campaign.update({
                            where: { id: stale.id },
                            data: {
                                status: 'deleted',
                                paused_reason: 'Deleted from EmailBison',
                                paused_at: new Date(),
                                paused_by: 'system',
                                mailboxes: { set: [] },
                            },
                        });

                        await prisma.stateTransition.create({
                            data: {
                                organization_id: organizationId,
                                entity_type: 'campaign',
                                entity_id: stale.id,
                                from_state: stale.status,
                                to_state: 'deleted',
                                reason: 'Campaign deleted from EmailBison — removed during sync',
                                triggered_by: 'sync',
                            },
                        });
                    }

                    logger.info('[EmailBisonSync] Marked stale campaigns as deleted', {
                        organizationId,
                        deletedCount: staleCampaigns.length,
                    });
                }
            } catch (cleanupErr: any) {
                logger.warn('[EmailBisonSync] Failed to clean up stale campaigns (non-fatal)', {
                    organizationId,
                    error: cleanupErr.message,
                });
            }

            if (sessionId) {
                syncProgressService.emitProgress(sessionId, 'campaigns', 'completed', { count: campaignCount });
                syncProgressService.emitProgress(sessionId, 'mailboxes', 'in_progress', { total: 0 });
            }

            // ── 2. Fetch sender-emails (mailboxes) ─────────────────────

            const mailboxes = await fetchAllPages<any>(client, '/api/sender-emails', 'Sender-emails');

            logger.info('[EmailBisonSync] Fetched sender-emails', {
                organizationId,
                count: mailboxes.length,
            });

            if (sessionId) {
                syncProgressService.emitProgress(sessionId, 'mailboxes', 'in_progress', {
                    current: 0,
                    total: mailboxes.length,
                });
            }

            const existingDomains = await prisma.domain.findMany({ where: { organization_id: organizationId } });
            const domainMap = new Map(existingDomains.map(d => [d.domain, d]));

            const existingMailboxes = await prisma.mailbox.findMany({
                where: { organization_id: organizationId },
                select: { id: true }
            });
            const existingMailboxSet = new Set(existingMailboxes.map(m => m.id));

            // NOTE: EmailBison's /api/sender-emails endpoint is for configuration only —
            // it does NOT expose per-mailbox bounce stats. Per-mailbox bounce counts
            // are tracked exclusively via the "Email Bounced" webhook handler
            // (emailbisonWebhookController.ts → bounceProcessingService.ts).
            // Historical per-lead bounces are detected via lead status during sync below.

            // Create domains for new email addresses
            const uniqueDomainNames = [...new Set(
                mailboxes.map((m: any) => (m.email || '').split('@')[1] || 'unknown.com')
            )];
            const newDomains = uniqueDomainNames.filter(d => !domainMap.has(d as string));

            if (newDomains.length > 0) {
                const domainsToCreate = [];
                for (const domainName of newDomains) {
                    if (org.current_domain_count >= limits.domains) {
                        logger.warn('[EmailBisonSync] Domain capacity reached', {
                            organizationId,
                            skippedDomain: domainName,
                        });
                        continue;
                    }
                    domainsToCreate.push({
                        domain: domainName as string,
                        status: 'healthy',
                        source_platform: SourcePlatform.emailbison,
                        organization_id: organizationId,
                    });
                    org.current_domain_count++;
                }
                if (domainsToCreate.length > 0) {
                    await prisma.domain.createMany({ data: domainsToCreate });
                    await prisma.organization.update({
                        where: { id: organizationId },
                        data: { current_domain_count: org.current_domain_count },
                    });
                    const newlyCreated = await prisma.domain.findMany({
                        where: { organization_id: organizationId, domain: { in: domainsToCreate.map(d => d.domain) } }
                    });
                    newlyCreated.forEach(d => domainMap.set(d.domain, d));
                }
            }

            let mailboxUpserts = [];
            let mailboxesToIncrement = 0;

            for (let i = 0; i < mailboxes.length; i++) {
                const mailbox = mailboxes[i];
                const email = mailbox.email || '';
                const domainName = email.split('@')[1] || 'unknown.com';
                const domain = domainMap.get(domainName);

                if (!domain) continue;

                const externalId = String(mailbox.id);
                const internalId = `eb-${externalId}`;

                const isNewMailbox = !existingMailboxSet.has(internalId);
                if (isNewMailbox) {
                    if (org.current_mailbox_count >= limits.mailboxes) {
                        logger.warn('[EmailBisonSync] Mailbox capacity reached', {
                            organizationId,
                            skippedEmail: email,
                        });
                        continue;
                    }
                    org.current_mailbox_count++;
                    mailboxesToIncrement++;
                }

                // Map EmailBison status
                const isConnected = (mailbox.status || '').toLowerCase() === 'connected';
                const mailboxStatus = isConnected ? 'healthy' : 'paused';

                const warmupEnabled = mailbox.warmup_enabled === true;

                mailboxUpserts.push(
                    prisma.mailbox.upsert({
                        where: { id: internalId },
                        update: {
                            email,
                            source_platform: SourcePlatform.emailbison,
                            external_email_account_id: externalId,
                            status: mailboxStatus,
                            smtp_status: isConnected,
                            imap_status: isConnected,
                            total_sent_count: mailbox.emails_sent_count || 0,
                            warmup_status: warmupEnabled ? 'enabled' : 'disabled',
                            warmup_limit: mailbox.daily_limit || 0,
                            last_activity_at: new Date(),
                        },
                        create: {
                            id: internalId,
                            email,
                            source_platform: SourcePlatform.emailbison,
                            external_email_account_id: externalId,
                            status: mailboxStatus,
                            smtp_status: isConnected,
                            imap_status: isConnected,
                            total_sent_count: mailbox.emails_sent_count || 0,
                            warmup_status: warmupEnabled ? 'enabled' : 'disabled',
                            warmup_limit: mailbox.daily_limit || 0,
                            domain_id: domain.id,
                            organization_id: organizationId,
                        },
                    })
                );

                mailboxCount++;

                if (mailboxUpserts.length >= 50 || i === mailboxes.length - 1) {
                    await prisma.$transaction(mailboxUpserts);
                    mailboxUpserts = [];
                    if (sessionId) {
                        syncProgressService.emitProgress(sessionId, 'mailboxes', 'in_progress', {
                            current: mailboxCount,
                            total: mailboxes.length,
                        });
                    }
                }
            }

            if (mailboxesToIncrement > 0) {
                await prisma.organization.update({
                    where: { id: organizationId },
                    data: { current_mailbox_count: org.current_mailbox_count },
                });
            }

            if (sessionId) {
                syncProgressService.emitProgress(sessionId, 'mailboxes', 'completed', { count: mailboxCount });
                syncProgressService.emitProgress(sessionId, 'leads', 'in_progress', { total: 0 });
            }

            // ── 3. Link campaigns to mailboxes ─────────────────────────

            await parallelChunked(campaigns, SYNC_CONCURRENCY, async (campaign: any) => {
                const externalCampaignId = campaign.id.toString();
                const internalCampaignId = `eb-${externalCampaignId}`;

                try {
                    const senderEmails = await fetchAllPages<any>(client, `/api/campaigns/${externalCampaignId}/sender-emails`, `Campaign ${externalCampaignId} sender-emails`);

                    const mailboxIds = senderEmails
                        .map((se: any) => `eb-${se.id}`)
                        .filter(Boolean);

                    if (mailboxIds.length > 0) {
                        // Only connect mailboxes that exist in our DB
                        const existingIds = await prisma.mailbox.findMany({
                            where: { id: { in: mailboxIds } },
                            select: { id: true },
                        });

                        if (existingIds.length > 0) {
                            await prisma.campaign.update({
                                where: { id: internalCampaignId },
                                data: {
                                    mailboxes: {
                                        connect: existingIds.map(m => ({ id: m.id })),
                                    },
                                },
                            });
                        }
                    }
                } catch (error: any) {
                    logger.warn('[EmailBisonSync] Failed to link mailboxes to campaign', {
                        campaignId: internalCampaignId,
                        error: error.message,
                    });
                }
            });

            // ── 4. Fetch leads per campaign ────────────────────────────

            if (sessionId) {
                syncProgressService.emitProgress(sessionId, 'leads', 'in_progress', {
                    current: 0,
                    total: campaigns.length,
                });
            }

            await parallelChunked(campaigns, SYNC_CONCURRENCY, async (campaign: any) => {
                const externalCampaignId = campaign.id.toString();
                const internalCampaignId = `eb-${externalCampaignId}`;

                try {
                    let page = 1;
                    let hasMore = true;
                    let campaignLeadCount = 0;

                    while (hasMore) {
                        const leadsRes = await emailbisonRateLimiter.execute(() =>
                            emailbisonBreaker.call(() => client.get(`/api/campaigns/${externalCampaignId}/leads`, { params: { page, per_page: 100 } }))
                        );

                        const leadsData = leadsRes.data?.data || leadsRes.data || [];
                        const leadsList = Array.isArray(leadsData) ? leadsData : [];

                        if (leadsList.length === 0) {
                            hasMore = false;
                            break;
                        }

                        const leadUpserts = [];
                        const existingLeads = await prisma.lead.findMany({
                            where: {
                                organization_id: organizationId,
                                email: { in: leadsList.map((l: any) => l.email || '').filter(Boolean) },
                            },
                            select: { email: true },
                        });
                        const existingLeadSet = new Set(existingLeads.map(l => l.email));

                        for (const lead of leadsList) {
                            const email = lead.email || '';
                            if (!email) continue;

                            const isNewLead = !existingLeadSet.has(email);
                            if (isNewLead) {
                                if (org.current_lead_count >= limits.leads) {
                                    continue;
                                }
                                org.current_lead_count++;
                                existingLeadSet.add(email);
                            }

                            const firstName = lead.first_name || '';
                            const lastName = lead.last_name || '';
                            const company = lead.company || '';
                            const persona = company || 'general';

                            // EmailBison includes engagement stats inline
                            const stats = lead.overall_stats || {};
                            const emailsSent = parseInt(String(stats.emails_sent || 0));
                            const emailsOpened = parseInt(String(stats.opens || stats.unique_opens || 0));
                            const emailsReplied = parseInt(String(stats.replies || stats.unique_replies || 0));

                            // Per-lead bounce: status 'bounced' or 'hard_bounced' counts as a bounce
                            const leadStatus = (lead.status || lead.lead_status || '').toString().toLowerCase();
                            const isBounced = leadStatus === 'bounced' || leadStatus === 'hard_bounced' || leadStatus === 'undeliverable';

                            leadUpserts.push(
                                prisma.lead.upsert({
                                    where: {
                                        organization_id_email: {
                                            organization_id: organizationId,
                                            email,
                                        },
                                    },
                                    update: {
                                        assigned_campaign_id: internalCampaignId,
                                        source_platform: SourcePlatform.emailbison,
                                        emails_sent: emailsSent,
                                        emails_opened: emailsOpened,
                                        emails_replied: emailsReplied,
                                        ...(isBounced && { health_classification: 'red', status: 'failed', bounced: true }),
                                        updated_at: new Date(),
                                    },
                                    create: {
                                        email,
                                        persona,
                                        lead_score: 50,
                                        source: 'emailbison',
                                        source_platform: SourcePlatform.emailbison,
                                        bounced: isBounced,
                                        status: isBounced ? 'failed' : 'active',
                                        health_classification: isBounced ? 'red' : 'green',
                                        emails_sent: emailsSent,
                                        emails_opened: emailsOpened,
                                        emails_replied: emailsReplied,
                                        assigned_campaign_id: internalCampaignId,
                                        organization_id: organizationId,
                                    },
                                })
                            );

                            leadCount++;
                            campaignLeadCount++;
                        }

                        if (leadUpserts.length > 0) {
                            await prisma.$transaction(leadUpserts);
                            await prisma.organization.update({
                                where: { id: organizationId },
                                data: { current_lead_count: org.current_lead_count },
                            });
                        }

                        // Activity timeline backfill — write audit logs for leads with engagement but no timeline
                        for (const lead of leadsList) {
                            const email = lead.email || '';
                            if (!email) continue;
                            const stats = lead.overall_stats || {};
                            const sent = parseInt(String(stats.emails_sent || 0));
                            const opens = parseInt(String(stats.opens || stats.unique_opens || 0));
                            const replies = parseInt(String(stats.replies || stats.unique_replies || 0));
                            if (sent === 0 && opens === 0 && replies === 0) continue;

                            try {
                                const dbLead = await prisma.lead.findUnique({
                                    where: { organization_id_email: { organization_id: organizationId, email } },
                                    select: { id: true },
                                });
                                if (!dbLead) continue;

                                const hasActivityLogs = await prisma.auditLog.count({
                                    where: { organization_id: organizationId, entity: 'lead', entity_id: dbLead.id, action: { in: ['email_sent', 'email_opened', 'email_clicked', 'email_replied'] } },
                                    take: 1,
                                });
                                if (hasActivityLogs > 0) continue;

                                await auditLogService.logAction({ organizationId, entity: 'lead', entityId: dbLead.id, trigger: 'emailbison_sync', action: 'email_sent', details: `Email(s) sent to lead in campaign ${internalCampaignId} (backfilled from sync)` });
                                if (opens > 0) await auditLogService.logAction({ organizationId, entity: 'lead', entityId: dbLead.id, trigger: 'emailbison_sync', action: 'email_opened', details: `Email opened ${opens} time(s) (backfilled from sync)` });
                                if (replies > 0) await auditLogService.logAction({ organizationId, entity: 'lead', entityId: dbLead.id, trigger: 'emailbison_sync', action: 'email_replied', details: `Email replied ${replies} time(s) (backfilled from sync)` });
                            } catch { /* non-fatal */ }
                        }

                        if (leadsList.length < 100) {
                            hasMore = false;
                        } else {
                            page++;
                        }
                    }

                    logger.info(`[EmailBisonSync] Synced ${campaignLeadCount} leads for campaign eb-${externalCampaignId}`, {
                        organizationId,
                    });
                } catch (error: any) {
                    logger.warn('[EmailBisonSync] Failed to sync leads for campaign', {
                        campaignId: internalCampaignId,
                        error: error.message,
                    });
                }
            });

            // Reconcile org lead count after parallel sync
            const authoritativeLeadCount = await prisma.lead.count({ where: { organization_id: organizationId } });
            if (authoritativeLeadCount !== org.current_lead_count) {
                logger.info('[EmailBisonSync] Reconciling lead count after parallel sync', {
                    organizationId,
                    inMemory: org.current_lead_count,
                    authoritative: authoritativeLeadCount,
                });
                org.current_lead_count = authoritativeLeadCount;
                await prisma.organization.update({
                    where: { id: organizationId },
                    data: { current_lead_count: authoritativeLeadCount }
                });
            }

            if (sessionId) {
                syncProgressService.emitProgress(sessionId, 'leads', 'completed', { count: leadCount });
            }

            // NOTE: EmailBison does NOT expose per-mailbox engagement analytics.
            // Mailbox-level opens/clicks/replies/bounces are tracked exclusively
            // via webhooks (emailbisonWebhookController.ts). Campaign-level totals
            // are synced above on the campaign records. We do NOT distribute
            // campaign stats proportionally across mailboxes — that would be
            // assumption data, not actual per-mailbox metrics.

            // ── 5. Historical bounce backfill from per-lead status ──────
            // EmailBison's /api/campaigns/{id}/leads returns per-lead status.
            // Leads with bounced status are already marked above during lead sync
            // (line ~532). For mailbox-level attribution, we rely on "Email Bounced"
            // webhooks which include the sender_email object.

            // ── 6. Post-sync assessment ────────────────────────────────

            try {
                await assessmentService.assessInfrastructure(organizationId);
            } catch (assessError: any) {
                logger.warn('[EmailBisonSync] Post-sync assessment failed', { error: assessError.message });
            }

            logger.info('[EmailBisonSync] Sync complete', {
                organizationId,
                campaigns: campaignCount,
                mailboxes: mailboxCount,
                leads: leadCount,
            });

            return { campaigns: campaignCount, mailboxes: mailboxCount, leads: leadCount };

        } catch (error: any) {
            logger.error('[EmailBisonSync] Sync failed', error, { organizationId });
            throw error;
        } finally {
            // ── Issue C: Always release the sync lock ──
            await releaseLock(lockKey);
        }
    }

    // ── HEALING ACTIONS ────────────────────────────────────────────────

    async pauseCampaign(organizationId: string, externalCampaignId: string): Promise<boolean> {
        try {
            const client = await this.getClient(organizationId);
            await emailbisonRateLimiter.execute(() =>
                client.patch(`/api/campaigns/${externalCampaignId}/pause`)
            );
            logger.info('[EmailBison] Campaign paused', { externalCampaignId, organizationId });
            return true;
        } catch (error: any) {
            logger.error('[EmailBison] Failed to pause campaign', error, { externalCampaignId });
            return false;
        }
    }

    async resumeCampaign(organizationId: string, externalCampaignId: string): Promise<boolean> {
        try {
            const client = await this.getClient(organizationId);
            await emailbisonRateLimiter.execute(() =>
                client.patch(`/api/campaigns/${externalCampaignId}/resume`)
            );
            logger.info('[EmailBison] Campaign resumed', { externalCampaignId, organizationId });
            return true;
        } catch (error: any) {
            logger.error('[EmailBison] Failed to resume campaign', error, { externalCampaignId });
            return false;
        }
    }

    async addMailboxToCampaign(
        organizationId: string,
        externalCampaignId: string,
        externalMailboxId: string
    ): Promise<boolean> {
        try {
            const client = await this.getClient(organizationId);
            await emailbisonRateLimiter.execute(() =>
                client.post(`/api/campaigns/${externalCampaignId}/attach-sender-emails`, {
                    sender_email_ids: [parseInt(externalMailboxId)],
                })
            );
            logger.info('[EmailBison] Mailbox added to campaign', {
                externalCampaignId,
                externalMailboxId,
                organizationId,
            });
            return true;
        } catch (error: any) {
            logger.error('[EmailBison] Failed to add mailbox to campaign', error, {
                externalCampaignId,
                externalMailboxId,
            });
            return false;
        }
    }

    async removeMailboxFromCampaign(
        organizationId: string,
        externalCampaignId: string,
        externalMailboxId: string
    ): Promise<boolean> {
        try {
            const client = await this.getClient(organizationId);
            await emailbisonRateLimiter.execute(() =>
                client.delete(`/api/campaigns/${externalCampaignId}/remove-sender-emails`, {
                    data: { sender_email_ids: [parseInt(externalMailboxId)] },
                })
            );
            logger.info('[EmailBison] Mailbox removed from campaign', {
                externalCampaignId,
                externalMailboxId,
                organizationId,
            });
            return true;
        } catch (error: any) {
            logger.error('[EmailBison] Failed to remove mailbox from campaign', error, {
                externalCampaignId,
                externalMailboxId,
            });
            return false;
        }
    }

    // ── WARMUP ─────────────────────────────────────────────────────────

    async getMailboxDetails(
        organizationId: string,
        externalAccountId: string
    ): Promise<MailboxDetails | null> {
        try {
            const client = await this.getClient(organizationId);
            const res = await emailbisonRateLimiter.execute(() =>
                client.get(`/api/warmup/sender-emails/${externalAccountId}`)
            );
            const data = res.data?.data || res.data;

            if (!data) return null;

            return {
                externalId: String(data.id),
                email: data.email || '',
                status: data.status || 'unknown',
                warmupEnabled: data.warmup_enabled === true,
                warmupReputation: data.warmup_reputation || null,
                totalWarmupPerDay: data.daily_warmup_limit || 0,
                dailySentCount: data.emails_sent_count || 0,
                spamCount: 0,
                smtpSuccess: (data.status || '').toLowerCase() === 'connected',
                imapSuccess: (data.status || '').toLowerCase() === 'connected',
                connectionError: null,
            };
        } catch (error: any) {
            logger.error('[EmailBison] Failed to get mailbox details', error, { externalAccountId });
            return null;
        }
    }

    async updateWarmupSettings(
        organizationId: string,
        externalAccountId: string,
        settings: WarmupSettings
    ): Promise<{ ok: boolean; message: string }> {
        try {
            const client = await this.getClient(organizationId);

            const numericId = parseInt(externalAccountId, 10);
            if (isNaN(numericId)) return { ok: false, message: 'Invalid numeric account ID for EmailBison' };

            if (settings.warmup_enabled) {
                await emailbisonRateLimiter.execute(() =>
                    client.patch('/api/warmup/sender-emails/enable', {
                        sender_email_ids: [numericId],
                    })
                );

                if (settings.total_warmup_per_day) {
                    await emailbisonRateLimiter.execute(() =>
                        client.patch('/api/warmup/sender-emails/update-daily-warmup-limits', {
                            sender_email_ids: [numericId],
                            daily_warmup_limit: settings.total_warmup_per_day,
                        })
                    );
                }
            } else {
                await emailbisonRateLimiter.execute(() =>
                    client.patch('/api/warmup/sender-emails/disable', {
                        sender_email_ids: [numericId],
                    })
                );
            }

            return { ok: true, message: 'Warmup settings updated' };
        } catch (error: any) {
            logger.error('[EmailBison] Failed to update warmup settings', error, { externalAccountId });
            return { ok: false, message: error.message };
        }
    }

    // ── LEAD OPERATIONS ────────────────────────────────────────────────

    async pushLeadToCampaign(
        organizationId: string,
        externalCampaignId: string,
        lead: LeadPayload
    ): Promise<PushLeadResult> {
        try {
            // Idempotency check: skip if lead already active in this campaign
            const internalCampaignId = `eb-${externalCampaignId}`;
            const existingLead = await prisma.lead.findFirst({
                where: {
                    organization_id: organizationId,
                    email: lead.email,
                    assigned_campaign_id: internalCampaignId,
                    status: LeadState.ACTIVE,
                },
            });

            if (existingLead) {
                logger.info('[EmailBison] Lead already exists in campaign (idempotent skip)', {
                    organizationId,
                    externalCampaignId,
                    email: lead.email,
                });
                return { success: true };
            }

            const client = await this.getClient(organizationId);

            // First create the lead globally (rate-limited)
            // Map company → company_name (consistent with Smartlead & Instantly)
            const createRes = await emailbisonRateLimiter.execute(() =>
                client.post('/api/leads', {
                    email: lead.email,
                    first_name: lead.first_name || '',
                    last_name: lead.last_name || '',
                    company_name: lead.company || '',
                })
            );

            const leadId = createRes.data?.data?.id;
            if (!leadId) {
                return { success: false, message: 'Failed to create lead in EmailBison' };
            }

            // Then attach to campaign (rate-limited)
            await emailbisonRateLimiter.execute(() =>
                client.post(`/api/campaigns/${externalCampaignId}/leads/attach-leads`, {
                    lead_ids: [leadId],
                })
            );

            return { success: true };
        } catch (error: any) {
            logger.error('[EmailBison] Failed to push lead to campaign', error, {
                externalCampaignId,
                leadEmail: lead.email,
            });
            return { success: false, message: error.message };
        }
    }

    async removeLeadFromCampaign(
        organizationId: string,
        externalCampaignId: string,
        leadEmail: string
    ): Promise<boolean> {
        try {
            const client = await this.getClient(organizationId);

            // Find the lead by email first (rate-limited)
            const leadsRes = await emailbisonRateLimiter.execute(() =>
                client.get('/api/leads', { params: { search: leadEmail } })
            );
            const leads = leadsRes.data?.data || [];
            const lead = leads.find((l: any) => l.email === leadEmail);

            if (!lead) {
                logger.warn('[EmailBison] Lead not found for removal', { leadEmail });
                return false;
            }

            await emailbisonRateLimiter.execute(() =>
                client.delete(`/api/campaigns/${externalCampaignId}/leads`, {
                    data: { lead_ids: [lead.id] },
                })
            );

            return true;
        } catch (error: any) {
            logger.error('[EmailBison] Failed to remove lead from campaign', error, {
                externalCampaignId,
                leadEmail,
            });
            return false;
        }
    }

    // ── DOMAIN OPERATIONS ──────────────────────────────────────────────

    async removeAllDomainMailboxes(
        organizationId: string,
        domainId: string
    ): Promise<{ success: number; failed: number }> {
        let successCount = 0;
        let failedCount = 0;

        try {
            // Get all EmailBison mailboxes in this domain
            const mailboxes = await prisma.mailbox.findMany({
                where: {
                    domain_id: domainId,
                    organization_id: organizationId,
                    source_platform: SourcePlatform.emailbison,
                },
                select: {
                    id: true,
                    external_email_account_id: true,
                    campaigns: { select: { external_id: true } },
                },
            });

            for (const mailbox of mailboxes) {
                if (!mailbox.external_email_account_id) continue;

                for (const campaign of mailbox.campaigns) {
                    if (!campaign.external_id) continue;

                    const ok = await this.removeMailboxFromCampaign(
                        organizationId,
                        campaign.external_id,
                        mailbox.external_email_account_id
                    );

                    if (ok) successCount++;
                    else failedCount++;
                }
            }
        } catch (error: any) {
            logger.error('[EmailBison] Failed to remove domain mailboxes', error, {
                domainId,
                organizationId,
            });
        }

        return { success: successCount, failed: failedCount };
    }
}
