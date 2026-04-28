/**
 * Feature Gate Middleware
 *
 * Subscription-status check only. Per-entity caps (leads / domains / mailboxes /
 * webhook endpoints / DNSBL depth) were removed on 2026-04-27 — Superkabe now
 * meters only monthly send volume and email-validation credits. The protection
 * layer is a flat capability that runs comprehensively on every connected
 * entity, regardless of tier.
 */

import { Request, Response, NextFunction } from 'express';
import { prisma } from '../index';
import { logger } from '../services/observabilityService';
import { getOrgId } from './orgContext';

/**
 * Block requests if subscription is expired, past_due, or canceled.
 * Applies to all protected operations.
 */
export function checkSubscriptionStatus(req: Request, res: Response, next: NextFunction): void {
    (async () => {
        try {
            const orgId = getOrgId(req);

            const org = await prisma.organization.findUnique({
                where: { id: orgId },
                select: { subscription_status: true, subscription_tier: true },
            });

            if (!org) {
                return res.status(404).json({ error: 'Organization not found' });
            }

            const blockedStatuses = ['expired', 'past_due', 'canceled'];
            if (blockedStatuses.includes(org.subscription_status)) {
                logger.warn('[FEATURE-GATE] Request blocked: subscription inactive', {
                    orgId,
                    status: org.subscription_status,
                });

                return res.status(403).json({
                    error: 'Subscription required',
                    message: getSubscriptionMessage(org.subscription_status),
                    subscription_status: org.subscription_status,
                    upgrade_required: true,
                });
            }

            next();
        } catch (error) {
            logger.error(
                '[FEATURE-GATE] Status check failed',
                error instanceof Error ? error : new Error(String(error)),
            );
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
