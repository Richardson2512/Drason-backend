/**
 * Smartlead Platform Adapter
 *
 * Wraps the existing smartleadClient.ts behind the PlatformAdapter interface.
 * This is a structural refactor only — no logic changes to existing Smartlead operations.
 */

import { SourcePlatform } from '@prisma/client';
import {
    PlatformAdapter,
    SyncResult,
    MailboxDetails,
    WarmupSettings,
    LeadPayload,
    PushLeadResult,
} from './platformAdapter';
import * as smartleadClient from '../services/smartleadClient';

export class SmartleadAdapter implements PlatformAdapter {
    readonly platform = SourcePlatform.smartlead;

    // ── SYNC ───────────────────────────────────────────────────────────

    async sync(organizationId: string, sessionId?: string): Promise<SyncResult> {
        return smartleadClient.syncSmartlead(organizationId, sessionId);
    }

    // ── HEALING ACTIONS ────────────────────────────────────────────────

    async pauseCampaign(organizationId: string, externalCampaignId: string): Promise<boolean> {
        return smartleadClient.pauseSmartleadCampaign(organizationId, externalCampaignId);
    }

    async resumeCampaign(organizationId: string, externalCampaignId: string): Promise<boolean> {
        return smartleadClient.resumeSmartleadCampaign(organizationId, externalCampaignId);
    }

    async addMailboxToCampaign(
        organizationId: string,
        externalCampaignId: string,
        externalMailboxId: string
    ): Promise<boolean> {
        return smartleadClient.addMailboxToSmartleadCampaign(
            organizationId,
            externalCampaignId,
            externalMailboxId
        );
    }

    async removeMailboxFromCampaign(
        organizationId: string,
        externalCampaignId: string,
        externalMailboxId: string
    ): Promise<boolean> {
        return smartleadClient.removeMailboxFromSmartleadCampaign(
            organizationId,
            externalCampaignId,
            externalMailboxId
        );
    }

    // ── WARMUP ─────────────────────────────────────────────────────────

    async getMailboxDetails(
        organizationId: string,
        externalAccountId: number
    ): Promise<MailboxDetails | null> {
        try {
            const details = await smartleadClient.getEmailAccountDetails(
                organizationId,
                externalAccountId
            );

            if (!details) return null;

            return {
                externalId: details.id,
                email: details.from_email,
                status: 'active',
                warmupEnabled: details.warmup_details?.id != null,
                warmupReputation: details.warmup_details?.warmup_reputation || null,
                totalWarmupPerDay: details.warmup_details?.warmup_max_count || 0,
                dailySentCount: details.warmup_details?.total_sent_count || 0,
                spamCount: details.warmup_details?.total_spam_count || 0,
                smtpSuccess: true,
                imapSuccess: true,
                connectionError: null,
            };
        } catch {
            return null;
        }
    }

    async updateWarmupSettings(
        organizationId: string,
        externalAccountId: number,
        settings: WarmupSettings
    ): Promise<{ ok: boolean; message: string }> {
        try {
            const result = await smartleadClient.updateMailboxWarmup(
                organizationId,
                externalAccountId,
                settings
            );
            return {
                ok: result.ok,
                message: result.message,
            };
        } catch (error: any) {
            return { ok: false, message: error.message };
        }
    }

    // ── LEAD OPERATIONS ────────────────────────────────────────────────

    async pushLeadToCampaign(
        organizationId: string,
        externalCampaignId: string,
        lead: LeadPayload
    ): Promise<PushLeadResult> {
        const success = await smartleadClient.pushLeadToCampaign(
            organizationId,
            externalCampaignId,
            lead
        );
        return { success };
    }

    async removeLeadFromCampaign(
        organizationId: string,
        externalCampaignId: string,
        leadEmail: string
    ): Promise<boolean> {
        return smartleadClient.removeLeadFromSmartleadCampaign(
            organizationId,
            externalCampaignId,
            leadEmail
        );
    }

    // ── DOMAIN OPERATIONS ──────────────────────────────────────────────

    async removeAllDomainMailboxes(
        organizationId: string,
        domainId: string
    ): Promise<{ success: number; failed: number }> {
        return smartleadClient.removeDomainMailboxesFromSmartlead(organizationId, domainId);
    }
}
