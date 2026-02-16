/**
 * Feature Gate Middleware
 *
 * Enforces subscription-based capacity limits and status checks.
 * Blocks operations when:
 * - Subscription has expired
 * - Subscription is past_due
 * - Subscription is canceled
 * - Tier limits have been reached
 */

import { Request, Response, NextFunction } from 'express';
import { prisma } from '../index';
import { logger } from '../services/observabilityService';
import { TIER_LIMITS } from '../services/polarClient';
import { getOrganizationId } from './auth';

// ============================================================================
// SUBSCRIPTION STATUS CHECK
// ============================================================================

/**
 * Block requests if subscription is expired, past_due, or canceled.
 * Applies to all protected operations.
 */
export function checkSubscriptionStatus(req: Request, res: Response, next: NextFunction): void {
    (async () => {
        try {
            const orgId = getOrganizationId(req);

            const org = await prisma.organization.findUnique({
                where: { id: orgId },
                select: { subscription_status: true, subscription_tier: true }
            });

            if (!org) {
                return res.status(404).json({
                    error: 'Organization not found'
                });
            }

            // Block if subscription is in a non-active state
            const blockedStatuses = ['expired', 'past_due', 'canceled'];
            if (blockedStatuses.includes(org.subscription_status)) {
                logger.warn('[FEATURE-GATE] Request blocked: subscription inactive', {
                    orgId,
                    status: org.subscription_status
                });

                return res.status(403).json({
                    error: 'Subscription required',
                    message: getSubscriptionMessage(org.subscription_status),
                    subscription_status: org.subscription_status,
                    upgrade_required: true
                });
            }

            next();
        } catch (error) {
            logger.error('[FEATURE-GATE] Status check failed', error instanceof Error ? error : new Error(String(error)));
            return res.status(500).json({ error: 'Failed to check subscription status' });
        }
    })();
}

function getSubscriptionMessage(status: string): string {
    switch (status) {
        case 'expired':
            return 'Your trial has ended. Upgrade to continue using Superkabe.';
        case 'past_due':
            return 'Your payment is past due. Please update your payment method.';
        case 'canceled':
            return 'Your subscription has been canceled. Reactivate to continue.';
        default:
            return 'Subscription required to perform this action.';
    }
}

// ============================================================================
// CAPACITY CHECKS
// ============================================================================

/**
 * Check if organization can add more leads.
 * Blocks if at or above tier limit.
 */
export function checkLeadCapacity(req: Request, res: Response, next: NextFunction): void {
    (async () => {
        try {
            const orgId = getOrganizationId(req);

            const org = await prisma.organization.findUnique({
                where: { id: orgId },
                select: {
                    subscription_tier: true,
                    subscription_status: true,
                    current_lead_count: true
                }
            });

            if (!org) {
                return res.status(404).json({ error: 'Organization not found' });
            }

            // Check subscription status first
            const blockedStatuses = ['expired', 'past_due', 'canceled'];
            if (blockedStatuses.includes(org.subscription_status)) {
                return res.status(403).json({
                    error: 'Subscription required',
                    message: getSubscriptionMessage(org.subscription_status),
                    upgrade_required: true
                });
            }

            // Check capacity
            const limits = TIER_LIMITS[org.subscription_tier] || TIER_LIMITS.trial;

            if (org.current_lead_count >= limits.leads) {
                logger.warn('[FEATURE-GATE] Lead capacity reached', {
                    orgId,
                    current: org.current_lead_count,
                    limit: limits.leads,
                    tier: org.subscription_tier
                });

                return res.status(403).json({
                    error: 'Lead limit reached',
                    message: `You've reached your limit of ${limits.leads} active leads. Upgrade to add more.`,
                    current: org.current_lead_count,
                    limit: limits.leads,
                    tier: org.subscription_tier,
                    upgrade_required: true
                });
            }

            next();
        } catch (error) {
            logger.error('[FEATURE-GATE] Lead capacity check failed', error instanceof Error ? error : new Error(String(error)));
            return res.status(500).json({ error: 'Failed to check lead capacity' });
        }
    })();
}

/**
 * Check if organization can add more domains.
 * Blocks if at or above tier limit.
 */
export function checkDomainCapacity(req: Request, res: Response, next: NextFunction): void {
    (async () => {
        try {
            const orgId = getOrganizationId(req);

            const org = await prisma.organization.findUnique({
                where: { id: orgId },
                select: {
                    subscription_tier: true,
                    subscription_status: true,
                    current_domain_count: true
                }
            });

            if (!org) {
                return res.status(404).json({ error: 'Organization not found' });
            }

            // Check subscription status first
            const blockedStatuses = ['expired', 'past_due', 'canceled'];
            if (blockedStatuses.includes(org.subscription_status)) {
                return res.status(403).json({
                    error: 'Subscription required',
                    message: getSubscriptionMessage(org.subscription_status),
                    upgrade_required: true
                });
            }

            // Check capacity
            const limits = TIER_LIMITS[org.subscription_tier] || TIER_LIMITS.trial;

            if (org.current_domain_count >= limits.domains) {
                logger.warn('[FEATURE-GATE] Domain capacity reached', {
                    orgId,
                    current: org.current_domain_count,
                    limit: limits.domains,
                    tier: org.subscription_tier
                });

                return res.status(403).json({
                    error: 'Domain limit reached',
                    message: `You've reached your limit of ${limits.domains} domains. Upgrade to add more.`,
                    current: org.current_domain_count,
                    limit: limits.domains,
                    tier: org.subscription_tier,
                    upgrade_required: true
                });
            }

            next();
        } catch (error) {
            logger.error('[FEATURE-GATE] Domain capacity check failed', error instanceof Error ? error : new Error(String(error)));
            return res.status(500).json({ error: 'Failed to check domain capacity' });
        }
    })();
}

/**
 * Check if organization can add more mailboxes.
 * Blocks if at or above tier limit.
 */
export function checkMailboxCapacity(req: Request, res: Response, next: NextFunction): void {
    (async () => {
        try {
            const orgId = getOrganizationId(req);

            const org = await prisma.organization.findUnique({
                where: { id: orgId },
                select: {
                    subscription_tier: true,
                    subscription_status: true,
                    current_mailbox_count: true
                }
            });

            if (!org) {
                return res.status(404).json({ error: 'Organization not found' });
            }

            // Check subscription status first
            const blockedStatuses = ['expired', 'past_due', 'canceled'];
            if (blockedStatuses.includes(org.subscription_status)) {
                return res.status(403).json({
                    error: 'Subscription required',
                    message: getSubscriptionMessage(org.subscription_status),
                    upgrade_required: true
                });
            }

            // Check capacity
            const limits = TIER_LIMITS[org.subscription_tier] || TIER_LIMITS.trial;

            if (org.current_mailbox_count >= limits.mailboxes) {
                logger.warn('[FEATURE-GATE] Mailbox capacity reached', {
                    orgId,
                    current: org.current_mailbox_count,
                    limit: limits.mailboxes,
                    tier: org.subscription_tier
                });

                return res.status(403).json({
                    error: 'Mailbox limit reached',
                    message: `You've reached your limit of ${limits.mailboxes} mailboxes. Upgrade to add more.`,
                    current: org.current_mailbox_count,
                    limit: limits.mailboxes,
                    tier: org.subscription_tier,
                    upgrade_required: true
                });
            }

            next();
        } catch (error) {
            logger.error('[FEATURE-GATE] Mailbox capacity check failed', error instanceof Error ? error : new Error(String(error)));
            return res.status(500).json({ error: 'Failed to check mailbox capacity' });
        }
    })();
}
