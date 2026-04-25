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
import { InstantlyAdapter } from './instantlyAdapter';
import { logger } from '../services/observabilityService';

// ============================================================================
// ADAPTER INSTANCES (Singletons)
// ============================================================================

const adapters: Record<SourcePlatform, PlatformAdapter | null> = {
    smartlead: new SmartleadAdapter(),
    emailbison: new EmailBisonAdapter(),
    instantly: new InstantlyAdapter(),
    replyio: null,    // Not yet implemented — getAdapter() throws if accessed
    sequencer: null,  // Native sending — no external platform adapter needed
};

// ============================================================================
// RESOLVER FUNCTIONS
// ============================================================================

/**
 * Get adapter by platform name — strict variant, throws if unavailable.
 * Use this only for callers that REQUIRE an external platform (Smartlead/Instantly/EmailBison).
 * For callers that should gracefully skip sequencer mailboxes, use `tryGetAdapter()` instead.
 */
export function getAdapter(platform: SourcePlatform): PlatformAdapter {
    if (platform === 'sequencer') {
        throw new Error('Sequencer sends natively; no platform adapter available. Use tryGetAdapter() to skip gracefully.');
    }
    const adapter = adapters[platform];
    if (!adapter) {
        throw new Error(`Platform adapter for "${platform}" is not yet implemented`);
    }
    return adapter;
}

/**
 * Get adapter by platform, returning null for platforms without an external adapter (sequencer).
 * Throws for truly not-yet-implemented platforms (replyio).
 * Use this in Protection services so sequencer mailboxes skip cleanly.
 */
export function tryGetAdapter(platform: SourcePlatform): PlatformAdapter | null {
    if (platform === 'sequencer') return null;
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
 * STRICT — throws for sequencer. Use tryGetAdapterForMailbox() to skip sequencer.
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
 * Get adapter for mailbox, returning null for sequencer mailboxes.
 * Use this in Protection services (healingService, infrastructureAssessmentService, etc.)
 * where sequencer mailboxes should skip the external-platform action.
 */
export async function tryGetAdapterForMailbox(mailboxId: string): Promise<PlatformAdapter | null> {
    const mailbox = await prisma.mailbox.findUnique({
        where: { id: mailboxId },
        select: { source_platform: true }
    });

    if (!mailbox) return null;
    return tryGetAdapter(mailbox.source_platform);
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
