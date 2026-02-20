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
import { syncProgressService } from './syncProgressService';
import { TIER_LIMITS } from './polarClient';
import { decrypt } from '../utils/encryption';
import { parse } from 'csv-parse/sync';

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

    if (!setting?.value) return null;

    // Decrypt the API key before returning (it's encrypted in the database)
    return decrypt(setting.value);
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
            current_mailbox_count: true
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

        for (const campaign of campaigns) {
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

            await prisma.campaign.upsert({
                where: { id: campaign.id.toString() },
                update: {
                    name: campaign.name,
                    status: campaign.status || 'active',
                    bounce_rate: bounceRate,
                    total_sent: totalSent,
                    total_bounced: totalBounced,
                    // Analytics fields (SOFT SIGNALS - display only)
                    open_count: totalOpens,
                    click_count: totalClicks,
                    reply_count: totalReplies,
                    unsubscribed_count: totalUnsubscribed,
                    open_rate: openRate,
                    click_rate: clickRate,
                    reply_rate: replyRate,
                    analytics_updated_at: new Date(),
                    last_synced_at: new Date(),
                    organization_id: organizationId // Force ownership update
                },
                create: {
                    id: campaign.id.toString(),
                    name: campaign.name,
                    status: campaign.status || 'active',
                    bounce_rate: bounceRate,
                    total_sent: totalSent,
                    total_bounced: totalBounced,
                    // Analytics fields (SOFT SIGNALS - display only)
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
            });

            if (bounceRate > 0) {
                logger.info('[CampaignSync] Campaign bounce rate synced', {
                    campaignId: campaign.id,
                    campaignName: campaign.name,
                    bounceRate: bounceRate.toFixed(2) + '%',
                    totalSent,
                    totalBounced
                });
            }

            campaignCount++;

            if (sessionId) {
                syncProgressService.emitProgress(sessionId, 'campaigns', 'in_progress', {
                    current: campaignCount,
                    total: campaigns.length
                });
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

        for (const mailbox of mailboxes) {
            // Extract domain from email
            const email = mailbox.from_email || mailbox.email || '';
            const domainName = email.split('@')[1] || 'unknown.com';

            // NOTE: Smartlead /email-accounts endpoint does NOT return send/bounce stats
            // Mailbox stats are tracked via webhooks (email_sent, email_bounced events)
            // Historical data must be aggregated from campaigns if needed

            // Ensure domain exists
            let domain = await prisma.domain.findFirst({
                where: {
                    organization_id: organizationId,
                    domain: domainName
                }
            });

            if (!domain) {
                // Check domain capacity before creating
                if (org.current_domain_count >= limits.domains) {
                    logger.warn('[Smartlead Sync] Domain capacity reached, skipping domain creation', {
                        organizationId,
                        current: org.current_domain_count,
                        limit: limits.domains,
                        tier: org.subscription_tier,
                        skippedDomain: domainName
                    });
                    continue; // Skip this mailbox if we can't create its domain
                }

                domain = await prisma.domain.create({
                    data: {
                        domain: domainName,
                        status: 'healthy',
                        organization_id: organizationId
                    }
                });

                // Increment domain count
                await prisma.organization.update({
                    where: { id: organizationId },
                    data: { current_domain_count: { increment: 1 } }
                });
                org.current_domain_count++; // Update local copy
            }

            // Check if mailbox exists
            const existingMailbox = await prisma.mailbox.findUnique({
                where: { id: mailbox.id.toString() }
            });

            if (!existingMailbox) {
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

            // Extract stats from Smartlead API response
            const dailySentCount = mailbox.daily_sent_count || 0;
            const warmupSpamCount = mailbox.warmup_details?.total_spam_count || 0;

            // Upsert mailbox with connection diagnostics and stats
            await prisma.mailbox.upsert({
                where: { id: mailbox.id.toString() },
                update: {
                    email,
                    smartlead_email_account_id: mailbox.id,
                    status: mailboxStatus,
                    smtp_status: mailbox.is_smtp_success === true,
                    imap_status: mailbox.is_imap_success === true,
                    connection_error: connectionError || null,
                    total_sent_count: dailySentCount,
                    spam_count: warmupSpamCount,
                    warmup_status: warmupStatus,
                    warmup_reputation: warmupReputation,
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
                    total_sent_count: dailySentCount,
                    spam_count: warmupSpamCount,
                    warmup_status: warmupStatus,
                    warmup_reputation: warmupReputation,
                    domain_id: domain.id,
                    organization_id: organizationId
                }
            });

            // Increment mailbox count if this was a new mailbox
            if (!existingMailbox) {
                await prisma.organization.update({
                    where: { id: organizationId },
                    data: { current_mailbox_count: { increment: 1 } }
                });
                org.current_mailbox_count++; // Update local copy
            }

            mailboxCount++;

            if (sessionId) {
                syncProgressService.emitProgress(sessionId, 'mailboxes', 'in_progress', {
                    current: mailboxCount,
                    total: mailboxes.length
                });
            }
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

                        const firstName = lead.first_name || lead.firstName || '';
                        const lastName = lead.last_name || lead.lastName || '';
                        const company = lead.company_name || lead.company || '';
                        const persona = company || 'general';

                        // Note: /campaigns/{id}/leads endpoint does NOT include engagement stats
                        // We'll fetch those separately using CSV export endpoint after contact sync completes
                        const upsertedLead = await prisma.lead.upsert({
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

                logger.info(`Synced ${campaignLeadCount} lead contacts for campaign ${campaignId}`, {
                    organizationId,
                    campaignId,
                    campaignName: campaign.name
                });

                // ── Fetch engagement stats from CSV export endpoint ──
                // Note: /campaigns/{id}/leads-export returns CSV with open_count, click_count, reply_count
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
                    for (const record of records) {
                        const rec = record as any; // Type assertion for CSV record
                        const email = rec.email || rec.Email || rec.EMAIL;
                        if (!email) continue;

                        const openCount = parseInt(rec.open_count || rec.opens || '0');
                        const clickCount = parseInt(rec.click_count || rec.clicks || '0');
                        const replyCount = parseInt(rec.reply_count || rec.replies || '0');

                        // Debug: Log first 3 records with details
                        if (updatedCount < 3) {
                            logger.info(`[LeadEngagement] Sample lead ${updatedCount + 1}:`, {
                                email,
                                opens: openCount,
                                clicks: clickCount,
                                replies: replyCount,
                                rawRecord: rec
                            });
                        }

                        if (openCount > 0 || clickCount > 0 || replyCount > 0) {
                            recordsWithEngagement++;
                        }

                        // Update lead with engagement stats
                        try {
                            await prisma.lead.update({
                                where: {
                                    organization_id_email: {
                                        organization_id: organizationId,
                                        email
                                    }
                                },
                                data: {
                                    emails_opened: openCount,
                                    emails_clicked: clickCount,
                                    emails_replied: replyCount,
                                    last_activity_at: (openCount > 0 || clickCount > 0 || replyCount > 0) ? new Date() : undefined
                                }
                            });

                            // Backfill activity for leads with engagement
                            if (openCount > 0 || clickCount > 0 || replyCount > 0) {
                                // Create audit log summary entry for historical activity
                                await auditLogService.logAction({
                                    organizationId,
                                    entity: 'lead',
                                    entityId: email,
                                    trigger: 'smartlead_sync',
                                    action: 'activity_backfill',
                                    details: `Historical activity: ${openCount} opened, ${clickCount} clicked, ${replyCount} replied`
                                });

                                // Boost engagement score based on activity
                                let scoreBoost = 0;
                                if (replyCount > 0) scoreBoost += replyCount * 20; // +20 per reply
                                if (clickCount > 0) scoreBoost += clickCount * 10; // +10 per click
                                if (openCount > 0) scoreBoost += openCount * 5; // +5 per open

                                if (scoreBoost > 0) {
                                    await prisma.lead.update({
                                        where: {
                                            organization_id_email: {
                                                organization_id: organizationId,
                                                email
                                            }
                                        },
                                        data: {
                                            lead_score: { increment: scoreBoost }
                                        }
                                    });
                                }
                            }

                            updatedCount++;
                        } catch (updateError: any) {
                            // Lead might not exist if it was filtered out during contact sync
                            logger.debug(`[LeadEngagement] Skipping engagement update for ${email}`, {
                                error: updateError.message
                            });
                        }
                    }

                    logger.info(`[LeadEngagement] Updated ${updatedCount} leads with engagement stats for campaign ${campaignId}`, {
                        totalRecords: records.length,
                        recordsWithEngagement,
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
                        bounce_rate: domainBounceRate
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

// ============================================================================
// CAMPAIGN & MAILBOX CONTROL (Infrastructure Health Integration)
// ============================================================================

/**
 * Pause a Smartlead campaign.
 * Called when Drason detects infrastructure health degradation.
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
        await smartleadBreaker.call(() =>
            axios.patch(
                `${SMARTLEAD_API_BASE}/campaigns/${campaignId}`,
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
                    name: true
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
    const smartleadCampaigns = await smartleadBreaker.call(() =>
        axios.get(`${SMARTLEAD_API_BASE}/campaigns`, {
            params: { api_key: apiKey }
        })
    );

    let successCount = 0;
    let failCount = 0;

    // Remove from each campaign
    for (const campaign of smartleadCampaigns.data) {
        // Match by campaign name (since we don't store smartlead_campaign_id)
        const ourCampaign = campaigns.find(c => c.name === campaign.name);
        if (!ourCampaign) continue;

        try {
            await smartleadBreaker.call(() =>
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
 * Called when Drason detects infrastructure health recovery.
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
        await smartleadBreaker.call(() =>
            axios.patch(
                `${SMARTLEAD_API_BASE}/campaigns/${campaignId}`,
                { status: 'ACTIVE' },
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
        // Remove the email account from the campaign
        await smartleadBreaker.call(() =>
            axios.delete(
                `${SMARTLEAD_API_BASE}/campaigns/${campaignId}/email-accounts/${mailboxId}`,
                { params: { api_key: apiKey } }
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
        await smartleadBreaker.call(() =>
            axios.post(
                `${SMARTLEAD_API_BASE}/campaigns/${campaignId}/email-accounts`,
                { email_account_id: mailboxId },
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
        include: { campaigns: true }
    });

    let successCount = 0;
    let failedCount = 0;

    for (const mailbox of mailboxes) {
        // Remove this mailbox from all assigned campaigns
        for (const campaign of mailbox.campaigns) {
            const removed = await removeMailboxFromSmartleadCampaign(
                organizationId,
                campaign.id,
                mailbox.id
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
