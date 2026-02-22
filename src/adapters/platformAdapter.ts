/**
 * Platform Adapter Interface
 *
 * The contract that every email sending platform (Smartlead, EmailBison,
 * Instantly, Reply.io) must implement. Core services (healing, monitoring,
 * warmup, load balancing) call this interface — never a platform client directly.
 *
 * This is the central architectural boundary that enables multi-platform
 * operations without any platform-specific coupling in the infrastructure.
 */

import { SourcePlatform } from '@prisma/client';

// ============================================================================
// SHARED TYPES
// ============================================================================

export interface SyncResult {
    campaigns: number;
    mailboxes: number;
    leads: number;
}

export interface MailboxDetails {
    externalId: number;
    email: string;
    status: string;
    warmupEnabled: boolean;
    warmupReputation: string | null;
    totalWarmupPerDay: number;
    dailySentCount: number;
    spamCount: number;
    smtpSuccess: boolean;
    imapSuccess: boolean;
    connectionError: string | null;
}

export interface WarmupSettings {
    warmup_enabled: boolean;
    total_warmup_per_day?: number;
    daily_rampup?: number;
    reply_rate_percentage?: number;
}

export interface LeadPayload {
    email: string;
    first_name?: string;
    last_name?: string;
    company?: string;
}

export interface PushLeadResult {
    success: boolean;
    message?: string;
}

// ============================================================================
// PLATFORM ADAPTER INTERFACE
// ============================================================================

export interface PlatformAdapter {
    /**
     * The platform this adapter represents.
     */
    readonly platform: SourcePlatform;

    // ── SYNC (Data Ingestion) ──────────────────────────────────────────

    /**
     * Full sync: campaigns, mailboxes, and leads from the platform.
     */
    sync(organizationId: string, sessionId?: string): Promise<SyncResult>;

    // ── HEALING ACTIONS (Write-back to platform) ──────────────────────

    /**
     * Pause a campaign on the external platform.
     */
    pauseCampaign(organizationId: string, externalCampaignId: string): Promise<boolean>;

    /**
     * Resume a campaign on the external platform.
     */
    resumeCampaign(organizationId: string, externalCampaignId: string): Promise<boolean>;

    /**
     * Add a mailbox to a campaign on the external platform.
     */
    addMailboxToCampaign(
        organizationId: string,
        externalCampaignId: string,
        externalMailboxId: string
    ): Promise<boolean>;

    /**
     * Remove a mailbox from a campaign on the external platform.
     */
    removeMailboxFromCampaign(
        organizationId: string,
        externalCampaignId: string,
        externalMailboxId: string
    ): Promise<boolean>;

    // ── WARMUP (Recovery) ─────────────────────────────────────────────

    /**
     * Get detailed mailbox/email-account information from the platform.
     */
    getMailboxDetails(
        organizationId: string,
        externalAccountId: number
    ): Promise<MailboxDetails | null>;

    /**
     * Update warmup settings for a mailbox on the platform.
     */
    updateWarmupSettings(
        organizationId: string,
        externalAccountId: number,
        settings: WarmupSettings
    ): Promise<{ ok: boolean; message: string }>;

    // ── LEAD OPERATIONS ───────────────────────────────────────────────

    /**
     * Push a lead to a campaign on the external platform.
     */
    pushLeadToCampaign(
        organizationId: string,
        externalCampaignId: string,
        lead: LeadPayload
    ): Promise<PushLeadResult>;

    /**
     * Remove a lead from a campaign on the external platform.
     */
    removeLeadFromCampaign(
        organizationId: string,
        externalCampaignId: string,
        leadEmail: string
    ): Promise<boolean>;

    // ── DOMAIN OPERATIONS ─────────────────────────────────────────────

    /**
     * Remove all mailboxes belonging to a domain from their campaigns.
     * Called when an entire domain is paused.
     */
    removeAllDomainMailboxes(
        organizationId: string,
        domainId: string
    ): Promise<{ success: number; failed: number }>;
}
