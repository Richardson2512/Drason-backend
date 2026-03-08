/**
 * Instantly Platform Adapter
 *
 * Implements the PlatformAdapter interface for Instantly API V2.
 * Base URL: https://api.instantly.ai/api/v2
 * Auth: Bearer token (stored as INSTANTLY_API_KEY in OrganizationSetting)
 *
 * API Mapping:
 *   Campaigns:  GET /campaigns, POST /campaigns/{id}/pause|activate
 *   Accounts:   GET /accounts, GET /accounts/{email}, POST /accounts/{email}/pause|resume
 *   Warmup:     POST /accounts/warmup/enable|disable, POST /accounts/warmup-analytics
 *   Mapping:    GET|POST|DELETE /account-campaign-mappings
 *   Leads:      POST /leads (add), POST /leads/list, DELETE /leads/{id}
 *   Analytics:  GET /accounts/analytics/daily, GET /campaigns/analytics
 *
 * Aggregate rules implemented:
 *   - Per-lead bounce: tracked via webhook + status field ('bounced') during sync
 *   - Per-domain stats: aggregated from per-mailbox daily analytics (sum sent/bounced)
 *   - Pause per domain: iterate all domain mailboxes, pause each via accounts/{email}/pause
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
import { instantlyRateLimiter } from '../utils/rateLimiter';
import {
    PlatformAdapter,
    SyncResult,
    MailboxDetails,
    WarmupSettings,
    LeadPayload,
    PushLeadResult,
} from './platformAdapter';
import { LeadState } from '../types';

const INSTANTLY_API_BASE = 'https://api.instantly.ai/api/v2';

export class InstantlyAdapter implements PlatformAdapter {
    readonly platform = SourcePlatform.instantly;

    // ── AUTH ────────────────────────────────────────────────────────────

    private async getApiKey(organizationId: string): Promise<string | null> {
        const setting = await prisma.organizationSetting.findUnique({
            where: {
                organization_id_key: {
                    organization_id: organizationId,
                    key: 'INSTANTLY_API_KEY',
                },
            },
        });
        if (!setting?.value) return null;
        return decrypt(setting.value);
    }

    private async getClient(organizationId: string): Promise<AxiosInstance> {
        const apiKey = await this.getApiKey(organizationId);
        if (!apiKey) throw new Error('Instantly API key not configured');

        return axios.create({
            baseURL: INSTANTLY_API_BASE,
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                Accept: 'application/json',
            },
            timeout: 30000,
        });
    }

    // ── SYNC ───────────────────────────────────────────────────────────

    async sync(organizationId: string, sessionId?: string): Promise<SyncResult> {
        // Fail fast: validate API key before acquiring lock
        const apiKey = await this.getApiKey(organizationId);
        if (!apiKey) {
            throw new Error('Instantly API key not configured. Please add your API key in Settings.');
        }

        const lockKey = `sync:instantly:org:${organizationId}`;
        const acquired = await acquireLock(lockKey, 15 * 60);
        if (!acquired) {
            const msg = `Instantly sync already in progress for organization ${organizationId}`;
            logger.warn(`[InstantlySync] ${msg}`);
            throw new Error(msg);
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
                },
            });

            if (!org) throw new Error('Organization not found');

            const blockedStatuses = ['expired', 'past_due', 'canceled'];
            if (blockedStatuses.includes(org.subscription_status)) {
                throw new Error(`Cannot sync: subscription ${org.subscription_status}`);
            }

            const limits = TIER_LIMITS[org.subscription_tier] || TIER_LIMITS.trial;

            // ── 1. Fetch campaigns (cursor-paginated) ──────────────────

            if (sessionId) {
                syncProgressService.emitProgress(sessionId, 'campaigns', 'in_progress', { total: 0 });
            }

            const allCampaigns: any[] = [];
            let campaignCursor: string | undefined;

            do {
                const params: Record<string, any> = { limit: 100 };
                if (campaignCursor) params.starting_after = campaignCursor;

                const res = await instantlyRateLimiter.execute(() =>
                    client.get('/campaigns', { params })
                );

                const items: any[] = res.data?.items || res.data || [];
                allCampaigns.push(...items);
                campaignCursor = res.data?.next_starting_after || undefined;
            } while (campaignCursor);

            logger.info('[InstantlySync] Fetched campaigns', {
                organizationId,
                count: allCampaigns.length,
            });

            if (sessionId) {
                syncProgressService.emitProgress(sessionId, 'campaigns', 'in_progress', {
                    current: 0,
                    total: allCampaigns.length,
                });
            }

            let campaignUpserts: any[] = [];

            for (let i = 0; i < allCampaigns.length; i++) {
                const campaign = allCampaigns[i];
                const externalId = campaign.id;
                const internalId = `inst-${externalId}`;

                // Map Instantly campaign status to internal status
                const rawStatus = (campaign.status || '').toString().toLowerCase();
                let status = 'active';
                if (rawStatus === '1' || rawStatus === 'paused') status = 'paused';
                else if (rawStatus === '2' || rawStatus === 'completed') status = 'completed';
                else if (rawStatus === '0' || rawStatus === 'draft') status = 'draft';
                // Instantly uses numeric status: 0=draft, 1=active/paused, status_name helps

                const totalSent = parseInt(String(campaign.campaign_analytics?.total_emails_sent || campaign.total_sent || 0));
                const totalBounced = parseInt(String(campaign.campaign_analytics?.bounced || campaign.total_bounced || 0));
                const totalOpens = parseInt(String(campaign.campaign_analytics?.total_opens || campaign.open_count || 0));
                const totalReplies = parseInt(String(campaign.campaign_analytics?.total_replies || campaign.reply_count || 0));

                const bounceRate = totalSent > 0 ? (totalBounced / totalSent) * 100 : 0;
                const openRate = totalSent > 0 ? (totalOpens / totalSent) * 100 : 0;
                const replyRate = totalSent > 0 ? (totalReplies / totalSent) * 100 : 0;

                campaignUpserts.push(
                    prisma.campaign.upsert({
                        where: { id: internalId },
                        update: {
                            name: campaign.name,
                            status,
                            source_platform: SourcePlatform.instantly,
                            external_id: externalId,
                            bounce_rate: bounceRate,
                            total_sent: totalSent,
                            total_bounced: totalBounced,
                            open_count: totalOpens,
                            reply_count: totalReplies,
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
                            source_platform: SourcePlatform.instantly,
                            external_id: externalId,
                            bounce_rate: bounceRate,
                            total_sent: totalSent,
                            total_bounced: totalBounced,
                            open_count: totalOpens,
                            reply_count: totalReplies,
                            open_rate: openRate,
                            reply_rate: replyRate,
                            analytics_updated_at: new Date(),
                            organization_id: organizationId,
                        },
                    })
                );

                campaignCount++;

                if (campaignUpserts.length >= 50 || i === allCampaigns.length - 1) {
                    await prisma.$transaction(campaignUpserts);
                    campaignUpserts = [];
                    if (sessionId) {
                        syncProgressService.emitProgress(sessionId, 'campaigns', 'in_progress', {
                            current: campaignCount,
                            total: allCampaigns.length,
                        });
                    }
                }
            }

            if (sessionId) {
                syncProgressService.emitProgress(sessionId, 'campaigns', 'completed', { count: campaignCount });
                syncProgressService.emitProgress(sessionId, 'mailboxes', 'in_progress', { total: 0 });
            }

            // ── 2. Fetch email accounts (mailboxes) ────────────────────

            const allAccounts: any[] = [];
            let accountCursor: string | undefined;

            do {
                const params: Record<string, any> = { limit: 100 };
                if (accountCursor) params.starting_after = accountCursor;

                const res = await instantlyRateLimiter.execute(() =>
                    client.get('/accounts', { params })
                );

                const items: any[] = res.data?.items || res.data || [];
                allAccounts.push(...items);
                accountCursor = res.data?.next_starting_after || undefined;
            } while (accountCursor);

            logger.info('[InstantlySync] Fetched email accounts', {
                organizationId,
                count: allAccounts.length,
            });

            if (sessionId) {
                syncProgressService.emitProgress(sessionId, 'mailboxes', 'in_progress', {
                    current: 0,
                    total: allAccounts.length,
                });
            }

            const existingDomains = await prisma.domain.findMany({
                where: { organization_id: organizationId },
            });
            const domainMap = new Map(existingDomains.map(d => [d.domain, d]));

            const existingMailboxes = await prisma.mailbox.findMany({
                where: { organization_id: organizationId },
                select: { id: true },
            });
            const existingMailboxSet = new Set(existingMailboxes.map(m => m.id));

            // Create domains for new email addresses
            const uniqueDomainNames = [
                ...new Set(allAccounts.map((a: any) => (a.email || '').split('@')[1] || 'unknown.com')),
            ];
            const newDomains = uniqueDomainNames.filter(d => !domainMap.has(d as string));

            if (newDomains.length > 0) {
                const domainsToCreate: any[] = [];
                for (const domainName of newDomains) {
                    if (org.current_domain_count >= limits.domains) {
                        logger.warn('[InstantlySync] Domain capacity reached', {
                            organizationId,
                            skippedDomain: domainName,
                        });
                        continue;
                    }
                    domainsToCreate.push({
                        domain: domainName as string,
                        status: 'healthy',
                        source_platform: SourcePlatform.instantly,
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
                        where: { organization_id: organizationId, domain: { in: domainsToCreate.map(d => d.domain) } },
                    });
                    newlyCreated.forEach(d => domainMap.set(d.domain, d));
                }
            }

            let mailboxUpserts: any[] = [];
            let mailboxesToIncrement = 0;

            for (let i = 0; i < allAccounts.length; i++) {
                const account = allAccounts[i];
                const email = account.email || '';
                if (!email) continue;

                const domainName = email.split('@')[1] || 'unknown.com';
                const domain = domainMap.get(domainName);
                if (!domain) continue;

                // Instantly uses email as the unique account identifier
                const internalId = `inst-${email}`;
                const isNewMailbox = !existingMailboxSet.has(internalId);

                if (isNewMailbox) {
                    if (org.current_mailbox_count >= limits.mailboxes) {
                        logger.warn('[InstantlySync] Mailbox capacity reached', {
                            organizationId,
                            skippedEmail: email,
                        });
                        continue;
                    }
                    org.current_mailbox_count++;
                    mailboxesToIncrement++;
                }

                // status: 1 = active, 0 = paused, -1 = disconnected (Instantly uses numeric)
                const acctStatus = account.status;
                const isActive = acctStatus === 1 || acctStatus === 'active';
                const mailboxStatus = isActive ? 'healthy' : 'paused';

                const warmupEnabled = account.warmup_enabled === true || account.warmup_status === 1;

                mailboxUpserts.push(
                    prisma.mailbox.upsert({
                        where: { id: internalId },
                        update: {
                            email,
                            source_platform: SourcePlatform.instantly,
                            // Instantly uses email as external ID; store as string
                            external_email_account_id: email,
                            status: mailboxStatus,
                            smtp_status: isActive,
                            imap_status: isActive,
                            warmup_status: warmupEnabled ? 'enabled' : 'disabled',
                            warmup_limit: account.daily_warmup_limit || account.warmup_limit || 0,
                            last_activity_at: new Date(),
                        },
                        create: {
                            id: internalId,
                            email,
                            source_platform: SourcePlatform.instantly,
                            external_email_account_id: email,
                            status: mailboxStatus,
                            smtp_status: isActive,
                            imap_status: isActive,
                            warmup_status: warmupEnabled ? 'enabled' : 'disabled',
                            warmup_limit: account.daily_warmup_limit || account.warmup_limit || 0,
                            domain_id: domain.id,
                            organization_id: organizationId,
                        },
                    })
                );

                mailboxCount++;

                if (mailboxUpserts.length >= 50 || i === allAccounts.length - 1) {
                    await prisma.$transaction(mailboxUpserts);
                    mailboxUpserts = [];
                    if (sessionId) {
                        syncProgressService.emitProgress(sessionId, 'mailboxes', 'in_progress', {
                            current: mailboxCount,
                            total: allAccounts.length,
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

            // ── 3. Link campaigns to mailboxes via account-campaign-mappings ──

            for (const campaign of allCampaigns) {
                const externalCampaignId = campaign.id;
                const internalCampaignId = `inst-${externalCampaignId}`;

                try {
                    const allMappings: any[] = [];
                    let mappingCursor: string | undefined;

                    do {
                        const params: Record<string, any> = {
                            campaign_id: externalCampaignId,
                            limit: 100,
                        };
                        if (mappingCursor) params.starting_after = mappingCursor;

                        const res = await instantlyRateLimiter.execute(() =>
                            client.get('/account-campaign-mappings', { params })
                        );

                        const items: any[] = res.data?.items || res.data || [];
                        allMappings.push(...items);
                        mappingCursor = res.data?.next_starting_after || undefined;
                    } while (mappingCursor);

                    const mailboxIds = allMappings
                        .map((m: any) => `inst-${m.email_account || m.account_email || m.email}`)
                        .filter(Boolean);

                    if (mailboxIds.length > 0) {
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
                } catch (err: any) {
                    logger.warn('[InstantlySync] Failed to link mailboxes to campaign', {
                        campaignId: internalCampaignId,
                        error: err.message,
                    });
                }
            }

            if (sessionId) {
                syncProgressService.emitProgress(sessionId, 'mailboxes', 'completed', { count: mailboxCount });
                syncProgressService.emitProgress(sessionId, 'leads', 'in_progress', { total: 0 });
            }

            // ── 4. Fetch leads per campaign ────────────────────────────

            for (const campaign of allCampaigns) {
                const externalCampaignId = campaign.id;
                const internalCampaignId = `inst-${externalCampaignId}`;

                try {
                    let leadCursor: string | undefined;
                    let hasMore = true;
                    let campaignLeadCount = 0;

                    while (hasMore) {
                        // Instantly uses POST for lead listing (documented quirk)
                        const body: Record<string, any> = {
                            campaign_id: externalCampaignId,
                            limit: 100,
                        };
                        if (leadCursor) body.starting_after = leadCursor;

                        const leadsRes = await instantlyRateLimiter.execute(() =>
                            client.post('/leads/list', body)
                        );

                        const leadsList: any[] = leadsRes.data?.items || leadsRes.data || [];
                        if (leadsList.length === 0) {
                            hasMore = false;
                            break;
                        }

                        const existingLeads = await prisma.lead.findMany({
                            where: {
                                organization_id: organizationId,
                                email: {
                                    in: leadsList.map((l: any) => l.email || '').filter(Boolean),
                                },
                            },
                            select: { email: true },
                        });
                        const existingLeadSet = new Set(existingLeads.map(l => l.email));

                        const leadUpserts: any[] = [];

                        for (const lead of leadsList) {
                            const email = lead.email || '';
                            if (!email) continue;

                            const isNewLead = !existingLeadSet.has(email);
                            if (isNewLead) {
                                if (org.current_lead_count >= limits.leads) continue;
                                org.current_lead_count++;
                                existingLeadSet.add(email);
                            }

                            const firstName = lead.first_name || '';
                            const lastName = lead.last_name || '';
                            const company = lead.company_name || lead.company || '';
                            const persona = company || 'general';

                            // Per-lead stats from Instantly
                            const emailsSent = parseInt(String(lead.emails_sent_count || lead.email_sent_count || 0));
                            const emailsOpened = parseInt(String(lead.email_open_count || lead.opens || 0));
                            const emailsReplied = parseInt(String(lead.email_reply_count || lead.replies || 0));
                            const emailsClicked = parseInt(String(lead.email_click_count || lead.clicks || 0));

                            // Per-lead bounce: status 'bounced' or 'undeliverable' counts as 1 bounce
                            const leadStatus = (lead.status || lead.lead_status || '').toString().toLowerCase();
                            const isBounced = leadStatus === 'bounced' || leadStatus === 'undeliverable';

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
                                        source_platform: SourcePlatform.instantly,
                                        emails_sent: emailsSent,
                                        emails_opened: emailsOpened,
                                        emails_replied: emailsReplied,
                                        // Mark bounced leads explicitly
                                        ...(isBounced && { health_classification: 'red', status: 'failed' }),
                                        updated_at: new Date(),
                                    },
                                    create: {
                                        email,
                                        persona,
                                        lead_score: 50,
                                        source: 'instantly',
                                        source_platform: SourcePlatform.instantly,
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

                        leadCursor = leadsRes.data?.next_starting_after || undefined;
                        if (!leadCursor || leadsList.length < 100) hasMore = false;
                    }

                    logger.info(`[InstantlySync] Synced ${campaignLeadCount} leads for campaign inst-${externalCampaignId}`, {
                        organizationId,
                    });
                } catch (err: any) {
                    logger.warn('[InstantlySync] Failed to sync leads for campaign', {
                        campaignId: internalCampaignId,
                        error: err.message,
                    });
                }
            }

            if (sessionId) {
                syncProgressService.emitProgress(sessionId, 'leads', 'completed', { count: leadCount });
            }

            // ── 5. Fetch per-mailbox daily analytics → aggregate per-domain ──
            // Rule: domain stats = sum of all mailboxes sharing that domain (no native domain endpoint)

            try {
                await this.syncMailboxAnalyticsAndAggregateDomains(
                    organizationId,
                    client,
                    allAccounts,
                    domainMap
                );
            } catch (analyticsErr: any) {
                logger.warn('[InstantlySync] Mailbox analytics aggregation failed (non-fatal)', {
                    error: analyticsErr.message,
                });
            }

            // ── 6. Post-sync assessment ────────────────────────────────

            try {
                await assessmentService.assessInfrastructure(organizationId);
            } catch (assessErr: any) {
                logger.warn('[InstantlySync] Post-sync assessment failed', {
                    error: assessErr.message,
                });
            }

            logger.info('[InstantlySync] Sync complete', {
                organizationId,
                campaigns: campaignCount,
                mailboxes: mailboxCount,
                leads: leadCount,
            });

            return { campaigns: campaignCount, mailboxes: mailboxCount, leads: leadCount };
        } catch (err: any) {
            logger.error('[InstantlySync] Sync failed', err, { organizationId });
            throw err;
        } finally {
            await releaseLock(lockKey);
        }
    }

    /**
     * Aggregate rule: fetch per-mailbox daily analytics for the past 7 days,
     * then sum across all mailboxes on the same domain to produce per-domain stats.
     * Updates domain.bounce_rate and per-mailbox engagement using additive snapshots.
     *
     * Additive sync: snapshots current mailbox stats before processing, then uses
     * Math.max(snapshot, syncDerived) so webhook-accumulated values are never overwritten
     * by lower sync-derived values.
     */
    private async syncMailboxAnalyticsAndAggregateDomains(
        organizationId: string,
        client: AxiosInstance,
        accounts: any[],
        domainMap: Map<string, any>
    ): Promise<void> {
        if (accounts.length === 0) return;

        const endDate = new Date().toISOString().split('T')[0];
        const startDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
            .toISOString()
            .split('T')[0];

        const emails = accounts.map((a: any) => a.email).filter(Boolean);
        if (emails.length === 0) return;

        // ── ADDITIVE SYNC: Snapshot pre-sync mailbox stats ──
        const mailboxEngagementSnapshot = new Map<string, {
            open_count_lifetime: number;
            click_count_lifetime: number;
            reply_count_lifetime: number;
            total_sent_count: number;
            hard_bounce_count: number;
        }>();

        const allMailboxesPreSync = await prisma.mailbox.findMany({
            where: { organization_id: organizationId, source_platform: SourcePlatform.instantly },
            select: {
                id: true,
                open_count_lifetime: true,
                click_count_lifetime: true,
                reply_count_lifetime: true,
                total_sent_count: true,
                hard_bounce_count: true,
            }
        });

        for (const mb of allMailboxesPreSync) {
            mailboxEngagementSnapshot.set(mb.id, {
                open_count_lifetime: mb.open_count_lifetime,
                click_count_lifetime: mb.click_count_lifetime,
                reply_count_lifetime: mb.reply_count_lifetime,
                total_sent_count: mb.total_sent_count,
                hard_bounce_count: mb.hard_bounce_count,
            });
        }

        // Fetch in batches of 50 to avoid overly long query strings
        const batchSize = 50;
        const domainStats: Map<string, { sent: number; bounced: number; opens: number }> = new Map();
        // Accumulate per-mailbox totals across all daily rows before writing
        const mailboxSyncStats: Map<string, { sent: number; opens: number; bounced: number }> = new Map();

        for (let i = 0; i < emails.length; i += batchSize) {
            const batch = emails.slice(i, i + batchSize);

            try {
                // GET /accounts/analytics/daily with email list as repeated query params
                const res = await instantlyRateLimiter.execute(() =>
                    client.get('/accounts/analytics/daily', {
                        params: {
                            emails: batch,
                            start_date: startDate,
                            end_date: endDate,
                        },
                        // Axios serialises arrays as emails[]=a&emails[]=b by default
                        paramsSerializer: (params) => {
                            const parts: string[] = [];
                            for (const [key, val] of Object.entries(params)) {
                                if (Array.isArray(val)) {
                                    val.forEach(v => parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`));
                                } else {
                                    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(val))}`);
                                }
                            }
                            return parts.join('&');
                        },
                    })
                );

                const dailyData: any[] = res.data?.items || res.data || [];

                // Aggregate: each row is { email, date, emails_sent, bounced, opens, ... }
                for (const row of dailyData) {
                    const email = row.email || '';
                    const domainName = email.split('@')[1];
                    if (!domainName) continue;

                    // Domain-level aggregation
                    const domainExisting = domainStats.get(domainName) || { sent: 0, bounced: 0, opens: 0 };
                    domainExisting.sent += parseInt(String(row.emails_sent || row.sent_count || 0));
                    domainExisting.bounced += parseInt(String(row.bounced || row.bounce_count || 0));
                    domainExisting.opens += parseInt(String(row.opens || row.open_count || 0));
                    domainStats.set(domainName, domainExisting);

                    // Per-mailbox accumulation (sum all daily rows per email)
                    const internalMailboxId = `inst-${email}`;
                    const mbExisting = mailboxSyncStats.get(internalMailboxId) || { sent: 0, opens: 0, bounced: 0 };
                    mbExisting.sent += parseInt(String(row.emails_sent || row.sent_count || 0));
                    mbExisting.opens += parseInt(String(row.opens || row.open_count || 0));
                    mbExisting.bounced += parseInt(String(row.bounced || row.bounce_count || 0));
                    mailboxSyncStats.set(internalMailboxId, mbExisting);
                }
            } catch (batchErr: any) {
                logger.warn('[InstantlySync] Failed to fetch analytics batch', {
                    error: batchErr.message,
                    batchStart: i,
                });
            }
        }

        // ── Additive write: per-mailbox stats ──
        let mailboxesUpdated = 0;
        let mailboxesSkippedHigher = 0;

        for (const [mbId, syncData] of mailboxSyncStats) {
            const snapshot = mailboxEngagementSnapshot.get(mbId) || {
                open_count_lifetime: 0,
                click_count_lifetime: 0,
                reply_count_lifetime: 0,
                total_sent_count: 0,
                hard_bounce_count: 0,
            };

            // Math.max: never overwrite webhook-accumulated values with lower sync values
            const finalSent = Math.max(snapshot.total_sent_count, syncData.sent);
            const finalOpens = Math.max(snapshot.open_count_lifetime, syncData.opens);
            const finalBounces = Math.max(snapshot.hard_bounce_count, syncData.bounced);
            // clicks and replies not in daily analytics — preserve webhook values
            const finalClicks = snapshot.click_count_lifetime;
            const finalReplies = snapshot.reply_count_lifetime;

            const totalEngagement = finalOpens + finalClicks + finalReplies;
            const engagementRate = finalSent > 0
                ? Math.min((totalEngagement / finalSent) * 100, 100)
                : 0;

            if (
                finalSent !== snapshot.total_sent_count ||
                finalOpens !== snapshot.open_count_lifetime ||
                finalBounces !== snapshot.hard_bounce_count
            ) {
                await prisma.mailbox.updateMany({
                    where: { id: mbId, organization_id: organizationId },
                    data: {
                        total_sent_count: finalSent,
                        open_count_lifetime: finalOpens,
                        hard_bounce_count: finalBounces,
                        engagement_rate: engagementRate,
                    },
                }).catch(err => logger.warn('[Instantly] Non-fatal mailbox analytics update error', { error: String(err) }));
                mailboxesUpdated++;
            } else {
                mailboxesSkippedHigher++;
            }
        }

        // Write aggregated domain stats back to DB
        for (const [domainName, stats] of domainStats.entries()) {
            const domain = domainMap.get(domainName);
            if (!domain) continue;

            const bounceRate = stats.sent > 0 ? (stats.bounced / stats.sent) * 100 : 0;

            await prisma.domain.update({
                where: { id: domain.id },
                data: {
                    bounce_rate: bounceRate,
                    total_sent_lifetime: stats.sent,
                    total_bounces: stats.bounced,
                },
            }).catch(err => { logger.warn('[InstantlySync] Non-fatal domain stats update error', { error: String(err), domainId: domain.id }); });
        }

        logger.info('[InstantlySync] Additive analytics sync complete', {
            organizationId,
            domainsUpdated: domainStats.size,
            mailboxesUpdated,
            mailboxesSkippedHigher,
        });
    }

    // ── HEALING ACTIONS ────────────────────────────────────────────────

    async pauseCampaign(organizationId: string, externalCampaignId: string): Promise<boolean> {
        try {
            const client = await this.getClient(organizationId);
            await instantlyRateLimiter.execute(() =>
                client.post(`/campaigns/${externalCampaignId}/pause`)
            );
            logger.info('[Instantly] Campaign paused', { externalCampaignId, organizationId });
            return true;
        } catch (err: any) {
            logger.error('[Instantly] Failed to pause campaign', err, { externalCampaignId });
            return false;
        }
    }

    async resumeCampaign(organizationId: string, externalCampaignId: string): Promise<boolean> {
        try {
            const client = await this.getClient(organizationId);
            await instantlyRateLimiter.execute(() =>
                client.post(`/campaigns/${externalCampaignId}/activate`)
            );
            logger.info('[Instantly] Campaign activated', { externalCampaignId, organizationId });
            return true;
        } catch (err: any) {
            logger.error('[Instantly] Failed to activate campaign', err, { externalCampaignId });
            return false;
        }
    }

    async addMailboxToCampaign(
        organizationId: string,
        externalCampaignId: string,
        externalMailboxId: string  // for Instantly this is the email address
    ): Promise<boolean> {
        try {
            const client = await this.getClient(organizationId);
            // externalMailboxId is the email address for Instantly accounts
            const email = externalMailboxId.startsWith('inst-')
                ? externalMailboxId.slice(5)
                : externalMailboxId;

            await instantlyRateLimiter.execute(() =>
                client.post('/account-campaign-mappings', {
                    campaign_id: externalCampaignId,
                    email_account: email,
                })
            );
            logger.info('[Instantly] Mailbox added to campaign', {
                externalCampaignId,
                email,
                organizationId,
            });
            return true;
        } catch (err: any) {
            logger.error('[Instantly] Failed to add mailbox to campaign', err, {
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
            const email = externalMailboxId.startsWith('inst-')
                ? externalMailboxId.slice(5)
                : externalMailboxId;

            await instantlyRateLimiter.execute(() =>
                client.delete('/account-campaign-mappings', {
                    data: {
                        campaign_id: externalCampaignId,
                        email_account: email,
                    },
                })
            );
            logger.info('[Instantly] Mailbox removed from campaign', {
                externalCampaignId,
                email,
                organizationId,
            });
            return true;
        } catch (err: any) {
            logger.error('[Instantly] Failed to remove mailbox from campaign', err, {
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
            // externalAccountId is the email address for Instantly
            const email = externalAccountId;
            const res = await instantlyRateLimiter.execute(() =>
                client.get(`/accounts/${encodeURIComponent(email)}`)
            );
            const data = res.data;
            if (!data) return null;

            const acctStatus = data.status;
            const isActive = acctStatus === 1 || acctStatus === 'active';

            return {
                externalId: email,
                email: data.email || email,
                status: isActive ? 'active' : 'paused',
                warmupEnabled: data.warmup_enabled === true || data.warmup_status === 1,
                warmupReputation: data.warmup_reputation || null,
                totalWarmupPerDay: data.daily_warmup_limit || data.warmup_limit || 0,
                dailySentCount: data.daily_sent_count || 0,
                spamCount: data.spam_count || 0,
                smtpSuccess: isActive,
                imapSuccess: isActive,
                connectionError: data.connection_error || null,
            };
        } catch (err: any) {
            logger.error('[Instantly] Failed to get mailbox details', err, { externalAccountId });
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
            const email = externalAccountId;

            if (settings.warmup_enabled) {
                await instantlyRateLimiter.execute(() =>
                    client.post('/accounts/warmup/enable', { emails: [email] })
                );

                if (settings.total_warmup_per_day) {
                    await instantlyRateLimiter.execute(() =>
                        client.patch(`/accounts/${encodeURIComponent(email)}`, {
                            daily_warmup_limit: settings.total_warmup_per_day,
                        })
                    );
                }
            } else {
                await instantlyRateLimiter.execute(() =>
                    client.post('/accounts/warmup/disable', { emails: [email] })
                );
            }

            return { ok: true, message: 'Warmup settings updated' };
        } catch (err: any) {
            logger.error('[Instantly] Failed to update warmup settings', err, { externalAccountId });
            return { ok: false, message: err.message };
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
            const internalCampaignId = `inst-${externalCampaignId}`;
            const existingLead = await prisma.lead.findFirst({
                where: {
                    organization_id: organizationId,
                    email: lead.email,
                    assigned_campaign_id: internalCampaignId,
                    status: LeadState.ACTIVE,
                },
            });

            if (existingLead) {
                logger.info('[Instantly] Lead already exists in campaign (idempotent skip)', {
                    organizationId,
                    externalCampaignId,
                    email: lead.email,
                });
                return { success: true };
            }

            const client = await this.getClient(organizationId);

            // Instantly field mapping: company → company_name
            await instantlyRateLimiter.execute(() =>
                client.post('/leads', {
                    campaign_id: externalCampaignId,
                    leads: [
                        {
                            email: lead.email,
                            first_name: lead.first_name || '',
                            last_name: lead.last_name || '',
                            company_name: lead.company || '',
                        },
                    ],
                })
            );

            logger.info('[Instantly] Lead pushed to campaign', {
                externalCampaignId,
                leadEmail: lead.email,
                organizationId,
            });

            return { success: true };
        } catch (err: any) {
            logger.error('[Instantly] Failed to push lead to campaign', err, {
                externalCampaignId,
                leadEmail: lead.email,
            });
            return { success: false, message: err.message };
        }
    }

    async removeLeadFromCampaign(
        organizationId: string,
        externalCampaignId: string,
        leadEmail: string
    ): Promise<boolean> {
        try {
            const client = await this.getClient(organizationId);

            // Find the lead ID by listing leads filtered by email
            const listRes = await instantlyRateLimiter.execute(() =>
                client.post('/leads/list', {
                    campaign_id: externalCampaignId,
                    email: leadEmail,
                    limit: 10,
                })
            );

            const leads: any[] = listRes.data?.items || listRes.data || [];
            const lead = leads.find((l: any) => l.email === leadEmail);

            if (!lead?.id) {
                logger.warn('[Instantly] Lead not found for removal', { leadEmail });
                return false;
            }

            await instantlyRateLimiter.execute(() =>
                client.delete(`/leads/${lead.id}`)
            );

            return true;
        } catch (err: any) {
            logger.error('[Instantly] Failed to remove lead from campaign', err, {
                externalCampaignId,
                leadEmail,
            });
            return false;
        }
    }

    // ── DOMAIN OPERATIONS ──────────────────────────────────────────────
    // Aggregate rule: Instantly has no native domain concept.
    // Pause per domain = pause each mailbox whose email domain matches.

    async removeAllDomainMailboxes(
        organizationId: string,
        domainId: string
    ): Promise<{ success: number; failed: number }> {
        let successCount = 0;
        let failedCount = 0;

        try {
            const mailboxes = await prisma.mailbox.findMany({
                where: {
                    domain_id: domainId,
                    organization_id: organizationId,
                    source_platform: SourcePlatform.instantly,
                },
                select: {
                    id: true,
                    email: true,
                    campaigns: { select: { external_id: true } },
                },
            });

            for (const mailbox of mailboxes) {
                if (!mailbox.email) continue;

                for (const campaign of mailbox.campaigns) {
                    if (!campaign.external_id) continue;

                    const ok = await this.removeMailboxFromCampaign(
                        organizationId,
                        campaign.external_id,
                        mailbox.email
                    );

                    if (ok) successCount++;
                    else failedCount++;
                }

                // Also pause the account itself at the platform level
                try {
                    const client = await this.getClient(organizationId);
                    const email = mailbox.email;
                    await instantlyRateLimiter.execute(() =>
                        client.post(`/accounts/${encodeURIComponent(email)}/pause`)
                    );
                } catch (pauseErr: any) {
                    logger.warn('[Instantly] Failed to pause account for domain removal', {
                        mailboxId: mailbox.id,
                        error: pauseErr.message,
                    });
                }
            }
        } catch (err: any) {
            logger.error('[Instantly] Failed to remove domain mailboxes', err, {
                domainId,
                organizationId,
            });
        }

        return { success: successCount, failed: failedCount };
    }

    // ── MAILBOX PAUSE / RESUME (direct account-level) ──────────────────
    // Called by healing service when pausing individual mailboxes.
    // These wrap the Instantly account pause/resume endpoints directly.

    async pauseMailbox(organizationId: string, email: string): Promise<boolean> {
        try {
            const client = await this.getClient(organizationId);
            await instantlyRateLimiter.execute(() =>
                client.post(`/accounts/${encodeURIComponent(email)}/pause`)
            );
            logger.info('[Instantly] Mailbox paused', { email, organizationId });
            return true;
        } catch (err: any) {
            logger.error('[Instantly] Failed to pause mailbox', err, { email });
            return false;
        }
    }

    async resumeMailbox(organizationId: string, email: string): Promise<boolean> {
        try {
            const client = await this.getClient(organizationId);
            await instantlyRateLimiter.execute(() =>
                client.post(`/accounts/${encodeURIComponent(email)}/resume`)
            );
            logger.info('[Instantly] Mailbox resumed', { email, organizationId });
            return true;
        } catch (err: any) {
            logger.error('[Instantly] Failed to resume mailbox', err, { email });
            return false;
        }
    }

    // ── LEAD MOVE (bonus: move leads between campaigns) ────────────────

    async moveLeadToCampaign(
        organizationId: string,
        leadEmail: string,
        fromCampaignId: string,
        toCampaignId: string
    ): Promise<boolean> {
        try {
            const client = await this.getClient(organizationId);

            // Find lead ID in source campaign
            const listRes = await instantlyRateLimiter.execute(() =>
                client.post('/leads/list', {
                    campaign_id: fromCampaignId,
                    email: leadEmail,
                    limit: 10,
                })
            );

            const leads: any[] = listRes.data?.items || listRes.data || [];
            const lead = leads.find((l: any) => l.email === leadEmail);
            if (!lead?.id) {
                logger.warn('[Instantly] Lead not found for move', { leadEmail, fromCampaignId });
                return false;
            }

            await instantlyRateLimiter.execute(() =>
                client.post('/leads/move', {
                    lead_ids: [lead.id],
                    campaign_id: toCampaignId,
                })
            );

            logger.info('[Instantly] Lead moved between campaigns', {
                leadEmail,
                fromCampaignId,
                toCampaignId,
                organizationId,
            });
            return true;
        } catch (err: any) {
            logger.error('[Instantly] Failed to move lead', err, { leadEmail });
            return false;
        }
    }
}
