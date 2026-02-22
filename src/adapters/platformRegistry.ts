/**
 * Platform Registry
 *
 * Central resolver for platform adapters. Given a campaign, mailbox, or
 * organization, returns the correct PlatformAdapter to interact with the
 * external platform.
 *
 * This is the ONLY place that maps source_platform → adapter instance.
 * All services call through this registry — never instantiating adapters directly.
 */

import { SourcePlatform } from '@prisma/client';
import { prisma } from '../index';
import { PlatformAdapter } from './platformAdapter';
import { SmartleadAdapter } from './smartleadAdapter';
import { EmailBisonAdapter } from './emailbisonAdapter';
import { logger } from '../services/observabilityService';

// ============================================================================
// ADAPTER INSTANCES (Singletons)
// ============================================================================

const adapters: Record<SourcePlatform, PlatformAdapter> = {
    smartlead: new SmartleadAdapter(),
    emailbison: new EmailBisonAdapter(),
    instantly: null as any,  // Stub — not yet implemented
    replyio: null as any,    // Stub — not yet implemented
};

// ============================================================================
// RESOLVER FUNCTIONS
// ============================================================================

/**
 * Get adapter by platform name.
 * Throws if the platform adapter is not yet implemented.
 */
export function getAdapter(platform: SourcePlatform): PlatformAdapter {
    const adapter = adapters[platform];
    if (!adapter) {
        throw new Error(`Platform adapter for "${platform}" is not yet implemented`);
    }
    return adapter;
}

/**
 * Get the adapter for a specific campaign by looking up its source_platform.
 */
export async function getAdapterForCampaign(campaignId: string): Promise<PlatformAdapter> {
    const campaign = await prisma.campaign.findUnique({
        where: { id: campaignId },
        select: { source_platform: true }
    });

    if (!campaign) {
        throw new Error(`Campaign ${campaignId} not found`);
    }

    return getAdapter(campaign.source_platform);
}

/**
 * Get the adapter for a specific mailbox by looking up its source_platform.
 */
export async function getAdapterForMailbox(mailboxId: string): Promise<PlatformAdapter> {
    const mailbox = await prisma.mailbox.findUnique({
        where: { id: mailboxId },
        select: { source_platform: true }
    });

    if (!mailbox) {
        throw new Error(`Mailbox ${mailboxId} not found`);
    }

    return getAdapter(mailbox.source_platform);
}

/**
 * Get the adapter for a specific domain by looking up its source_platform.
 */
export async function getAdapterForDomain(domainId: string): Promise<PlatformAdapter> {
    const domain = await prisma.domain.findUnique({
        where: { id: domainId },
        select: { source_platform: true }
    });

    if (!domain) {
        throw new Error(`Domain ${domainId} not found`);
    }

    return getAdapter(domain.source_platform);
}

// ============================================================================
// ORGANIZATION PLATFORM DISCOVERY
// ============================================================================

/**
 * Setting key → SourcePlatform mapping.
 * Used to discover which platforms are configured for an organization.
 */
const PLATFORM_API_KEY_MAP: Record<string, SourcePlatform> = {
    'SMARTLEAD_API_KEY': SourcePlatform.smartlead,
    'EMAILBISON_API_KEY': SourcePlatform.emailbison,
    'INSTANTLY_API_KEY': SourcePlatform.instantly,
    'REPLYIO_API_KEY': SourcePlatform.replyio,
};

/**
 * Get all active (implemented + configured) adapters for an organization.
 * Used by the sync worker to discover which platforms to sync.
 */
export async function getActiveAdaptersForOrg(
    organizationId: string
): Promise<{ adapter: PlatformAdapter; settingKey: string }[]> {
    // Find all platform API keys configured for this org
    const settings = await prisma.organizationSetting.findMany({
        where: {
            organization_id: organizationId,
            key: { in: Object.keys(PLATFORM_API_KEY_MAP) },
            NOT: { value: '' }
        },
        select: { key: true }
    });

    const result: { adapter: PlatformAdapter; settingKey: string }[] = [];

    for (const setting of settings) {
        const platform = PLATFORM_API_KEY_MAP[setting.key];
        if (!platform) continue;

        const adapter = adapters[platform];
        if (!adapter) {
            logger.info(`[PlatformRegistry] Skipping ${platform} — adapter not yet implemented`, {
                organizationId,
                settingKey: setting.key
            });
            continue;
        }

        result.push({ adapter, settingKey: setting.key });
    }

    return result;
}

/**
 * Check if a specific platform is configured for an organization.
 */
export async function isPlatformConfigured(
    organizationId: string,
    platform: SourcePlatform
): Promise<boolean> {
    const keyName = Object.entries(PLATFORM_API_KEY_MAP)
        .find(([_, p]) => p === platform)?.[0];

    if (!keyName) return false;

    const setting = await prisma.organizationSetting.findUnique({
        where: {
            organization_id_key: {
                organization_id: organizationId,
                key: keyName
            }
        },
        select: { value: true }
    });

    return !!setting?.value;
}
