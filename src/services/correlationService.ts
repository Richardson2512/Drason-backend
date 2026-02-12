/**
 * Cross-Entity Correlation Service
 * 
 * Implements Section 4.4 (Attribution Layer — Root Cause Isolation) of the
 * Implementation Plan.
 * 
 * Before pausing any entity, this service runs correlation checks to determine
 * whether the action should be escalated, redirected, or narrowed:
 * 
 *   1. Sibling mailboxes failing → escalate to domain-level pause
 *   2. Failures concentrated on one campaign → pause campaign, not mailbox
 *   3. Failures concentrated on one provider → provider restriction, not full pause
 *   4. Failures concentrated on one lead source → flag source, not infrastructure
 * 
 * This prevents over-pausing and creates accurate audit trails.
 */

import { prisma } from '../index';
import { EmailProvider, BounceFailureType } from '../types';
import logger from '../utils/logger';

// ============================================================================
// TYPES
// ============================================================================

export type CorrelationAction =
    | { action: 'pause_mailbox'; entityId: string; reason: string }
    | { action: 'pause_domain'; entityId: string; reason: string }
    | { action: 'pause_campaign'; entityId: string; reason: string }
    | { action: 'restrict_provider'; entityId: string; provider: EmailProvider; reason: string }
    | { action: 'flag_source'; source: string; reason: string };

export interface CorrelationResult {
    originalTarget: string;         // The entity that was about to be paused
    recommendedAction: CorrelationAction;
    correlations: {
        siblingMailboxesFailing: boolean;
        failingSiblingCount: number;
        totalSiblingCount: number;
        campaignConcentrated: boolean;
        concentratedCampaignId?: string;
        providerConcentrated: boolean;
        concentratedProvider?: EmailProvider;
    };
    message: string;
}

// ============================================================================
// CORRELATION THRESHOLDS
// ============================================================================

const SIBLING_FAILURE_RATIO = 0.5;      // ≥50% of siblings failing → domain issue
const CAMPAIGN_CONCENTRATION = 0.8;      // ≥80% of bounces from one campaign → campaign issue
const PROVIDER_CONCENTRATION = 0.8;      // ≥80% of bounces from one provider → provider issue
const RECENT_EVENT_WINDOW_MS = 86400000; // 24h lookback for correlation events

// ============================================================================
// PRE-PAUSE CORRELATION CHECK
// ============================================================================

/**
 * Run correlation checks before pausing a mailbox.
 * Returns a recommended action that may differ from the original pause intent.
 */
export async function correlateBeforePause(
    mailboxId: string,
    organizationId: string
): Promise<CorrelationResult> {
    const mailbox = await prisma.mailbox.findUnique({
        where: { id: mailboxId },
        include: { domain: true },
    });

    if (!mailbox) {
        return {
            originalTarget: mailboxId,
            recommendedAction: { action: 'pause_mailbox', entityId: mailboxId, reason: 'Mailbox not found — defaulting to direct pause' },
            correlations: makeEmptyCorrelations(),
            message: 'Mailbox not found',
        };
    }

    const cutoff = new Date(Date.now() - RECENT_EVENT_WINDOW_MS);

    // Fetch recent bounce events for this mailbox
    const recentBounces = await prisma.rawEvent.findMany({
        where: {
            entity_id: mailboxId,
            entity_type: 'mailbox',
            event_type: { in: ['HardBounce', 'SoftBounce'] },
            created_at: { gte: cutoff },
        },
        select: { payload: true },
    });

    // ── CHECK 1: Are sibling mailboxes on the same domain also failing? ──
    const siblingCheck = await checkSiblingMailboxes(mailbox.domain_id, mailboxId, organizationId);

    if (siblingCheck.shouldEscalate) {
        logger.info(`[CORRELATION] Escalating to domain pause: ${siblingCheck.failingCount}/${siblingCheck.totalCount} siblings failing`);
        return {
            originalTarget: mailboxId,
            recommendedAction: {
                action: 'pause_domain',
                entityId: mailbox.domain_id,
                reason: `${siblingCheck.failingCount}/${siblingCheck.totalCount} mailboxes on domain ${mailbox.domain?.domain} are failing — escalating to domain-level pause`,
            },
            correlations: {
                siblingMailboxesFailing: true,
                failingSiblingCount: siblingCheck.failingCount,
                totalSiblingCount: siblingCheck.totalCount,
                campaignConcentrated: false,
                providerConcentrated: false,
            },
            message: `Domain-level issue detected: ${siblingCheck.failingCount}/${siblingCheck.totalCount} siblings also failing`,
        };
    }

    // ── CHECK 2: Are failures concentrated on one campaign? ──
    const campaignCheck = checkCampaignConcentration(recentBounces);

    if (campaignCheck.concentrated) {
        logger.info(`[CORRELATION] Redirecting to campaign pause: ${campaignCheck.campaignId} has ${(campaignCheck.ratio * 100).toFixed(0)}% of bounces`);
        return {
            originalTarget: mailboxId,
            recommendedAction: {
                action: 'pause_campaign',
                entityId: campaignCheck.campaignId!,
                reason: `${(campaignCheck.ratio * 100).toFixed(0)}% of bounces from campaign ${campaignCheck.campaignId} — pausing campaign instead of mailbox`,
            },
            correlations: {
                siblingMailboxesFailing: false,
                failingSiblingCount: 0,
                totalSiblingCount: siblingCheck.totalCount,
                campaignConcentrated: true,
                concentratedCampaignId: campaignCheck.campaignId!,
                providerConcentrated: false,
            },
            message: `Campaign-level issue: ${(campaignCheck.ratio * 100).toFixed(0)}% of bounces from one campaign`,
        };
    }

    // ── CHECK 3: Are failures concentrated on one provider? ──
    const providerCheck = checkProviderConcentration(recentBounces);

    if (providerCheck.concentrated) {
        logger.info(`[CORRELATION] Applying provider restriction: ${providerCheck.provider} has ${(providerCheck.ratio * 100).toFixed(0)}% of bounces`);
        return {
            originalTarget: mailboxId,
            recommendedAction: {
                action: 'restrict_provider',
                entityId: mailboxId,
                provider: providerCheck.provider!,
                reason: `${(providerCheck.ratio * 100).toFixed(0)}% of bounces from ${providerCheck.provider} — applying provider restriction instead of full pause`,
            },
            correlations: {
                siblingMailboxesFailing: false,
                failingSiblingCount: 0,
                totalSiblingCount: siblingCheck.totalCount,
                campaignConcentrated: false,
                providerConcentrated: true,
                concentratedProvider: providerCheck.provider!,
            },
            message: `Provider-level issue: ${(providerCheck.ratio * 100).toFixed(0)}% of bounces from ${providerCheck.provider}`,
        };
    }

    // ── No correlation found: proceed with original mailbox pause ──
    return {
        originalTarget: mailboxId,
        recommendedAction: {
            action: 'pause_mailbox',
            entityId: mailboxId,
            reason: 'No cross-entity correlation found — proceeding with mailbox pause',
        },
        correlations: {
            siblingMailboxesFailing: false,
            failingSiblingCount: 0,
            totalSiblingCount: siblingCheck.totalCount,
            campaignConcentrated: false,
            providerConcentrated: false,
        },
        message: 'Direct mailbox issue — no escalation or redirection needed',
    };
}

// ============================================================================
// CHECK 1: Sibling Mailbox Correlation
// ============================================================================

async function checkSiblingMailboxes(
    domainId: string,
    excludeMailboxId: string,
    organizationId: string
): Promise<{ shouldEscalate: boolean; failingCount: number; totalCount: number }> {
    const siblings = await prisma.mailbox.findMany({
        where: {
            domain_id: domainId,
            organization_id: organizationId,
            id: { not: excludeMailboxId },
        },
        select: { id: true, status: true, window_bounce_count: true, window_sent_count: true },
    });

    const totalCount = siblings.length + 1; // Include the current mailbox
    const failingSiblings = siblings.filter(s =>
        s.status === 'paused' || s.status === 'warning' ||
        (s.window_sent_count > 0 && s.window_bounce_count / s.window_sent_count > 0.05)
    );

    const failingCount = failingSiblings.length + 1; // +1 for the current mailbox being paused
    const failingRatio = failingCount / totalCount;

    return {
        shouldEscalate: failingRatio >= SIBLING_FAILURE_RATIO && totalCount >= 2,
        failingCount,
        totalCount,
    };
}

// ============================================================================
// CHECK 2: Campaign Concentration
// ============================================================================

function checkCampaignConcentration(bounceEvents: { payload: any }[]): {
    concentrated: boolean;
    campaignId?: string;
    ratio: number;
} {
    if (bounceEvents.length < 3) {
        return { concentrated: false, ratio: 0 };
    }

    const campaignCounts: Record<string, number> = {};
    for (const event of bounceEvents) {
        const payload = typeof event.payload === 'string' ? JSON.parse(event.payload) : event.payload;
        const campaignId = payload?.campaignId;
        if (campaignId) {
            campaignCounts[campaignId] = (campaignCounts[campaignId] || 0) + 1;
        }
    }

    const entries = Object.entries(campaignCounts);
    if (entries.length === 0) return { concentrated: false, ratio: 0 };

    const [topCampaign, topCount] = entries.reduce((max, curr) =>
        curr[1] > max[1] ? curr : max
    );

    const ratio = topCount / bounceEvents.length;

    return {
        concentrated: ratio >= CAMPAIGN_CONCENTRATION && entries.length > 1,
        campaignId: topCampaign,
        ratio,
    };
}

// ============================================================================
// CHECK 3: Provider Concentration
// ============================================================================

function checkProviderConcentration(bounceEvents: { payload: any }[]): {
    concentrated: boolean;
    provider?: EmailProvider;
    ratio: number;
} {
    if (bounceEvents.length < 3) {
        return { concentrated: false, ratio: 0 };
    }

    const providerCounts: Record<string, number> = {};
    for (const event of bounceEvents) {
        const payload = typeof event.payload === 'string' ? JSON.parse(event.payload) : event.payload;
        const provider = payload?.provider;
        if (provider && provider !== 'other') {
            providerCounts[provider] = (providerCounts[provider] || 0) + 1;
        }
    }

    const entries = Object.entries(providerCounts);
    if (entries.length === 0) return { concentrated: false, ratio: 0 };

    const [topProvider, topCount] = entries.reduce((max, curr) =>
        curr[1] > max[1] ? curr : max
    );

    const ratio = topCount / bounceEvents.length;

    return {
        concentrated: ratio >= PROVIDER_CONCENTRATION,
        provider: topProvider as EmailProvider,
        ratio,
    };
}

// ============================================================================
// HELPERS
// ============================================================================

function makeEmptyCorrelations() {
    return {
        siblingMailboxesFailing: false,
        failingSiblingCount: 0,
        totalSiblingCount: 0,
        campaignConcentrated: false,
        providerConcentrated: false,
    };
}
