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
// HISTORICAL BOUNCE BACKFILL
// ============================================================================

/**
 * One-time per-campaign historical bounce backfill.
 *
 * Uses Smartlead's statistics endpoint to fetch all historically bounced leads
 * then calls the message-history endpoint to reverse-engineer which mailbox
 * sent to each lead. Creates BounceEvent records and increments mailbox
 * hard_bounce_count for accurate deliverability assessment from day one.
 *
 * A completed-flag is persisted in OrganizationSetting so the backfill only
 * runs once per campaign even across multiple syncs.
 */
async function backfillBouncesForCampaign(
    campaignId: string,
    organizationId: string,
    apiKey: string,
    sessionId?: string
): Promise<void> {
    const backfillKey = `sl_bounce_backfill:${campaignId}`;

    // Skip if already backfilled for this campaign
    const alreadyDone = await prisma.organizationSetting.findFirst({
        where: { organization_id: organizationId, key: backfillKey },
        select: { id: true },
    });
    if (alreadyDone) return;

    logger.info(`[HistoricalBackfill] Starting for campaign ${campaignId}`, { organizationId });

    // ── 1. Fetch all bounced leads (paginated) ──────────────────────────────
    let offset = 0;
    const PAGE_SIZE = 100;
    let totalBounces = 0;
    const allBouncedLeads: any[] = [];

    try {
        while (true) {
            const statsRes = await smartleadRateLimiter.execute(() =>
                smartleadBreaker.call(() =>
                    axios.get(`${SMARTLEAD_API_BASE}/campaigns/${campaignId}/statistics`, {
                        params: { api_key: apiKey, email_status: 'bounced', offset, limit: PAGE_SIZE },
                    })
                )
            );

            const body = statsRes.data;
            totalBounces = parseInt(String(body?.total_stats || 0));
            const page: any[] = body?.data || [];

            if (page.length === 0) break;
            allBouncedLeads.push(...page);
            if (allBouncedLeads.length >= totalBounces) break;
            offset += PAGE_SIZE;
        }
    } catch (fetchErr: any) {
        // Non-fatal: statistics endpoint may not be available for all account types
        logger.warn(`[HistoricalBackfill] Could not fetch bounced leads for campaign ${campaignId}`, {
            error: fetchErr.message,
        });
        return;
    }

    // Mark as completed even when 0 bounces (avoids re-checking every sync)
    if (allBouncedLeads.length === 0) {
        await prisma.organizationSetting.upsert({
            where: { organization_id_key: { organization_id: organizationId, key: backfillKey } },
            update: { value: new Date().toISOString() },
            create: { organization_id: organizationId, key: backfillKey, value: new Date().toISOString() },
        });
        return;
    }

    logger.info(`[HistoricalBackfill] Found ${totalBounces} historical bounces for campaign ${campaignId}`, { organizationId });

    // ── 2. Process bounces with rate limiting ───────────────────────────────
    const internalCampaignId = `sl-${campaignId}`;
    const BATCH_SIZE = 10;
    let processed = 0;
    let attributed = 0;

    for (let i = 0; i < allBouncedLeads.length; i += BATCH_SIZE) {
        const batch = allBouncedLeads.slice(i, i + BATCH_SIZE);

        if (sessionId) {
            syncProgressService.emitProgress(sessionId, 'historical_bounces', 'in_progress', {
                current: i,
                total: allBouncedLeads.length,
                message: `Backfilling historical bounces: ${i}/${allBouncedLeads.length}`,
            });
        }

        await Promise.all(batch.map(async (bouncedLead: any) => {
            const leadEmail: string = bouncedLead.lead_email || bouncedLead.email || '';
            if (!leadEmail) return;

            const bouncedAt = new Date(bouncedLead.sent_time || bouncedLead.bounced_at || Date.now());
            // Smartlead's statistics response typically includes the numeric lead ID
            const smartleadLeadId: string | number | undefined = bouncedLead.id || bouncedLead.lead_id;

            // ── Dedup: skip if this exact bounce is already recorded ──
            const existing = await prisma.bounceEvent.findFirst({
                where: { organization_id: organizationId, email_address: leadEmail, bounced_at: bouncedAt },
                select: { id: true },
            });
            if (existing) { processed++; return; }

            // ── Resolve sender mailbox via message-history ──────────────────
            let mailboxId: string | null = null;
            if (smartleadLeadId) {
                try {
                    const historyRes = await smartleadRateLimiter.execute(() =>
                        smartleadBreaker.call(() =>
                            axios.get(
                                `${SMARTLEAD_API_BASE}/campaigns/${campaignId}/leads/${smartleadLeadId}/message-history`,
                                { params: { api_key: apiKey } }
                            )
                        )
                    );
                    const senderEmail: string | undefined = historyRes.data?.from;
                    if (senderEmail) {
                        const mailbox = await prisma.mailbox.findFirst({
                            where: { organization_id: organizationId, email: senderEmail },
                            select: { id: true },
                        });
                        if (mailbox) {
                            mailboxId = mailbox.id;
                            attributed++;
                        } else {
                            logger.warn(`[HistoricalBackfill] Sender mailbox not in DB: ${senderEmail}`, { organizationId });
                        }
                    }
                } catch (histErr: any) {
                    // Non-fatal: message-history may 404 for old/deleted leads
                    logger.debug(`[HistoricalBackfill] message-history failed for lead ${leadEmail}`, {
                        error: histErr.message,
                    });
                }
            }

            // ── Look up our DB lead ID for the BounceEvent FK ──────────────
            const dbLead = await prisma.lead.findFirst({
                where: { organization_id: organizationId, email: leadEmail },
                select: { id: true },
            });

            // ── Create BounceEvent ──────────────────────────────────────────
            await prisma.bounceEvent.create({
                data: {
                    organization_id: organizationId,
                    lead_id: dbLead?.id ?? null,
                    mailbox_id: mailboxId,
                    campaign_id: internalCampaignId,
                    bounce_type: 'HARD',
                    email_address: leadEmail,
                    bounced_at: bouncedAt,
                },
            });

            // ── Increment mailbox hard_bounce_count if attributed ───────────
            if (mailboxId) {
                await prisma.mailbox.update({
                    where: { id: mailboxId },
                    data: { hard_bounce_count: { increment: 1 } },
                });
            }

            processed++;
        }));

        // Respect rate limit between batches (10 req / 2 s)
        if (i + BATCH_SIZE < allBouncedLeads.length) {
            await new Promise(resolve => setTimeout(resolve, 2000));
        }

        if ((i + BATCH_SIZE) % 100 === 0 || i + BATCH_SIZE >= allBouncedLeads.length) {
            logger.info(`[HistoricalBackfill] Progress: ${Math.min(i + BATCH_SIZE, allBouncedLeads.length)}/${allBouncedLeads.length} bounces`, {
                organizationId,
                campaignId,
            });
        }
    }

    // ── Mark backfill as completed ──────────────────────────────────────────
    await prisma.organizationSetting.upsert({
        where: { organization_id_key: { organization_id: organizationId, key: backfillKey } },
        update: { value: new Date().toISOString() },
        create: { organization_id: organizationId, key: backfillKey, value: new Date().toISOString() },
    });

    logger.info(`[HistoricalBackfill] Completed for campaign ${campaignId}: ${processed} processed, ${attributed} mailbox-attributed`, {
        organizationId,
    });
}

/**
 * Sync campaigns, mailboxes, AND leads from Smartlead.
 */
export const syncSmartlead = async (organizationId: string, sessionId?: string): Promise<{
    campaigns: number;
    mailboxes: number;
    leads: number;
}> => {
    const apiKey = await getApiKey(organizationId);
    if (!apiKey) {
        throw new Error('Smartlead API key not configured');
    }

    const lockKey = `sync:smartlead:org:${organizationId}`;
    const acquired = await acquireLock(lockKey, 15 * 60); // 15 min TTL
    if (!acquired) {
        const errMsg = `Sync already in progress for organization ${organizationId}`;
        logger.warn(`[SmartleadSync] ${errMsg}`);
        if (sessionId) syncProgressService.emitError(sessionId, errMsg);
        throw new Error(errMsg);
    }

    // Debug: Log API key format (first/last 4 chars only for security)
    const maskedKey = apiKey.length > 8
        ? `${apiKey.substring(0, 4)}...${apiKey.substring(apiKey.length - 4)}`
        : '****';
    logger.info(`[SmartleadSync] Using API key: ${maskedKey} for org ${organizationId}`);

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

    // Get organization subscription info for capacity checks
    const org = await prisma.organization.findUnique({
        where: { id: organizationId },
        select: {
            subscription_tier: true,
            subscription_status: true,
            current_domain_count: true,
            current_mailbox_count: true,
            current_lead_count: true
        }
    });

    if (!org) {
        throw new Error('Organization not found');
    }

    // Check if subscription is active
    const blockedStatuses = ['expired', 'past_due', 'canceled'];
    if (blockedStatuses.includes(org.subscription_status)) {
        throw new Error(`Cannot sync: subscription ${org.subscription_status}. Please upgrade to continue.`);
    }

    const limits = TIER_LIMITS[org.subscription_tier] || TIER_LIMITS.trial;

    try {
        // ── 1. Fetch campaigns (protected by circuit breaker) ──
        if (sessionId) {
            syncProgressService.emitProgress(sessionId, 'campaigns', 'in_progress', { total: 0 });
        }

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

        // Log first campaign structure to see available fields
        if (campaigns.length > 0) {
            logger.info('[CampaignSync] First campaign structure', {
                campaignSample: campaigns[0],
                campaignKeys: Object.keys(campaigns[0])
            });
        }

        if (sessionId) {
            syncProgressService.emitProgress(sessionId, 'campaigns', 'in_progress', {
                current: 0,
                total: campaigns.length
            });
        }

        let campaignUpserts = [];
        for (let i = 0; i < campaigns.length; i++) {
            const campaign = campaigns[i];
            // ── Fetch detailed analytics from Smartlead (sent, opens, clicks, bounces) ──
            let analytics = {
                sent_count: 0,
                open_count: 0,
                click_count: 0,
                reply_count: 0,
                bounce_count: 0,
                unsubscribed_count: 0
            };

            try {
                const analyticsRes = await smartleadBreaker.call(() =>
                    axios.get(`${SMARTLEAD_API_BASE}/campaigns/${campaign.id}/analytics`, {
                        params: { api_key: apiKey }
                    })
                );
                analytics = analyticsRes.data || analytics;

                logger.info('[CampaignSync] Fetched campaign analytics', {
                    campaignId: campaign.id,
                    campaignName: campaign.name,
                    sent: analytics.sent_count,
                    opens: analytics.open_count,
                    replies: analytics.reply_count,
                    bounces: analytics.bounce_count
                });
            } catch (analyticsError: any) {
                logger.warn('[CampaignSync] Failed to fetch campaign analytics', {
                    campaignId: campaign.id,
                    error: analyticsError.message
                });
            }

            const totalSent = parseInt(String(analytics.sent_count || '0'));
            const totalBounced = parseInt(String(analytics.bounce_count || '0'));
            const totalOpens = parseInt(String(analytics.open_count || '0'));
            const totalClicks = parseInt(String(analytics.click_count || '0'));
            const totalReplies = parseInt(String(analytics.reply_count || '0'));
            const totalUnsubscribed = parseInt(String(analytics.unsubscribed_count || '0'));

            const bounceRate = totalSent > 0 ? (totalBounced / totalSent) * 100 : 0;
            const openRate = totalSent > 0 ? (totalOpens / totalSent) * 100 : 0;
            const clickRate = totalSent > 0 ? (totalClicks / totalSent) * 100 : 0;
            const replyRate = totalSent > 0 ? (totalReplies / totalSent) * 100 : 0;

            if (bounceRate > 0) {
                logger.info('[CampaignSync] Campaign bounce rate synced', {
                    campaignId: campaign.id,
                    campaignName: campaign.name,
                    bounceRate: bounceRate.toFixed(2) + '%',
                    totalSent,
                    totalBounced
                });
            }

            campaignUpserts.push(
                prisma.campaign.upsert({
                    where: { id: campaign.id.toString() },
                    update: {
                        name: campaign.name,
                        status: (campaign.status || 'active').toLowerCase(),
                        bounce_rate: bounceRate,
                        total_sent: totalSent,
                        total_bounced: totalBounced,
                        open_count: totalOpens,
                        click_count: totalClicks,
                        reply_count: totalReplies,
                        unsubscribed_count: totalUnsubscribed,
                        open_rate: openRate,
                        click_rate: clickRate,
                        reply_rate: replyRate,
                        analytics_updated_at: new Date(),
                        last_synced_at: new Date(),
                        organization_id: organizationId
                    },
                    create: {
                        id: campaign.id.toString(),
                        name: campaign.name,
                        status: (campaign.status || 'active').toLowerCase(),
                        bounce_rate: bounceRate,
                        total_sent: totalSent,
                        total_bounced: totalBounced,
                        open_count: totalOpens,
                        click_count: totalClicks,
                        reply_count: totalReplies,
                        unsubscribed_count: totalUnsubscribed,
                        open_rate: openRate,
                        click_rate: clickRate,
                        reply_rate: replyRate,
                        analytics_updated_at: new Date(),
                        organization_id: organizationId
                    }
                })
            );

            campaignCount++;

            if (campaignUpserts.length >= 50 || i === campaigns.length - 1) {
                await prisma.$transaction(campaignUpserts);
                campaignUpserts = [];
                if (sessionId) {
                    syncProgressService.emitProgress(sessionId, 'campaigns', 'in_progress', {
                        current: campaignCount,
                        total: campaigns.length
                    });
                }
            }
        }

        if (sessionId) {
            syncProgressService.emitProgress(sessionId, 'campaigns', 'completed', {
                count: campaignCount
            });
            syncProgressService.emitProgress(sessionId, 'mailboxes', 'in_progress', { total: 0 });
        }

        // ── 2. Fetch email accounts (mailboxes) (protected by circuit breaker) ──
        const mailboxesRes = await smartleadBreaker.call(() =>
            axios.get(`${SMARTLEAD_API_BASE}/email-accounts?api_key=${apiKey}`)
        );
        const mailboxes = mailboxesRes.data || [];

        // Log first mailbox structure to see if it includes campaign assignments
        if (mailboxes.length > 0) {
            logger.info('[MailboxSync] First mailbox structure', {
                mailboxSample: mailboxes[0],
                mailboxKeys: Object.keys(mailboxes[0])
            });
        }

        if (sessionId) {
            syncProgressService.emitProgress(sessionId, 'mailboxes', 'in_progress', {
                current: 0,
                total: mailboxes.length
            });
        }

        const existingDomains = await prisma.domain.findMany({ where: { organization_id: organizationId } });
        const domainMap = new Map(existingDomains.map(d => [d.domain, d]));

        const existingMailboxes = await prisma.mailbox.findMany({ where: { organization_id: organizationId }, select: { id: true } });
        const existingMailboxSet = new Set(existingMailboxes.map(m => m.id));

        const uniqueDomainNames = [...new Set(mailboxes.map((m: any) => (m.from_email || m.email || '').split('@')[1] || 'unknown.com'))];
        const newDomains = uniqueDomainNames.filter(d => !domainMap.has(d as string));

        if (newDomains.length > 0) {
            const domainsToCreate = [];
            for (const domainName of newDomains) {
                if (org.current_domain_count >= limits.domains) {
                    logger.warn('[Smartlead Sync] Domain capacity reached, skipping domain creation', {
                        organizationId,
                        current: org.current_domain_count,
                        limit: limits.domains,
                        tier: org.subscription_tier,
                        skippedDomain: domainName
                    });
                    continue; // Skip this domain
                }
                domainsToCreate.push({
                    domain: domainName as string,
                    status: 'healthy',
                    organization_id: organizationId
                });
                org.current_domain_count++;
            }
            if (domainsToCreate.length > 0) {
                await prisma.domain.createMany({ data: domainsToCreate });
                await prisma.organization.update({
                    where: { id: organizationId },
                    data: { current_domain_count: org.current_domain_count }
                });
                const updatedDomains = await prisma.domain.findMany({ where: { organization_id: organizationId } });
                updatedDomains.forEach(d => domainMap.set(d.domain, d));
            }
        }

        let mailboxUpserts = [];
        let mailboxesToIncrement = 0;

        for (let i = 0; i < mailboxes.length; i++) {
            const mailbox = mailboxes[i];
            // Extract domain from email
            const email = mailbox.from_email || mailbox.email || '';
            const domainName = email.split('@')[1] || 'unknown.com';
            const domain = domainMap.get(domainName);

            if (!domain) {
                continue; // Domain was skipped due to capacity limits
            }

            const isNewMailbox = !existingMailboxSet.has(mailbox.id.toString());
            if (isNewMailbox) {
                // Check mailbox capacity before creating
                if (org.current_mailbox_count >= limits.mailboxes) {
                    logger.warn('[Smartlead Sync] Mailbox capacity reached, skipping mailbox creation', {
                        organizationId,
                        current: org.current_mailbox_count,
                        limit: limits.mailboxes,
                        tier: org.subscription_tier,
                        skippedEmail: email
                    });
                    continue; // Skip this mailbox
                }
                org.current_mailbox_count++;
                mailboxesToIncrement++;
            }

            // Determine mailbox health status based on connection state
            // CRITICAL: Check SMTP/IMAP connection status, not just account status
            const isConnected = mailbox.is_smtp_success === true && mailbox.is_imap_success === true;
            const connectionError = mailbox.smtp_failure_error || mailbox.imap_failure_error;

            let mailboxStatus: string;
            if (!isConnected) {
                mailboxStatus = 'paused'; // Disconnected/suspended mailboxes are paused
                if (connectionError) {
                    logger.warn('[MailboxSync] Mailbox connection failure detected', {
                        email,
                        smtp_success: mailbox.is_smtp_success,
                        imap_success: mailbox.is_imap_success,
                        error: connectionError
                    });
                }
            } else if (mailbox.status !== 'ACTIVE') {
                mailboxStatus = 'paused';
            } else {
                mailboxStatus = 'healthy';
            }

            // Extract warmup data if available (SOFT SIGNALS - informational only)
            const warmupStatus = mailbox.warmup_status || mailbox.warmup_details?.status || null;
            const warmupReputation = mailbox.warmup_reputation || mailbox.warmup_details?.warmup_reputation || null;
            const warmupLimit = mailbox.warmup_details?.total_warmup_per_day || mailbox.total_warmup_per_day || 0;

            // Extract stats from Smartlead API response
            const warmupSpamCount = mailbox.warmup_details?.total_spam_count || 0;

            // Upsert mailbox with connection diagnostics and stats
            // NOTE: total_sent_count is NOT set here — it's calculated from campaign CSV data
            // during lead engagement processing (step 4) for accurate lifetime totals.
            // daily_sent_count from Smartlead is only today's count, not lifetime.
            mailboxUpserts.push(
                prisma.mailbox.upsert({
                    where: { id: mailbox.id.toString() },
                    update: {
                        email,
                        smartlead_email_account_id: mailbox.id,
                        status: mailboxStatus,
                        smtp_status: mailbox.is_smtp_success === true,
                        imap_status: mailbox.is_imap_success === true,
                        connection_error: connectionError || null,
                        spam_count: warmupSpamCount,
                        warmup_status: warmupStatus,
                        warmup_reputation: warmupReputation,
                        warmup_limit: warmupLimit,
                        last_activity_at: new Date()
                    },
                    create: {
                        id: mailbox.id.toString(),
                        email,
                        smartlead_email_account_id: mailbox.id,
                        status: mailboxStatus,
                        smtp_status: mailbox.is_smtp_success === true,
                        imap_status: mailbox.is_imap_success === true,
                        connection_error: connectionError || null,
                        spam_count: warmupSpamCount,
                        warmup_status: warmupStatus,
                        warmup_reputation: warmupReputation,
                        warmup_limit: warmupLimit,
                        domain_id: domain.id,
                        organization_id: organizationId
                    }
                })
            );

            mailboxCount++;

            if (mailboxUpserts.length >= 50 || i === mailboxes.length - 1) {
                await prisma.$transaction(mailboxUpserts);
                mailboxUpserts = [];
                if (sessionId) {
                    syncProgressService.emitProgress(sessionId, 'mailboxes', 'in_progress', {
                        current: mailboxCount,
                        total: mailboxes.length
                    });
                }
            }
        }

        if (mailboxesToIncrement > 0) {
            await prisma.organization.update({
                where: { id: organizationId },
                data: { current_mailbox_count: org.current_mailbox_count }
            });
        }

        if (sessionId) {
            syncProgressService.emitProgress(sessionId, 'mailboxes', 'completed', {
                count: mailboxCount
            });
            syncProgressService.emitProgress(sessionId, 'leads', 'in_progress', { total: 0 });
        }

        // ── 3. Link campaigns to mailboxes by fetching email account assignments ──
        for (const campaign of campaigns) {
            const campaignId = campaign.id.toString();

            try {
                // Fetch email accounts assigned to this campaign
                logger.info(`[CampaignMailboxSync] Fetching email accounts for campaign ${campaignId}`);

                const campaignEmailAccountsRes = await smartleadBreaker.call(() =>
                    axios.get(`${SMARTLEAD_API_BASE}/campaigns/${campaignId}/email-accounts`, {
                        params: { api_key: apiKey }
                    })
                );

                const emailAccounts = campaignEmailAccountsRes.data || [];
                logger.info(`[CampaignMailboxSync] Found ${emailAccounts.length} email accounts for campaign ${campaignId}`);

                // Connect mailboxes to this campaign
                const mailboxIds = emailAccounts
                    .map((ea: any) => ea.id?.toString() || ea.email_account_id?.toString())
                    .filter(Boolean);

                if (mailboxIds.length > 0) {
                    // Update campaign to connect mailboxes
                    await prisma.campaign.update({
                        where: { id: campaignId },
                        data: {
                            mailboxes: {
                                connect: mailboxIds.map((id: string) => ({ id }))
                            }
                        }
                    });

                    logger.info(`[CampaignMailboxSync] Linked ${mailboxIds.length} mailboxes to campaign ${campaignId}`);
                }
            } catch (emailAccountError: any) {
                // Log but don't fail the sync if email account fetching fails
                logger.error(`[CampaignMailboxSync] Failed to fetch email accounts for campaign ${campaignId}`, emailAccountError, {
                    status: emailAccountError.response?.status,
                    data: emailAccountError.response?.data
                });

                // Notify user about linking failure
                try {
                    const campaign = campaigns.find((c: any) => c.id.toString() === campaignId);
                    await notificationService.createNotification(organizationId, {
                        type: 'WARNING',
                        title: 'Campaign Linking Issue',
                        message: `Could not link mailboxes to campaign "${campaign?.name || campaignId}". Check your Smartlead configuration and API permissions.`
                    });
                } catch (notifError) {
                    // Don't fail sync if notification creation fails
                    logger.warn('[CampaignMailboxSync] Failed to create notification', { error: notifError });
                }
            }
        }

        // ── 4. Fetch leads for each campaign from Smartlead ──

        // ── Reset mailbox engagement stats before recalculating from CSV data ──
        // This prevents accumulation on re-syncs (each sync recalculates from scratch)
        await prisma.mailbox.updateMany({
            where: { organization_id: organizationId },
            data: {
                open_count_lifetime: 0,
                click_count_lifetime: 0,
                reply_count_lifetime: 0,
                total_sent_count: 0,
                engagement_rate: 0,
            }
        });
        logger.info('[MailboxStats] Reset mailbox engagement stats for clean recalculation', { organizationId });

        if (sessionId) {
            syncProgressService.emitProgress(sessionId, 'leads', 'in_progress', {
                current: 0,
                total: campaigns.length
            });
        }

        let campaignIndex = 0;
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

                    const leadUpserts = [];
                    const existingLeads = await prisma.lead.findMany({
                        where: {
                            organization_id: organizationId,
                            email: { in: leadsList.map((l: any) => (l.lead || l).email || (l.lead || l).lead_email || '').filter(Boolean) }
                        },
                        select: { email: true }
                    });
                    const existingLeadSet = new Set(existingLeads.map(l => l.email));

                    for (const leadData of leadsList) {
                        // Smartlead returns leads wrapped in a container object with nested 'lead' property
                        const lead = leadData.lead || leadData;

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
                                leadSample: lead,
                                originalLeadData: leadData
                            });
                            continue;
                        }

                        const isNewLead = !existingLeadSet.has(email);
                        if (isNewLead) {
                            if (org.current_lead_count >= limits.leads) {
                                logger.warn('[Smartlead Sync] Lead capacity reached, skipping lead creation', {
                                    organizationId,
                                    current: org.current_lead_count,
                                    limit: limits.leads,
                                    tier: org.subscription_tier,
                                    skippedEmail: email
                                });
                                continue;
                            }
                            org.current_lead_count++;
                            existingLeadSet.add(email); // Add to set so we don't count duplicate emails as new
                        }

                        const firstName = lead.first_name || lead.firstName || '';
                        const lastName = lead.last_name || lead.lastName || '';
                        const company = lead.company_name || lead.company || '';
                        const persona = company || 'general';

                        // Note: /campaigns/{id}/leads endpoint does NOT include engagement stats
                        // We'll fetch those separately using CSV export endpoint after contact sync completes
                        leadUpserts.push(
                            prisma.lead.upsert({
                                where: {
                                    organization_id_email: {
                                        organization_id: organizationId,
                                        email
                                    }
                                },
                                update: {
                                    assigned_campaign_id: campaignId,
                                    updated_at: new Date()
                                    // Note: Status is intentionally NOT updated here
                                    // - Smartlead leads are created as 'active'
                                    // - Clay leads stay 'held' until execution gate approves them
                                    // - Status changes only via execution gate or monitoring service
                                },
                                create: {
                                    email,
                                    persona,
                                    lead_score: 50, // Default neutral score
                                    source: 'smartlead',
                                    status: 'active', // Pre-existing leads in Smartlead campaigns are already approved
                                    health_classification: 'green',
                                    emails_sent: 0,
                                    emails_opened: 0,
                                    emails_clicked: 0,
                                    emails_replied: 0,
                                    assigned_campaign_id: campaignId,
                                    organization_id: organizationId
                                }
                            })
                        );

                        leadCount++;
                        campaignLeadCount++;
                    }

                    if (leadUpserts.length > 0) {
                        await prisma.$transaction(leadUpserts);
                        await prisma.organization.update({
                            where: { id: organizationId },
                            data: { current_lead_count: org.current_lead_count }
                        });
                    }

                    // If we got fewer than the limit, no more pages
                    if (leadsList.length < limit) {
                        hasMore = false;
                    } else {
                        offset += limit;
                    }
                }

                logger.info(`Synced ${campaignLeadCount} lead contacts for campaign ${campaignId}`, {
                    organizationId,
                    campaignId,
                    campaignName: campaign.name
                });

                // ── Fetch engagement stats: Try lead-statistics API first, fall back to CSV export ──
                let engagementFetched = false;

                // ── Fetch engagement stats from CSV export endpoint ──
                // We use CSV export instead of the lead-statistics API because the CSV contains
                // critical `sender_email` and `bounce` data needed for attributing stats back to specific mailboxes.
                // Note: /campaigns/{id}/leads-export returns CSV with open_count, click_count, reply_count, bounces
                try {
                    logger.info(`[LeadEngagement] Fetching engagement stats from CSV export for campaign ${campaignId}`);

                    const csvRes = await smartleadBreaker.call(() =>
                        axios.get(`${SMARTLEAD_API_BASE}/campaigns/${campaignId}/leads-export`, {
                            params: { api_key: apiKey },
                            responseType: 'text' // Important: Get raw text, not parsed JSON
                        })
                    );

                    const csvData = csvRes.data;

                    // Debug: Log first 500 characters of CSV to see structure
                    logger.info(`[LeadEngagement] CSV sample for campaign ${campaignId}:`, {
                        sample: csvData.substring(0, 500),
                        length: csvData.length
                    });

                    // Parse CSV data
                    const records = parse(csvData, {
                        columns: true, // Use first row as column names
                        skip_empty_lines: true,
                        trim: true
                    });

                    logger.info(`[LeadEngagement] Parsed ${records.length} leads from CSV for campaign ${campaignId}`);

                    // Debug: Log first record to see column structure
                    if (records.length > 0) {
                        const firstRecord = records[0] as any;
                        logger.info(`[LeadEngagement] CSV columns for campaign ${campaignId}:`, {
                            columns: Object.keys(firstRecord),
                            sampleRecord: firstRecord
                        });
                    }

                    // Update each lead with engagement stats
                    let updatedCount = 0;
                    let recordsWithEngagement = 0;
                    // Tracks leads with engagement but no sender info (for proportional fallback)
                    let unattributedCount = 0;
                    let totalUnattributedOpens = 0;
                    let totalUnattributedClicks = 0;
                    let totalUnattributedReplies = 0;
                    for (const record of records) {
                        const rec = record as any; // Type assertion for CSV record
                        const email = rec.email || rec.Email || rec.EMAIL;
                        if (!email) continue;

                        const openCount = parseInt(rec.open_count || rec.opens || '0');
                        const clickCount = parseInt(rec.click_count || rec.clicks || '0');
                        const replyCount = parseInt(rec.reply_count || rec.replies || '0');

                        // Extract bounce data
                        const bounceCount = parseInt(rec.bounce_count || rec.bounces || rec.bounced || '0');
                        const bouncedStatus = rec.bounced === 'true' || rec.bounced === '1' || rec.bounced === 1;

                        // Extract sender information (which mailbox sent to this lead)
                        const senderEmail = rec.sender_email || rec.from_email || rec.sent_from || rec.email_account || rec.sender;
                        const senderAccountId = rec.sender_account_id || rec.email_account_id || rec.from_account_id;

                        // Debug: Log first 3 records with details
                        if (updatedCount < 3) {
                            logger.info(`[LeadEngagement] Sample lead ${updatedCount + 1}:`, {
                                email,
                                opens: openCount,
                                clicks: clickCount,
                                replies: replyCount,
                                bounces: bounceCount,
                                bounced: bouncedStatus,
                                senderEmail,
                                senderAccountId,
                                availableFields: Object.keys(rec),
                                rawRecord: rec
                            });
                        }

                        if (openCount > 0 || clickCount > 0 || replyCount > 0) {
                            recordsWithEngagement++;
                        }

                        // Update lead with engagement stats including bounces
                        try {
                            const leadUpdateData: any = {
                                emails_opened: openCount,
                                emails_clicked: clickCount,
                                emails_replied: replyCount,
                                last_activity_at: (openCount > 0 || clickCount > 0 || replyCount > 0) ? new Date() : undefined
                            };

                            // Add bounce data if lead bounced
                            if (bouncedStatus || bounceCount > 0) {
                                leadUpdateData.bounced = bouncedStatus;
                                // Note: We don't have a bounce_count field on Lead model currently
                                // This will be tracked via hard_bounce events in webhooks
                            }

                            // Calculate engagement score using canonical formula
                            if (openCount > 0 || clickCount > 0 || replyCount > 0) {
                                const engagement = {
                                    opens: openCount,
                                    clicks: clickCount,
                                    replies: replyCount,
                                    bounces: 0
                                };
                                const breakdown = calculateEngagementScore(engagement);
                                leadUpdateData.lead_score = calculateFinalScore(breakdown);
                            }

                            const updatedLead = await prisma.lead.update({
                                where: {
                                    organization_id_email: {
                                        organization_id: organizationId,
                                        email
                                    }
                                },
                                data: leadUpdateData,
                                select: { id: true }
                            });

                            // Backfill activity for leads with engagement
                            // Use lead UUID (not email) as entityId so frontend can query correctly
                            // DEDUP: Only create backfill entries if none exist yet for this lead
                            if (openCount > 0 || clickCount > 0 || replyCount > 0) {
                                const leadUuid = updatedLead.id;

                                // Check if backfill entries already exist for this lead
                                const existingBackfill = await prisma.auditLog.findFirst({
                                    where: {
                                        organization_id: organizationId,
                                        entity: 'lead',
                                        entity_id: leadUuid,
                                        trigger: 'smartlead_sync',
                                        action: { in: ['email_opened', 'email_clicked', 'email_replied'] }
                                    },
                                    select: { id: true }
                                });

                                // Only create backfill entries on first sync (no existing entries)
                                if (!existingBackfill) {
                                    if (openCount > 0) {
                                        await auditLogService.logAction({
                                            organizationId,
                                            entity: 'lead',
                                            entityId: leadUuid,
                                            trigger: 'smartlead_sync',
                                            action: 'email_opened',
                                            details: `Email opened ${openCount} time(s) (backfilled from sync)${senderEmail ? ` via ${senderEmail}` : ''}`
                                        });
                                    }
                                    if (clickCount > 0) {
                                        await auditLogService.logAction({
                                            organizationId,
                                            entity: 'lead',
                                            entityId: leadUuid,
                                            trigger: 'smartlead_sync',
                                            action: 'email_clicked',
                                            details: `Email link clicked ${clickCount} time(s) (backfilled from sync)${senderEmail ? ` via ${senderEmail}` : ''}`
                                        });
                                    }
                                    if (replyCount > 0) {
                                        await auditLogService.logAction({
                                            organizationId,
                                            entity: 'lead',
                                            entityId: leadUuid,
                                            trigger: 'smartlead_sync',
                                            action: 'email_replied',
                                            details: `Email replied ${replyCount} time(s) (backfilled from sync)${senderEmail ? ` via ${senderEmail}` : ''}`
                                        });
                                    }
                                }
                            }

                            // ── MAILBOX ATTRIBUTION: Update mailbox stats if sender is known ──
                            // Only update mailbox stats if CSV provides accurate sender information
                            if (senderEmail || senderAccountId) {
                                try {
                                    // Find the mailbox by email or Smartlead account ID
                                    const mailbox = await prisma.mailbox.findFirst({
                                        where: {
                                            organization_id: organizationId,
                                            OR: [
                                                { email: senderEmail },
                                                { smartlead_email_account_id: senderAccountId ? parseInt(senderAccountId) : undefined }
                                            ].filter(condition => {
                                                // Remove undefined conditions
                                                if ('email' in condition) return !!condition.email;
                                                if ('smartlead_email_account_id' in condition) return condition.smartlead_email_account_id !== undefined;
                                                return false;
                                            })
                                        },
                                        select: {
                                            id: true,
                                            email: true,
                                            open_count_lifetime: true,
                                            click_count_lifetime: true,
                                            reply_count_lifetime: true,
                                            total_sent_count: true
                                        }
                                    });

                                    if (mailbox) {
                                        // Calculate new stats
                                        const newOpens = mailbox.open_count_lifetime + openCount;
                                        const newClicks = mailbox.click_count_lifetime + clickCount;
                                        const newReplies = mailbox.reply_count_lifetime + replyCount;
                                        const totalEngagement = newOpens + newClicks + newReplies;
                                        const engagementRate = mailbox.total_sent_count > 0
                                            ? (totalEngagement / mailbox.total_sent_count) * 100
                                            : 0;

                                        await prisma.mailbox.update({
                                            where: { id: mailbox.id },
                                            data: {
                                                open_count_lifetime: newOpens,
                                                click_count_lifetime: newClicks,
                                                reply_count_lifetime: newReplies,
                                                engagement_rate: engagementRate
                                            }
                                        });

                                        logger.debug(`[LeadEngagement] Updated mailbox ${mailbox.email} stats`, {
                                            leadEmail: email,
                                            opensAdded: openCount,
                                            clicksAdded: clickCount,
                                            repliesAdded: replyCount
                                        });
                                    } else {
                                        logger.warn(`[LeadEngagement] Sender mailbox not found for lead ${email}`, {
                                            senderEmail,
                                            senderAccountId
                                        });
                                    }
                                } catch (mailboxError: any) {
                                    logger.error(`[LeadEngagement] Failed to update mailbox stats for lead ${email}`, mailboxError);
                                }
                            } else {
                                // No sender info - can't attribute to specific mailbox.
                                // Track engagement totals for proportional fallback below.
                                if (openCount > 0 || clickCount > 0 || replyCount > 0) {
                                    unattributedCount++;
                                    totalUnattributedOpens += openCount;
                                    totalUnattributedClicks += clickCount;
                                    totalUnattributedReplies += replyCount;
                                }
                                logger.debug(`[LeadEngagement] No sender info for lead ${email} - skipping mailbox attribution`);
                            }

                            updatedCount++;
                        } catch (updateError: any) {
                            // Lead might not exist if it was filtered out during contact sync
                            logger.debug(`[LeadEngagement] Skipping engagement update for ${email}`, {
                                error: updateError.message
                            });
                        }
                    }

                    // ── Issue H: Proportional fallback for unattributed engagement ──
                    // When the CSV lacks sender fields, distribute aggregate engagement
                    // equally across all mailboxes linked to this campaign.
                    if (unattributedCount > 0) {
                        if (sessionId) {
                            syncProgressService.emitProgress(sessionId, 'leads', 'in_progress', {
                                warning: `${unattributedCount} leads had engagement but no sender attribution. Stats distributed proportionally across campaign mailboxes.`,
                                current: campaignIndex,
                                total: campaigns.length,
                            });
                        }

                        try {
                            const campaignMailboxes = await prisma.mailbox.findMany({
                                where: {
                                    campaigns: { some: { id: campaignId } },
                                    organization_id: organizationId,
                                },
                                select: {
                                    id: true,
                                    open_count_lifetime: true,
                                    click_count_lifetime: true,
                                    reply_count_lifetime: true,
                                    total_sent_count: true,
                                },
                            });

                            if (campaignMailboxes.length > 0) {
                                const divisor = campaignMailboxes.length;
                                const perMailboxOpens = Math.round(totalUnattributedOpens / divisor);
                                const perMailboxClicks = Math.round(totalUnattributedClicks / divisor);
                                const perMailboxReplies = Math.round(totalUnattributedReplies / divisor);

                                for (const mb of campaignMailboxes) {
                                    const newOpens = mb.open_count_lifetime + perMailboxOpens;
                                    const newClicks = mb.click_count_lifetime + perMailboxClicks;
                                    const newReplies = mb.reply_count_lifetime + perMailboxReplies;
                                    const totalEngagement = newOpens + newClicks + newReplies;
                                    const engagementRate = mb.total_sent_count > 0
                                        ? (totalEngagement / mb.total_sent_count) * 100
                                        : 0;

                                    await prisma.mailbox.update({
                                        where: { id: mb.id },
                                        data: {
                                            open_count_lifetime: newOpens,
                                            click_count_lifetime: newClicks,
                                            reply_count_lifetime: newReplies,
                                            engagement_rate: engagementRate,
                                        },
                                    });
                                }

                                logger.info(`[LeadEngagement] Distributed unattributed engagement proportionally for campaign ${campaignId}`, {
                                    organizationId,
                                    unattributedLeads: unattributedCount,
                                    mailboxCount: campaignMailboxes.length,
                                    perMailboxOpens,
                                    perMailboxClicks,
                                    perMailboxReplies,
                                });
                            } else {
                                logger.warn(`[LeadEngagement] No mailboxes linked to campaign ${campaignId} — proportional fallback skipped`, {
                                    organizationId,
                                    unattributedCount,
                                });
                            }
                        } catch (fallbackErr: any) {
                            logger.error(`[LeadEngagement] Proportional fallback failed for campaign ${campaignId}`, fallbackErr, {
                                organizationId,
                            });
                        }
                    }

                    logger.info(`[LeadEngagement] Updated ${updatedCount} leads with engagement stats for campaign ${campaignId}`, {
                        totalRecords: records.length,
                        recordsWithEngagement,
                        unattributedCount,
                        recordsWithoutEngagement: records.length - recordsWithEngagement
                    });
                } catch (csvError: any) {
                    // Don't fail the entire sync if CSV parsing fails - contact data is already synced
                    logger.error(`[LeadEngagement] Failed to fetch engagement stats from CSV for campaign ${campaignId}`, csvError, {
                        organizationId,
                        campaignId,
                        response: csvError.response?.data,
                        status: csvError.response?.status
                    });
                }
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

            // ── Distribute campaign total_sent to linked mailboxes ──────────
            // Since Smartlead doesn't provide per-mailbox sent counts, distribute
            // campaign total_sent proportionally across linked mailboxes.
            try {
                const dbCampaign = await prisma.campaign.findUnique({
                    where: { id: campaignId },
                    select: { total_sent: true }
                });
                const campaignTotalSent = dbCampaign?.total_sent || 0;

                if (campaignTotalSent > 0) {
                    const linkedMailboxes = await prisma.mailbox.findMany({
                        where: {
                            campaigns: { some: { id: campaignId } },
                            organization_id: organizationId,
                        },
                        select: { id: true, total_sent_count: true }
                    });

                    if (linkedMailboxes.length > 0) {
                        const perMailboxSent = Math.round(campaignTotalSent / linkedMailboxes.length);
                        for (const mb of linkedMailboxes) {
                            await prisma.mailbox.update({
                                where: { id: mb.id },
                                data: {
                                    total_sent_count: { increment: perMailboxSent }
                                }
                            });
                        }
                        logger.info(`[MailboxStats] Distributed ${campaignTotalSent} total_sent across ${linkedMailboxes.length} mailboxes for campaign ${campaignId}`, {
                            organizationId,
                            perMailboxSent,
                        });
                    }
                }
            } catch (sentDistErr: any) {
                logger.warn(`[MailboxStats] Failed to distribute total_sent for campaign ${campaignId}`, {
                    error: sentDistErr.message,
                });
            }

            // ── Historical bounce backfill (Issue G) ─────────────────────────
            // One-time per campaign; idempotent; non-blocking.
            try {
                await backfillBouncesForCampaign(campaignId.toString(), organizationId, apiKey, sessionId);
            } catch (backfillErr: any) {
                logger.warn(`[HistoricalBackfill] Non-fatal error for campaign ${campaignId}`, {
                    error: backfillErr.message,
                });
            }

            campaignIndex++;
            if (sessionId) {
                syncProgressService.emitProgress(sessionId, 'leads', 'in_progress', {
                    current: campaignIndex,
                    total: campaigns.length
                });
            }
        }

        if (sessionId) {
            syncProgressService.emitProgress(sessionId, 'leads', 'completed', {
                count: leadCount
            });
            syncProgressService.emitProgress(sessionId, 'health_check', 'in_progress', {});
        }

        // ── 5. Recalculate engagement_rate for all mailboxes ──
        // Now that total_sent_count and engagement stats are both populated,
        // recalculate engagement_rate = (opens + clicks + replies) / total_sent
        try {
            const allMailboxes = await prisma.mailbox.findMany({
                where: { organization_id: organizationId },
                select: {
                    id: true,
                    total_sent_count: true,
                    open_count_lifetime: true,
                    click_count_lifetime: true,
                    reply_count_lifetime: true,
                }
            });

            for (const mb of allMailboxes) {
                const totalEngagement = mb.open_count_lifetime + mb.click_count_lifetime + mb.reply_count_lifetime;
                const engagementRate = mb.total_sent_count > 0
                    ? (totalEngagement / mb.total_sent_count) * 100
                    : 0;

                await prisma.mailbox.update({
                    where: { id: mb.id },
                    data: { engagement_rate: engagementRate }
                });
            }

            logger.info('[MailboxStats] Recalculated engagement rates for all mailboxes', {
                organizationId,
                mailboxCount: allMailboxes.length,
            });
        } catch (engRateErr: any) {
            logger.warn('[MailboxStats] Failed to recalculate engagement rates', {
                error: engRateErr.message,
            });
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
        let healthCheckResult = null;
        try {
            logger.info('Triggering infrastructure assessment after Smartlead sync', { organizationId });
            healthCheckResult = await assessmentService.assessInfrastructure(organizationId, 'onboarding');
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

        if (sessionId) {
            syncProgressService.emitProgress(sessionId, 'health_check', 'completed', {});
        }

        // ── 6. Aggregate mailbox engagement metrics to domains (PHASE 6) ──
        try {
            logger.info('[DomainAggregation] Starting domain-level engagement aggregation', {
                organizationId
            });

            // Get all domains for this organization
            const domains = await prisma.domain.findMany({
                where: { organization_id: organizationId },
                include: {
                    mailboxes: {
                        select: {
                            status: true,
                            total_sent_count: true,
                            open_count_lifetime: true,
                            click_count_lifetime: true,
                            reply_count_lifetime: true,
                            hard_bounce_count: true
                        }
                    }
                }
            });

            // Aggregate metrics for each domain & derive domain health from mailbox connection state
            for (const domain of domains) {
                const totalSentLifetime = domain.mailboxes.reduce((sum, mb) => sum + mb.total_sent_count, 0);
                const totalOpens = domain.mailboxes.reduce((sum, mb) => sum + mb.open_count_lifetime, 0);
                const totalClicks = domain.mailboxes.reduce((sum, mb) => sum + mb.click_count_lifetime, 0);
                const totalReplies = domain.mailboxes.reduce((sum, mb) => sum + mb.reply_count_lifetime, 0);
                const totalBounces = domain.mailboxes.reduce((sum, mb) => sum + mb.hard_bounce_count, 0);

                const engagementRate = totalSentLifetime > 0
                    ? ((totalOpens + totalClicks + totalReplies) / totalSentLifetime) * 100
                    : 0;

                const domainBounceRate = totalSentLifetime > 0
                    ? (totalBounces / totalSentLifetime) * 100
                    : 0;

                // Derive domain status from aggregated mailbox connection state
                const pausedMailboxes = domain.mailboxes.filter((mb: any) => mb.status === 'paused').length;
                const totalMailboxes = domain.mailboxes.length;
                let derivedDomainStatus = domain.status; // Keep current if no mailboxes
                if (totalMailboxes > 0) {
                    if (pausedMailboxes === totalMailboxes) {
                        derivedDomainStatus = 'paused'; // All mailboxes disconnected
                    } else if (pausedMailboxes > 0) {
                        derivedDomainStatus = 'warning'; // Some mailboxes disconnected
                    } else {
                        derivedDomainStatus = 'healthy'; // All mailboxes connected
                    }
                }

                await prisma.domain.update({
                    where: { id: domain.id },
                    data: {
                        status: derivedDomainStatus,
                        total_sent_lifetime: totalSentLifetime,
                        total_opens: totalOpens,
                        total_clicks: totalClicks,
                        total_replies: totalReplies,
                        total_bounces: totalBounces,
                        engagement_rate: engagementRate,
                        bounce_rate: domainBounceRate,
                        ...(derivedDomainStatus === 'paused' ? {
                            paused_reason: `${pausedMailboxes}/${totalMailboxes} mailboxes paused — domain auto-paused by health check`,
                            ...(domain.status !== 'paused' ? { last_pause_at: new Date() } : {})
                        } : {
                            // Clear reason when domain is no longer paused
                            paused_reason: null
                        })
                    }
                });

                logger.info('[DomainAggregation] Updated domain engagement metrics', {
                    domain: domain.domain,
                    status: derivedDomainStatus,
                    pausedMailboxes,
                    totalMailboxes,
                    totalSentLifetime,
                    totalOpens,
                    totalClicks,
                    totalReplies,
                    totalBounces,
                    engagementRate: engagementRate.toFixed(2) + '%',
                    bounceRate: domainBounceRate.toFixed(2) + '%'
                });
            }

            logger.info('[DomainAggregation] Completed domain aggregation', {
                organizationId,
                domainsUpdated: domains.length
            });
        } catch (aggregationError: any) {
            // Don't fail sync if aggregation fails
            logger.error('[DomainAggregation] Failed to aggregate domain metrics', aggregationError, {
                organizationId,
                error: aggregationError.message
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

        // Emit completion event with results
        logger.info('[SmartleadSync] About to emit completion event', {
            sessionId,
            hasSessionId: !!sessionId,
            campaignCount,
            mailboxCount,
            leadCount
        });

        if (sessionId) {
            syncProgressService.emitComplete(sessionId, {
                campaigns_synced: campaignCount,
                mailboxes_synced: mailboxCount,
                leads_synced: leadCount,
                health_check: healthCheckResult
            });
            logger.info('[SmartleadSync] Completion event emitted', { sessionId });
        } else {
            logger.warn('[SmartleadSync] No sessionId provided, skipping SSE completion event');
        }

        return { campaigns: campaignCount, mailboxes: mailboxCount, leads: leadCount };

    } catch (error: any) {
        logger.error(`[SmartleadSync] Sync failed for org ${organizationId}: ${error.message}`, error);

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

        // Emit error event
        if (sessionId) {
            syncProgressService.emitError(sessionId, error.message);
        }

        throw error;
    } finally {
        await releaseLock(lockKey);
    }
};