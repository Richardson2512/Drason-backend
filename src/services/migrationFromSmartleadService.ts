/**
 * Migration tool: from-Smartlead → native sequencer.
 *
 * Activates the existing Mailbox / Campaign / Lead rows of an org that was
 * previously on the Smartlead middleware path so they work under the native
 * sequencer post-Phase-B. Idempotent end-to-end — re-running any step is a
 * no-op for already-completed work.
 *
 * Flow:
 *   1. preview(orgId)              — read-only inventory the wizard shows
 *   2. connectMailbox(...)         — creates ConnectedAccount, links to existing Mailbox
 *   3. finalizeCampaign(...)       — populates sequencer fields on existing Campaign,
 *                                    creates CampaignLead + CampaignAccount rows.
 *                                    Leaves Campaign.status = 'paused'.
 *   4. finalizeOrg(orgId)          — summary + readiness gate
 *
 * Designed for the 3 affected prod orgs (Certinal, Superkabe internal, DevCommX).
 * Customer data is preserved end-to-end; only metadata is added.
 */

import { prisma } from '../index';
import { logger } from './observabilityService';
import { encrypt } from '../utils/encryption';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface MigrationPreview {
    mailboxes: Array<{
        id: string;
        email: string;
        domain: string;
        status: string;
        connected: boolean;          // already has a connected_account_id
        in_campaigns: number;
    }>;
    campaigns: Array<{
        id: string;
        name: string;
        status: string;
        ready: boolean;              // has sequencer fields populated AND ≥1 connected mailbox
        lead_count: number;
        last_send_at: Date | null;
    }>;
    leads_total: number;
    sequencer_settings_present: boolean;
}

export interface ConnectMailboxInput {
    mailboxId: string;
    provider: 'google' | 'microsoft' | 'smtp';
    email?: string;        // override Mailbox.email if needed
    accessToken?: string;
    refreshToken?: string;
    tokenExpiresAt?: Date;
    smtpHost?: string;
    smtpPort?: number;
    smtpUsername?: string;
    smtpPassword?: string;
    imapHost?: string;
    imapPort?: number;
}

export interface FinalizeCampaignInput {
    campaignId: string;
    schedule_timezone?: string;
    schedule_start_time?: string;     // "HH:MM"
    schedule_end_time?: string;
    schedule_days?: string[];          // ["mon","tue",...]
    daily_limit?: number;
    send_gap_minutes?: number;
    esp_routing?: boolean;
    stop_on_reply?: boolean;
    stop_on_bounce?: boolean;
    track_opens?: boolean;
    track_clicks?: boolean;
}

export interface MigrationSummary {
    mailboxes_total: number;
    mailboxes_connected: number;
    campaigns_total: number;
    campaigns_ready: number;
    campaign_leads_created: number;
    campaign_accounts_created: number;
    ready_to_resume: boolean;
}

// ─── Step 1: preview ─────────────────────────────────────────────────────────

export async function preview(orgId: string): Promise<MigrationPreview> {
    const [mailboxes, campaigns, leadsTotal, seqSettings] = await Promise.all([
        prisma.mailbox.findMany({
            where: { organization_id: orgId },
            select: {
                id: true,
                email: true,
                status: true,
                connected_account_id: true,
                domain: { select: { domain: true } },
                _count: { select: { campaigns: true } },
            },
        }),
        prisma.campaign.findMany({
            where: { organization_id: orgId, status: { notIn: ['archived', 'deleted'] } },
            select: {
                id: true,
                name: true,
                status: true,
                schedule_timezone: true,
                daily_limit: true,
                _count: { select: { leads: true, accounts: true, mailboxes: true } },
            },
        }),
        prisma.lead.count({ where: { organization_id: orgId, deleted_at: null } }),
        prisma.sequencerSettings.findUnique({ where: { organization_id: orgId } }),
    ]);

    // Last send per campaign — bulk fetch latest SendEvent
    const lastSendsByCampaign = await prisma.sendEvent.groupBy({
        by: ['campaign_id'],
        where: { organization_id: orgId },
        _max: { sent_at: true },
    });
    const lastSendMap = new Map<string, Date>();
    for (const s of lastSendsByCampaign) {
        if (s.campaign_id && s._max.sent_at) lastSendMap.set(s.campaign_id, s._max.sent_at);
    }

    return {
        mailboxes: mailboxes.map((m) => ({
            id: m.id,
            email: m.email,
            domain: m.domain?.domain || '',
            status: m.status,
            connected: !!m.connected_account_id,
            in_campaigns: m._count.campaigns,
        })),
        campaigns: campaigns.map((c) => ({
            id: c.id,
            name: c.name,
            status: c.status,
            ready: !!c.schedule_timezone && !!c.daily_limit && c._count.accounts > 0,
            lead_count: c._count.leads,
            last_send_at: lastSendMap.get(c.id) ?? null,
        })),
        leads_total: leadsTotal,
        sequencer_settings_present: !!seqSettings,
    };
}

// ─── Step 2: connect a mailbox ───────────────────────────────────────────────

export async function connectMailbox(
    orgId: string,
    input: ConnectMailboxInput,
): Promise<{ success: boolean; accountId?: string; error?: string }> {
    const mailbox = await prisma.mailbox.findFirst({
        where: { id: input.mailboxId, organization_id: orgId },
        select: { id: true, email: true, connected_account_id: true },
    });
    if (!mailbox) return { success: false, error: 'Mailbox not found in this org' };

    if (mailbox.connected_account_id) {
        // Idempotent — already connected. Return existing.
        return { success: true, accountId: mailbox.connected_account_id };
    }

    const email = (input.email || mailbox.email).trim().toLowerCase();

    // Reuse an existing ConnectedAccount for this org+email if one exists,
    // otherwise create new.
    const existingAccount = await prisma.connectedAccount.findUnique({
        where: { organization_id_email: { organization_id: orgId, email } },
        select: { id: true },
    });

    let accountId: string;
    if (existingAccount) {
        accountId = existingAccount.id;
    } else {
        const created = await prisma.connectedAccount.create({
            data: {
                organization_id: orgId,
                email,
                provider: input.provider,
                access_token: input.accessToken ? encrypt(input.accessToken) : null,
                refresh_token: input.refreshToken ? encrypt(input.refreshToken) : null,
                token_expires_at: input.tokenExpiresAt || null,
                smtp_host: input.smtpHost || null,
                smtp_port: input.smtpPort || null,
                smtp_username: input.smtpUsername || null,
                smtp_password: input.smtpPassword ? encrypt(input.smtpPassword) : null,
                imap_host: input.imapHost || null,
                imap_port: input.imapPort || null,
                connection_status: 'active',
            },
            select: { id: true },
        });
        accountId = created.id;
    }

    await prisma.mailbox.update({
        where: { id: mailbox.id },
        data: { connected_account_id: accountId, status: 'healthy' },
    });

    logger.info('[MIGRATION] Mailbox connected', { orgId, mailboxId: mailbox.id, accountId });
    return { success: true, accountId };
}

// ─── Step 3: finalize a campaign ─────────────────────────────────────────────

export async function finalizeCampaign(
    orgId: string,
    input: FinalizeCampaignInput,
): Promise<{
    success: boolean;
    error?: string;
    campaignLeadsCreated: number;
    campaignAccountsCreated: number;
}> {
    const campaign = await prisma.campaign.findFirst({
        where: { id: input.campaignId, organization_id: orgId },
        include: {
            mailboxes: { select: { id: true, connected_account_id: true } },
        },
    });
    if (!campaign) {
        return { success: false, error: 'Campaign not found', campaignLeadsCreated: 0, campaignAccountsCreated: 0 };
    }

    // Sequencer settings (overwrite — last finalize wins)
    await prisma.campaign.update({
        where: { id: campaign.id },
        data: {
            schedule_timezone: input.schedule_timezone ?? campaign.schedule_timezone ?? 'UTC',
            schedule_start_time: input.schedule_start_time ?? campaign.schedule_start_time ?? '09:00',
            schedule_end_time: input.schedule_end_time ?? campaign.schedule_end_time ?? '17:00',
            schedule_days: input.schedule_days?.length
                ? input.schedule_days
                : (campaign.schedule_days?.length ? campaign.schedule_days : ['mon', 'tue', 'wed', 'thu', 'fri']),
            daily_limit: input.daily_limit ?? campaign.daily_limit ?? 50,
            send_gap_minutes: input.send_gap_minutes ?? campaign.send_gap_minutes ?? 15,
            esp_routing: input.esp_routing ?? campaign.esp_routing ?? true,
            stop_on_reply: input.stop_on_reply ?? campaign.stop_on_reply ?? true,
            stop_on_bounce: input.stop_on_bounce ?? campaign.stop_on_bounce ?? true,
            track_opens: input.track_opens ?? campaign.track_opens ?? true,
            track_clicks: input.track_clicks ?? campaign.track_clicks ?? true,
            // Leave status='paused' so the customer reviews before sending.
            status: campaign.status === 'archived' ? 'archived' : 'paused',
        },
    });

    // CampaignAccount: link each connected mailbox in this campaign to a CampaignAccount row
    let campaignAccountsCreated = 0;
    for (const mb of campaign.mailboxes) {
        if (!mb.connected_account_id) continue;
        const created = await prisma.campaignAccount.upsert({
            where: { campaign_id_account_id: { campaign_id: campaign.id, account_id: mb.connected_account_id } },
            create: {
                campaign_id: campaign.id,
                account_id: mb.connected_account_id,
            },
            update: {},
            select: { id: true },
        });
        if (created) campaignAccountsCreated++;
    }

    // CampaignLead: from existing Lead rows assigned to this campaign
    const leads = await prisma.lead.findMany({
        where: {
            organization_id: orgId,
            assigned_campaign_id: campaign.id,
            deleted_at: null,
        },
        select: { email: true, first_name: true, last_name: true, company: true, title: true, validation_status: true, validation_score: true },
        take: 50_000,  // safety cap; enrollment is usually sub-10k per campaign
    });

    let campaignLeadsCreated = 0;
    if (leads.length > 0) {
        const result = await prisma.campaignLead.createMany({
            data: leads.map((l) => ({
                campaign_id: campaign.id,
                email: l.email.toLowerCase().trim(),
                first_name: l.first_name,
                last_name: l.last_name,
                company: l.company,
                title: l.title,
                status: 'active',
                validation_status: l.validation_status,
                validation_score: l.validation_score,
            })),
            skipDuplicates: true,
        });
        campaignLeadsCreated = result.count;
        if (campaignLeadsCreated > 0) {
            const total = await prisma.campaignLead.count({ where: { campaign_id: campaign.id } });
            await prisma.campaign.update({ where: { id: campaign.id }, data: { total_leads: total } }).catch(() => {});
        }
    }

    logger.info('[MIGRATION] Campaign finalized', {
        orgId,
        campaignId: campaign.id,
        campaignLeadsCreated,
        campaignAccountsCreated,
    });
    return { success: true, campaignLeadsCreated, campaignAccountsCreated };
}

// ─── Step 4: org-level summary ───────────────────────────────────────────────

export async function finalizeOrg(orgId: string): Promise<MigrationSummary> {
    const [mailboxes, campaigns, campaignAccounts, campaignLeads] = await Promise.all([
        prisma.mailbox.findMany({
            where: { organization_id: orgId },
            select: { connected_account_id: true },
        }),
        prisma.campaign.findMany({
            where: { organization_id: orgId, status: { notIn: ['archived', 'deleted'] } },
            select: {
                id: true,
                schedule_timezone: true,
                daily_limit: true,
                _count: { select: { accounts: true } },
            },
        }),
        prisma.campaignAccount.count({
            where: { campaign: { organization_id: orgId } },
        }),
        prisma.campaignLead.count({
            where: { campaign: { organization_id: orgId } },
        }),
    ]);

    const mailboxesConnected = mailboxes.filter((m) => !!m.connected_account_id).length;
    const campaignsReady = campaigns.filter(
        (c) => !!c.schedule_timezone && !!c.daily_limit && c._count.accounts > 0,
    ).length;

    return {
        mailboxes_total: mailboxes.length,
        mailboxes_connected: mailboxesConnected,
        campaigns_total: campaigns.length,
        campaigns_ready: campaignsReady,
        campaign_leads_created: campaignLeads,
        campaign_accounts_created: campaignAccounts,
        ready_to_resume: mailboxesConnected > 0 && campaignsReady > 0,
    };
}
