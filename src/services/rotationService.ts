/**
 * Rotation Service
 *
 * Automatically rotates a healthy standby mailbox into a campaign when a mailbox
 * is paused and removed. Works across all platforms via the PlatformAdapter interface.
 *
 * Called by monitoringService (generic bounce detection) and smartleadEventParserService
 * (Smartlead webhook bounce handling) after a mailbox is paused and removed from campaigns.
 *
 * Selection priority:
 *   1. Same domain + same platform + not in any campaign
 *   2. Same platform + different healthy domain + not in any campaign
 *   3. Same platform + underutilized (< 3 campaigns) + not already in target campaign
 */

import { prisma } from '../index';
import { SourcePlatform } from '@prisma/client';
import { logger } from './observabilityService';
import { getAdapterForCampaign } from '../adapters/platformRegistry';
import * as auditLogService from './auditLogService';
import * as notificationService from './notificationService';
import { MONITORING_THRESHOLDS } from '../types';

// ============================================================================
// TYPES
// ============================================================================

interface AffectedCampaign {
    id: string;
    external_id: string | null;
    name: string | null;
}

interface StandbyCandidate {
    id: string;
    email: string;
    domain_id: string;
    external_email_account_id: string | null;
    resilience_score: number;
    tier: 'same_domain' | 'same_platform' | 'underutilized';
}

interface RotationDetail {
    campaignId: string;
    campaignName: string | null;
    standbyMailboxId: string | null;
    standbyMailboxEmail: string | null;
    standbyTier: string;
    success: boolean;
    error?: string;
}

export interface RotationResult {
    totalCampaignsAffected: number;
    rotationsSucceeded: number;
    rotationsFailed: number;
    noStandbyAvailable: number;
    skippedUnhealthyCampaigns: number;
    details: RotationDetail[];
}

// Max rotations per pause event to avoid API rate limit exhaustion
const MAX_ROTATIONS_PER_EVENT = 5;
const ROTATION_DELAY_MS = 200;

// ============================================================================
// MAIN ENTRY POINT
// ============================================================================

/**
 * Called after a mailbox is paused and removed from campaigns.
 * For each affected campaign, attempts to find a standby healthy mailbox
 * and rotate it in as a replacement. Non-blocking — failures are logged
 * but do not affect the pause flow.
 */
export async function rotateForPausedMailbox(
    organizationId: string,
    pausedMailboxId: string,
    affectedCampaigns: AffectedCampaign[]
): Promise<RotationResult> {
    const result: RotationResult = {
        totalCampaignsAffected: affectedCampaigns.length,
        rotationsSucceeded: 0,
        rotationsFailed: 0,
        noStandbyAvailable: 0,
        skippedUnhealthyCampaigns: 0,
        details: []
    };

    if (affectedCampaigns.length === 0) {
        return result;
    }

    // Fetch the paused mailbox to get domain and platform info
    const pausedMailbox = await prisma.mailbox.findUnique({
        where: { id: pausedMailboxId },
        select: {
            email: true,
            domain_id: true,
            source_platform: true
        }
    });

    if (!pausedMailbox) {
        logger.warn('[ROTATION] Paused mailbox not found, skipping rotation', {
            organizationId,
            pausedMailboxId
        });
        return result;
    }

    logger.info('[ROTATION] Starting rotation for paused mailbox', {
        organizationId,
        pausedMailboxId,
        pausedEmail: pausedMailbox.email,
        domainId: pausedMailbox.domain_id,
        platform: pausedMailbox.source_platform,
        campaignsAffected: affectedCampaigns.length
    });

    // Track which mailboxes we've already rotated in this event to avoid reuse
    const usedStandbyIds: string[] = [pausedMailboxId];
    let rotationCount = 0;

    for (const campaign of affectedCampaigns) {
        // Cap rotations per event
        if (rotationCount >= MAX_ROTATIONS_PER_EVENT) {
            const remaining = affectedCampaigns.length - affectedCampaigns.indexOf(campaign);
            logger.info('[ROTATION] Max rotations per event reached, remaining campaigns skipped', {
                organizationId,
                maxReached: MAX_ROTATIONS_PER_EVENT,
                remainingCampaigns: remaining
            });

            await notificationService.createNotification(organizationId, {
                type: 'WARNING',
                title: 'Rotation Limit Reached',
                message: `Auto-rotation filled ${MAX_ROTATIONS_PER_EVENT} campaigns after ${pausedMailbox.email} was paused. ${remaining} additional campaign(s) may need manual mailbox assignment.`
            }).catch(err => logger.warn('[ROTATION] Non-fatal notification error', { error: String(err) }));

            break;
        }

        // Check campaign health — skip unhealthy campaigns
        const campaignData = await prisma.campaign.findUnique({
            where: { id: campaign.id },
            select: { status: true, bounce_rate: true, source_platform: true }
        });

        if (!campaignData || campaignData.status !== 'active') {
            result.skippedUnhealthyCampaigns++;
            result.details.push({
                campaignId: campaign.id,
                campaignName: campaign.name,
                standbyMailboxId: null,
                standbyMailboxEmail: null,
                standbyTier: 'none',
                success: false,
                error: `Campaign ${campaignData?.status || 'not found'}, skipped`
            });
            continue;
        }

        // Skip rotating into campaigns already toxic — bounce_rate stored as percentage (0-100),
        // compared against fraction constant × 100 to keep MONITORING_THRESHOLDS consistent.
        const rotationMaxPct = MONITORING_THRESHOLDS.ROTATION_MAX_CAMPAIGN_BOUNCE_RATE * 100;
        if (campaignData.bounce_rate >= rotationMaxPct) {
            result.skippedUnhealthyCampaigns++;
            result.details.push({
                campaignId: campaign.id,
                campaignName: campaign.name,
                standbyMailboxId: null,
                standbyMailboxEmail: null,
                standbyTier: 'none',
                success: false,
                error: `Campaign bounce rate ${campaignData.bounce_rate}% >= ${rotationMaxPct}% threshold, skipped`
            });
            continue;
        }

        // Find best standby mailbox
        const standby = await findBestStandbyMailbox(
            organizationId,
            campaign.id,
            pausedMailbox.domain_id,
            campaignData.source_platform,
            usedStandbyIds
        );

        if (!standby) {
            result.noStandbyAvailable++;
            result.details.push({
                campaignId: campaign.id,
                campaignName: campaign.name,
                standbyMailboxId: null,
                standbyMailboxEmail: null,
                standbyTier: 'none',
                success: false,
                error: 'No standby mailbox available'
            });

            // Notify user that no replacement is available
            await notificationService.createNotification(organizationId, {
                type: 'WARNING',
                title: 'No Standby Mailbox Available',
                message: `Campaign "${campaign.name || campaign.id}" lost mailbox ${pausedMailbox.email} and no standby replacement is available. Consider adding healthy mailboxes to your standby pool.`
            }).catch(err => logger.warn('[ROTATION] Non-fatal notification error', { error: String(err) }));

            continue;
        }

        // Execute the rotation
        const externalCampaignId = campaign.external_id || campaign.id;
        const rotationOutcome = await executeRotation(
            organizationId,
            campaign.id,
            externalCampaignId,
            standby,
            pausedMailboxId,
            pausedMailbox.email,
            campaign.name
        );

        if (rotationOutcome.success) {
            result.rotationsSucceeded++;
            usedStandbyIds.push(standby.id);
            rotationCount++;
        } else {
            result.rotationsFailed++;
        }

        result.details.push({
            campaignId: campaign.id,
            campaignName: campaign.name,
            standbyMailboxId: standby.id,
            standbyMailboxEmail: standby.email,
            standbyTier: standby.tier,
            success: rotationOutcome.success,
            error: rotationOutcome.error
        });

        // Delay between API calls to respect rate limits
        if (rotationCount < affectedCampaigns.length - 1) {
            await new Promise(resolve => setTimeout(resolve, ROTATION_DELAY_MS));
        }
    }

    logger.info('[ROTATION] Rotation complete', {
        organizationId,
        pausedMailboxId,
        totalCampaignsAffected: result.totalCampaignsAffected,
        rotationsSucceeded: result.rotationsSucceeded,
        rotationsFailed: result.rotationsFailed,
        noStandbyAvailable: result.noStandbyAvailable,
        skippedUnhealthyCampaigns: result.skippedUnhealthyCampaigns
    });

    return result;
}

// ============================================================================
// STANDBY SELECTION
// ============================================================================

/**
 * Find the best available standby mailbox for a campaign.
 * 3-tier fallback: same domain → same platform → underutilized.
 * Standby must match campaign's source_platform.
 */
async function findBestStandbyMailbox(
    organizationId: string,
    campaignId: string,
    preferredDomainId: string,
    requiredPlatform: SourcePlatform,
    excludeMailboxIds: string[]
): Promise<StandbyCandidate | null> {
    // Tier 1: Same domain, same platform, not in any campaign
    const tier1 = await prisma.mailbox.findMany({
        where: {
            organization_id: organizationId,
            domain_id: preferredDomainId,
            source_platform: requiredPlatform,
            status: 'healthy',
            recovery_phase: 'healthy',
            id: { notIn: excludeMailboxIds },
            domain: { status: 'healthy' },
            campaigns: { none: {} }
        },
        select: {
            id: true,
            email: true,
            domain_id: true,
            external_email_account_id: true,
            resilience_score: true
        },
        orderBy: { resilience_score: 'desc' }
    });

    for (const mb of tier1) {
        if (await isDomainSafeForRotation(mb.domain_id)) {
            return { ...mb, tier: 'same_domain' };
        }
    }

    // Tier 2: Same platform, different healthy domain, not in any campaign
    const tier2 = await prisma.mailbox.findMany({
        where: {
            organization_id: organizationId,
            domain_id: { not: preferredDomainId },
            source_platform: requiredPlatform,
            status: 'healthy',
            recovery_phase: 'healthy',
            id: { notIn: excludeMailboxIds },
            domain: { status: 'healthy' },
            campaigns: { none: {} }
        },
        select: {
            id: true,
            email: true,
            domain_id: true,
            external_email_account_id: true,
            resilience_score: true
        },
        orderBy: { resilience_score: 'desc' }
    });

    for (const mb of tier2) {
        if (await isDomainSafeForRotation(mb.domain_id)) {
            return { ...mb, tier: 'same_platform' };
        }
    }

    // Tier 3: Same platform, underutilized (< 3 campaigns), not already in target campaign
    const tier3 = await prisma.mailbox.findMany({
        where: {
            organization_id: organizationId,
            source_platform: requiredPlatform,
            status: 'healthy',
            recovery_phase: 'healthy',
            id: { notIn: excludeMailboxIds },
            domain: { status: 'healthy' },
            NOT: {
                campaigns: { some: { id: campaignId } }
            }
        },
        select: {
            id: true,
            email: true,
            domain_id: true,
            external_email_account_id: true,
            resilience_score: true,
            _count: { select: { campaigns: true } }
        },
        orderBy: { resilience_score: 'desc' }
    });

    const underutilized = tier3.filter(mb => mb._count.campaigns < 3);
    for (const mb of underutilized) {
        if (await isDomainSafeForRotation(mb.domain_id)) {
            const { _count, ...rest } = mb;
            return { ...rest, tier: 'underutilized' };
        }
    }

    return null;
}

/**
 * Check if a domain is safe to pull a mailbox from for rotation.
 * Prevents rotating the last healthy mailbox off a domain.
 */
async function isDomainSafeForRotation(domainId: string): Promise<boolean> {
    const domain = await prisma.domain.findUnique({
        where: { id: domainId },
        select: { warning_count: true }
    });

    // Skip stressed domains
    if (domain && domain.warning_count >= 2) {
        return false;
    }

    const healthyCount = await prisma.mailbox.count({
        where: {
            domain_id: domainId,
            status: 'healthy',
            recovery_phase: 'healthy'
        }
    });

    // Don't rotate out the last healthy mailbox on a domain
    return healthyCount > 1;
}

// ============================================================================
// EXECUTION
// ============================================================================

/**
 * Perform the actual rotation: platform API call + DB join table update.
 */
async function executeRotation(
    organizationId: string,
    campaignId: string,
    externalCampaignId: string,
    standby: StandbyCandidate,
    pausedMailboxId: string,
    pausedMailboxEmail: string,
    campaignName: string | null
): Promise<{ success: boolean; error?: string }> {
    // Fresh check: verify standby is still healthy (race condition protection)
    const freshCheck = await prisma.mailbox.findUnique({
        where: { id: standby.id },
        select: { status: true, recovery_phase: true }
    });

    if (!freshCheck || freshCheck.status !== 'healthy' || freshCheck.recovery_phase !== 'healthy') {
        return {
            success: false,
            error: `Standby mailbox ${standby.email} is no longer healthy (${freshCheck?.status}/${freshCheck?.recovery_phase})`
        };
    }

    // Idempotency: verify standby is not already in the campaign
    const alreadyInCampaign = await prisma.campaign.findFirst({
        where: {
            id: campaignId,
            mailboxes: { some: { id: standby.id } }
        }
    });

    if (alreadyInCampaign) {
        return {
            success: false,
            error: `Standby mailbox ${standby.email} is already in campaign ${campaignId}`
        };
    }

    // Use external ID if available, otherwise fall back to internal ID
    const externalMailboxId = standby.external_email_account_id || standby.id;

    try {
        // Step 1: Add to platform via adapter
        const adapter = await getAdapterForCampaign(campaignId);
        const added = await adapter.addMailboxToCampaign(
            organizationId,
            externalCampaignId,
            externalMailboxId
        );

        if (!added) {
            return { success: false, error: 'Platform API returned false' };
        }

        // Step 2: Update DB join table immediately
        await prisma.campaign.update({
            where: { id: campaignId },
            data: {
                mailboxes: {
                    connect: { id: standby.id }
                }
            }
        });

        // Step 3: Audit log on both entities
        await auditLogService.logAction({
            organizationId,
            entity: 'mailbox',
            entityId: standby.id,
            trigger: 'rotation_service',
            action: 'rotated_into_campaign',
            details: `Standby mailbox ${standby.email} rotated into campaign "${campaignName || campaignId}" to replace paused mailbox ${pausedMailboxEmail}. Tier: ${standby.tier}.`
        });

        await auditLogService.logAction({
            organizationId,
            entity: 'campaign',
            entityId: campaignId,
            trigger: 'rotation_service',
            action: 'mailbox_rotated_in',
            details: `Mailbox ${standby.email} auto-rotated in to replace paused mailbox ${pausedMailboxEmail}. Tier: ${standby.tier}.`
        });

        // Step 4: Notify user
        const tierLabel = standby.tier === 'same_domain' ? 'same domain'
            : standby.tier === 'same_platform' ? 'same platform standby'
            : 'underutilized pool';

        await notificationService.createNotification(organizationId, {
            type: 'INFO',
            title: 'Mailbox Auto-Rotated',
            message: `${standby.email} has been automatically added to campaign "${campaignName || campaignId}" to replace paused mailbox ${pausedMailboxEmail}. Source: ${tierLabel}.`
        });

        logger.info('[ROTATION] Successfully rotated standby mailbox into campaign', {
            organizationId,
            campaignId,
            campaignName,
            standbyMailboxId: standby.id,
            standbyEmail: standby.email,
            pausedMailboxId,
            pausedMailboxEmail,
            tier: standby.tier
        });

        return { success: true };

    } catch (error: any) {
        logger.error('[ROTATION] Failed to execute rotation', error, {
            organizationId,
            campaignId,
            standbyMailboxId: standby.id,
            standbyEmail: standby.email,
            pausedMailboxId
        });
        return { success: false, error: error.message };
    }
}
