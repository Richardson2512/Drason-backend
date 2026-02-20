/**
 * Campaign Health Service
 * 
 * Implements Campaign-Level Pause functionality.
 * Detects when a campaign is "poisoning" mailboxes and pauses the campaign
 * rather than just the individual mailboxes.
 * 
 * Features:
 * - Campaign bounce rate tracking
 * - Campaign-level pause/resume
 * - Campaign poisoning detection
 */

import { prisma } from '../index';
import * as auditLogService from './auditLogService';
import * as notificationService from './notificationService';
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

// Campaign health thresholds
const BOUNCE_RATE_WARNING = 0.05;  // 5% bounce rate → WARNING
const BOUNCE_RATE_PAUSE = 0.10;    // 10% bounce rate → PAUSE
const MIN_SENDS_FOR_EVALUATION = 20;  // Need at least 20 sends to evaluate

// Poisoning detection: if campaign causes bounces on N+ different mailboxes
const POISONING_MAILBOX_THRESHOLD = 3;

// ============================================================================
// CAMPAIGN HEALTH CHECK
// ============================================================================

/**
 * Check campaign health and determine if action is needed.
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

    // Count mailboxes that have bounces from this campaign
    const affectedMailboxes = campaign.mailboxes.filter(mb => mb.window_bounce_count > 0).length;
    const isPoisoning = affectedMailboxes >= POISONING_MAILBOX_THRESHOLD && campaign.total_bounced > 5;

    let status: CampaignStatus = 'active';
    if (campaign.total_sent >= MIN_SENDS_FOR_EVALUATION) {
        if (bounceRate >= BOUNCE_RATE_PAUSE) {
            status = 'paused';
        } else if (bounceRate >= BOUNCE_RATE_WARNING) {
            status = 'warning';
        }
    }

    // ── INVARIANT: Campaign can NEVER be healthier than its infrastructure ──
    // Check worst domain and mailbox states. Campaign status ceiling is
    // capped at the worst infrastructure state.
    if (campaign.mailboxes.length > 0) {
        const hasAnyPausedDomain = campaign.mailboxes.some(m => m.domain.status === 'paused');
        const hasAnyPausedMailbox = campaign.mailboxes.some(m => m.status === 'paused');
        const hasAnyWarningDomain = campaign.mailboxes.some(m => m.domain.status === 'warning');
        const hasAnyWarningMailbox = campaign.mailboxes.some(m => m.status === 'warning');

        if ((hasAnyPausedDomain || hasAnyPausedMailbox) && status !== 'paused') {
            status = 'paused';
        } else if ((hasAnyWarningDomain || hasAnyWarningMailbox) && status === 'active') {
            status = 'warning';
        }
    }

    return {
        status,
        bounceRate,
        totalSent: campaign.total_sent,
        totalBounced: campaign.total_bounced,
        warningCount: campaign.warning_count,
        isPoisoning,
        affectedMailboxes
    };
}

// ============================================================================
// CAMPAIGN PAUSE/RESUME
// ============================================================================

/**
 * Pause a campaign.
 */
export async function pauseCampaign(
    organizationId: string,
    campaignId: string,
    reason: string
): Promise<void> {
    await prisma.campaign.update({
        where: { id: campaignId },
        data: {
            status: 'paused',
            paused_reason: reason,
            paused_at: new Date(),
            paused_by: 'system'
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

    // Notify user
    try {
        const campaign = await prisma.campaign.findUnique({ where: { id: campaignId }, select: { name: true } });
        await notificationService.createNotification(organizationId, {
            type: 'WARNING',
            title: 'Campaign Paused',
            message: `Campaign "${campaign?.name || campaignId}" has been automatically paused. Reason: ${reason}`,
        });
    } catch (notifError) {
        logger.warn('Failed to create campaign pause notification', { campaignId });
    }
}

/**
 * Resume a campaign.
 */
export async function resumeCampaign(
    organizationId: string,
    campaignId: string
): Promise<void> {
    await prisma.campaign.update({
        where: { id: campaignId },
        data: {
            status: 'active',
            paused_reason: null,
            paused_at: null,
            warning_count: 0  // Reset warning count on resume
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

    // Notify user
    try {
        const campaign = await prisma.campaign.findUnique({ where: { id: campaignId }, select: { name: true } });
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
    await prisma.campaign.update({
        where: { id: campaignId },
        data: {
            status: 'warning',
            warning_count: { increment: 1 }
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
 */
export async function recordCampaignBounce(
    organizationId: string,
    campaignId: string
): Promise<void> {
    await prisma.campaign.update({
        where: { id: campaignId },
        data: {
            total_bounced: { increment: 1 },
            bounce_rate: {
                // Recalculate bounce rate
                // This is a simplified approach; could use a computed field
            }
        }
    });

    // Check if campaign should be warned or paused
    const healthResult = await checkCampaignHealth(organizationId, campaignId);

    if (healthResult.isPoisoning) {
        await pauseCampaign(organizationId, campaignId,
            `Campaign poisoning detected: causing bounces on ${healthResult.affectedMailboxes} mailboxes`);
    } else if (healthResult.status === 'paused' && healthResult.bounceRate >= BOUNCE_RATE_PAUSE) {
        await pauseCampaign(organizationId, campaignId,
            `Bounce rate exceeded threshold: ${(healthResult.bounceRate * 100).toFixed(1)}%`);
    } else if (healthResult.status === 'warning') {
        await warnCampaign(organizationId, campaignId,
            `Elevated bounce rate: ${(healthResult.bounceRate * 100).toFixed(1)}%`);
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

    // Recalculate bounce rate
    if (campaign.total_sent > 0) {
        const bounceRate = campaign.total_bounced / campaign.total_sent;
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
