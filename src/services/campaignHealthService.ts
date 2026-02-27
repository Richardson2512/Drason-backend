/**
 * Campaign Health Service
 *
 * Implements Campaign-Level Pause functionality.
 *
 * RULE: Campaigns are NEVER paused based on bounce rate directly.
 *       Only MAILBOXES get paused for bounce rate thresholds.
 *       Campaigns pause ONLY when ALL their mailboxes are paused/removed.
 *
 * Features:
 * - Campaign infrastructure health tracking (mailbox/domain health)
 * - Campaign-level pause/resume
 * - Warning when majority of mailboxes are degraded
 */

import { prisma } from '../index';
import * as auditLogService from './auditLogService';
import * as notificationService from './notificationService';
import { getAdapterForCampaign } from '../adapters/platformRegistry';
import { logger } from './observabilityService';

// ============================================================================
// TYPES
// ============================================================================

export type CampaignStatus = 'active' | 'paused' | 'warning';

export interface CampaignHealthResult {
    status: CampaignStatus;
    bounceRate: number;
    totalSent: number;
    totalBounced: number;
    warningCount: number;
    isPoisoning: boolean;
    affectedMailboxes: number;
}

// ============================================================================
// CONSTANTS
// ============================================================================

// RULE: Campaigns are NOT paused based on bounce rate.
// Campaign pause is driven purely by infrastructure health (mailbox/domain states).
// Threshold: Campaign pauses when ALL mailboxes are paused/removed.
// Warning: Campaign warns when >50% of mailboxes are unhealthy.

// ============================================================================
// CAMPAIGN HEALTH CHECK
// ============================================================================

/**
 * Check campaign health based on infrastructure state (mailbox/domain health).
 *
 * RULE: Campaigns are NEVER paused based on bounce rate.
 *       Campaigns pause ONLY when ALL mailboxes are paused/removed.
 *       Campaigns warn when >50% of mailboxes are unhealthy.
 */
export async function checkCampaignHealth(
    organizationId: string,
    campaignId: string
): Promise<CampaignHealthResult> {
    const campaign = await prisma.campaign.findUnique({
        where: { id: campaignId },
        include: {
            mailboxes: {
                select: {
                    id: true,
                    status: true,
                    window_bounce_count: true,
                    domain: {
                        select: { status: true }
                    }
                }
            }
        }
    });

    if (!campaign) {
        throw new Error(`Campaign not found: ${campaignId}`);
    }

    const bounceRate = campaign.total_sent > 0
        ? campaign.total_bounced / campaign.total_sent
        : 0;

    const affectedMailboxes = campaign.mailboxes.filter(mb => mb.window_bounce_count > 0).length;

    // ── INFRASTRUCTURE-ONLY CAMPAIGN STATUS ──
    // Campaign status is determined SOLELY by mailbox/domain health:
    //   - ALL mailboxes paused/removed → campaign PAUSED
    //   - >50% mailboxes paused/warning → campaign WARNING
    //   - Otherwise → campaign ACTIVE
    let status: CampaignStatus = 'active';

    if (campaign.mailboxes.length === 0) {
        // No mailboxes at all — campaign cannot send, pause it
        status = 'paused';
    } else {
        const healthyMailboxes = campaign.mailboxes.filter(m =>
            m.status === 'healthy' && m.domain.status !== 'paused'
        );
        const pausedOrRemovedMailboxes = campaign.mailboxes.filter(m =>
            m.status === 'paused' || m.domain.status === 'paused'
        );

        if (healthyMailboxes.length === 0) {
            // ALL mailboxes are paused/removed — pause campaign
            status = 'paused';
        } else if (pausedOrRemovedMailboxes.length > campaign.mailboxes.length * 0.5) {
            // >50% of mailboxes are degraded — warn
            status = 'warning';
        }
    }

    return {
        status,
        bounceRate,
        totalSent: campaign.total_sent,
        totalBounced: campaign.total_bounced,
        warningCount: campaign.warning_count,
        isPoisoning: false, // Poisoning detection removed — bounce rate doesn't pause campaigns
        affectedMailboxes
    };
}

// ============================================================================
// CAMPAIGN PAUSE/RESUME
// ============================================================================

/**
 * Pause a campaign — updates local DB AND syncs to external platform.
 */
export async function pauseCampaign(
    organizationId: string,
    campaignId: string,
    reason: string
): Promise<void> {
    const campaign = await prisma.campaign.findUnique({
        where: { id: campaignId },
        select: { name: true, external_id: true, status: true }
    });

    if (!campaign || campaign.status === 'paused') return;

    const previousStatus = campaign.status;
    await prisma.campaign.update({
        where: { id: campaignId },
        data: {
            status: 'paused',
            paused_reason: reason,
            paused_at: new Date(),
            paused_by: 'system'
        }
    });

    // Record state transition for traceability
    await prisma.stateTransition.create({
        data: {
            organization_id: organizationId,
            entity_type: 'campaign',
            entity_id: campaignId,
            from_state: previousStatus,
            to_state: 'paused',
            reason,
            triggered_by: 'threshold_breach',
        }
    });

    await auditLogService.logAction({
        organizationId,
        entity: 'campaign',
        entityId: campaignId,
        trigger: 'health_check',
        action: 'paused',
        details: reason
    });

    logger.info(`[CAMPAIGN] Paused campaign ${campaignId}: ${reason}`);

    // ── PLATFORM SYNC: Pause campaign on external platform (Smartlead etc.) ──
    try {
        const adapter = await getAdapterForCampaign(campaignId);
        const externalCampaignId = campaign.external_id || campaignId;
        await adapter.pauseCampaign(organizationId, externalCampaignId);
        logger.info(`[CAMPAIGN] Paused campaign ${campaignId} on platform`, { organizationId, platform: adapter.platform });
    } catch (platformError: any) {
        // Platform sync failure is non-blocking — campaign is paused locally
        logger.error(`[CAMPAIGN] Failed to pause campaign ${campaignId} on platform`, platformError, { organizationId });
    }

    // Notify user
    try {
        await notificationService.createNotification(organizationId, {
            type: 'WARNING',
            title: 'Campaign Paused',
            message: `Campaign "${campaign.name || campaignId}" has been automatically paused. Reason: ${reason}`,
        });
    } catch (notifError) {
        logger.warn('Failed to create campaign pause notification', { campaignId });
    }
}

/**
 * Resume a campaign — updates local DB AND syncs to external platform.
 */
export async function resumeCampaign(
    organizationId: string,
    campaignId: string
): Promise<void> {
    const campaign = await prisma.campaign.findUnique({
        where: { id: campaignId },
        select: { name: true, external_id: true, status: true }
    });

    const previousStatus = campaign?.status || 'unknown';
    await prisma.campaign.update({
        where: { id: campaignId },
        data: {
            status: 'active',
            paused_reason: null,
            paused_at: null,
            warning_count: 0  // Reset warning count on resume
        }
    });

    // Record state transition for traceability
    await prisma.stateTransition.create({
        data: {
            organization_id: organizationId,
            entity_type: 'campaign',
            entity_id: campaignId,
            from_state: previousStatus,
            to_state: 'active',
            reason: 'Campaign resumed',
            triggered_by: 'manual',
        }
    });

    await auditLogService.logAction({
        organizationId,
        entity: 'campaign',
        entityId: campaignId,
        trigger: 'manual',
        action: 'resumed',
        details: 'Campaign resumed by operator'
    });

    logger.info(`[CAMPAIGN] Resumed campaign ${campaignId}`);

    // ── PLATFORM SYNC: Resume campaign on external platform ──
    try {
        const adapter = await getAdapterForCampaign(campaignId);
        const externalCampaignId = campaign?.external_id || campaignId;
        await adapter.resumeCampaign(organizationId, externalCampaignId);
        logger.info(`[CAMPAIGN] Resumed campaign ${campaignId} on platform`, { organizationId, platform: adapter.platform });
    } catch (platformError: any) {
        logger.error(`[CAMPAIGN] Failed to resume campaign ${campaignId} on platform`, platformError, { organizationId });
    }

    // Notify user
    try {
        await notificationService.createNotification(organizationId, {
            type: 'SUCCESS',
            title: 'Campaign Resumed',
            message: `Campaign "${campaign?.name || campaignId}" has been resumed and is now active.`,
        });
    } catch (notifError) {
        logger.warn('Failed to create campaign resume notification', { campaignId });
    }
}

/**
 * Increment warning count for a campaign.
 */
export async function warnCampaign(
    organizationId: string,
    campaignId: string,
    reason: string
): Promise<void> {
    const campaign = await prisma.campaign.findUnique({
        where: { id: campaignId },
        select: { status: true }
    });

    await prisma.campaign.update({
        where: { id: campaignId },
        data: {
            status: 'warning',
            warning_count: { increment: 1 }
        }
    });

    // Record state transition for traceability
    await prisma.stateTransition.create({
        data: {
            organization_id: organizationId,
            entity_type: 'campaign',
            entity_id: campaignId,
            from_state: campaign?.status || 'unknown',
            to_state: 'warning',
            reason,
            triggered_by: 'threshold_breach',
        }
    });

    await auditLogService.logAction({
        organizationId,
        entity: 'campaign',
        entityId: campaignId,
        trigger: 'health_check',
        action: 'warning',
        details: reason
    });

    logger.info(`[CAMPAIGN] Warning for campaign ${campaignId}: ${reason}`);

    // Notify user
    try {
        const campaign = await prisma.campaign.findUnique({ where: { id: campaignId }, select: { name: true } });
        await notificationService.createNotification(organizationId, {
            type: 'WARNING',
            title: 'Campaign Health Warning',
            message: `Campaign "${campaign?.name || campaignId}" is showing elevated risk. ${reason}`,
        });
    } catch (notifError) {
        logger.warn('Failed to create campaign warning notification', { campaignId });
    }
}

// ============================================================================
// BOUNCE TRACKING
// ============================================================================

/**
 * Record a bounce for a campaign.
 * Called when a bounce event is received from Smartlead.
 *
 * NOTE: This only updates bounce STATS (for reporting).
 * It does NOT pause/warn the campaign — campaigns are paused based on
 * infrastructure health (all mailboxes paused/removed), never bounce rate.
 */
export async function recordCampaignBounce(
    organizationId: string,
    campaignId: string
): Promise<void> {
    await prisma.campaign.update({
        where: { id: campaignId },
        data: {
            total_bounced: { increment: 1 },
        }
    });

    // Recalculate bounce rate for reporting only (does NOT trigger pause/warn)
    const campaign = await prisma.campaign.findUnique({
        where: { id: campaignId },
        select: { total_sent: true, total_bounced: true }
    });

    if (campaign && campaign.total_sent > 0) {
        // Store as percentage (0-100) — consistent with smartleadEventParserService
        const bounceRate = (campaign.total_bounced / campaign.total_sent) * 100;
        await prisma.campaign.update({
            where: { id: campaignId },
            data: { bounce_rate: bounceRate }
        });
    }
}

/**
 * Record a sent email for a campaign.
 */
export async function recordCampaignSent(
    organizationId: string,
    campaignId: string
): Promise<void> {
    const campaign = await prisma.campaign.update({
        where: { id: campaignId },
        data: {
            total_sent: { increment: 1 }
        }
    });

    // Recalculate bounce rate (stored as percentage 0-100)
    if (campaign.total_sent > 0) {
        const bounceRate = (campaign.total_bounced / campaign.total_sent) * 100;
        await prisma.campaign.update({
            where: { id: campaignId },
            data: { bounce_rate: bounceRate }
        });
    }
}

// ============================================================================
// STATISTICS
// ============================================================================

/**
 * Get campaign health statistics for an organization.
 */
export async function getCampaignHealthStats(organizationId: string): Promise<{
    total: number;
    active: number;
    paused: number;
    warning: number;
    campaigns: Array<{
        id: string;
        name: string;
        status: string;
        bounce_rate: number;
        total_sent: number;
        total_bounced: number;
        paused_reason: string | null;
    }>;
}> {
    const campaigns = await prisma.campaign.findMany({
        where: { organization_id: organizationId },
        select: {
            id: true,
            name: true,
            status: true,
            bounce_rate: true,
            total_sent: true,
            total_bounced: true,
            paused_reason: true
        },
        orderBy: { updated_at: 'desc' }
    });

    const total = campaigns.length;
    const active = campaigns.filter(c => c.status === 'active').length;
    const paused = campaigns.filter(c => c.status === 'paused').length;
    const warning = campaigns.filter(c => c.status === 'warning').length;

    return { total, active, paused, warning, campaigns };
}
