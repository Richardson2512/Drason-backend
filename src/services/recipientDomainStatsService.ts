/**
 * Recipient Domain Stats Service
 *
 * Computes per-recipient-domain complaint rates from local BounceEvent +
 * SendEvent data. Used by the execution gate to throttle/block enrollment
 * for recipient domains we've already generated complaints to.
 *
 * Why local computation: Google Postmaster Tools reports our SENDING domain's
 * reputation, not per-recipient-domain reputation. We have to compute the
 * inverse signal (which recipient domains complain about us) ourselves.
 *
 * Caching: in-process Map keyed by (orgId, domain) with 1h TTL. Avoids
 * hammering the DB on every gate call.
 */

import { prisma } from '../index';
import { MONITORING_THRESHOLDS } from '../types';
import { logger } from './observabilityService';

const {
    RECIPIENT_DOMAIN_WINDOW_DAYS,
    RECIPIENT_DOMAIN_MIN_SENDS
} = MONITORING_THRESHOLDS;

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

interface DomainStats {
    sendCount: number;
    complaintCount: number;
    rate: number;          // complaints / sends (0–1)
    sufficientSample: boolean;
    fetchedAt: number;
}

const cache = new Map<string, DomainStats>();

function cacheKey(orgId: string, domain: string): string {
    return `${orgId}::${domain.toLowerCase()}`;
}

/**
 * Get the recipient-domain complaint rate over the rolling window.
 * Returns sufficientSample=false if the org hasn't sent enough volume to the
 * domain to compute a meaningful rate (default: <1000 sends in window).
 */
export async function getRecipientDomainComplaintRate(
    organizationId: string,
    recipientDomain: string
): Promise<DomainStats> {
    const key = cacheKey(organizationId, recipientDomain);
    const cached = cache.get(key);
    if (cached && (Date.now() - cached.fetchedAt) < CACHE_TTL_MS) {
        return cached;
    }

    const since = new Date(Date.now() - RECIPIENT_DOMAIN_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const domainSuffix = `@${recipientDomain.toLowerCase()}`;

    try {
        const [sendCount, complaintCount] = await Promise.all([
            prisma.sendEvent.count({
                where: {
                    organization_id: organizationId,
                    sent_at: { gte: since },
                    recipient_email: { endsWith: domainSuffix, mode: 'insensitive' },
                },
            }),
            // Spam-complaint signal: PROVIDER_SPAM_REJECTION classification or
            // explicit "spam" / "abuse" reason text. Hard bounces alone aren't
            // complaints — only spam rejections / FBL events are.
            prisma.bounceEvent.count({
                where: {
                    organization_id: organizationId,
                    bounced_at: { gte: since },
                    email_address: { endsWith: domainSuffix, mode: 'insensitive' },
                    OR: [
                        { bounce_reason: { contains: 'spam', mode: 'insensitive' } },
                        { bounce_reason: { contains: 'abuse', mode: 'insensitive' } },
                        { bounce_reason: { contains: 'complaint', mode: 'insensitive' } },
                    ],
                },
            }),
        ]);

        const stats: DomainStats = {
            sendCount,
            complaintCount,
            rate: sendCount > 0 ? complaintCount / sendCount : 0,
            sufficientSample: sendCount >= RECIPIENT_DOMAIN_MIN_SENDS,
            fetchedAt: Date.now(),
        };
        cache.set(key, stats);
        return stats;
    } catch (err) {
        logger.warn('[RECIPIENT-DOMAIN-STATS] Failed to compute complaint rate', {
            organizationId, recipientDomain, error: String(err),
        });
        // Fail open: return empty stats so the gate doesn't block on infra error
        const stats: DomainStats = {
            sendCount: 0,
            complaintCount: 0,
            rate: 0,
            sufficientSample: false,
            fetchedAt: Date.now(),
        };
        return stats;
    }
}

/**
 * Manually invalidate a cached entry. Used after high-impact events (manual
 * complaint-rate recompute, post-import).
 */
export function invalidateRecipientDomain(organizationId: string, recipientDomain: string): void {
    cache.delete(cacheKey(organizationId, recipientDomain));
}

/** Test/diagnostic only — clears the entire cache. */
export function _clearCacheForTesting(): void {
    cache.clear();
}
