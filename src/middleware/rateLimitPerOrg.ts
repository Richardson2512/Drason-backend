/**
 * Per-org rate limit middleware (Redis-backed).
 *
 * Built for credential-validation + abuse-prone endpoints (paste API key,
 * paste OAuth tokens, /authorize launchers, webhook test fan-out, expensive
 * exports / assessments, billing writes) where the absence of a platform-side
 * throttle is a credential-stuffing / amplification / cost-abuse surface (audit
 * F4 / N3 / B2 / R4 / SP roots). Each upstream API has its own limits, but the
 * platform never added its own gate.
 *
 * Redis-backed (not in-memory) because prod runs multiple replicas: an
 * in-process Map would let an attacker get N x maxPerWindow attempts by being
 * load-balanced across N replicas. A shared Redis counter (atomic INCR+PEXPIRE
 * via a tiny Lua script, keyed by org + fixed window) enforces one budget
 * across the whole fleet.
 *
 * FAIL-OPEN: if Redis is unconfigured or unreachable, the middleware passes the
 * request through rather than blocking legitimate traffic. Availability beats
 * defense-in-depth here - the upstream provider limits still apply, and a
 * Redis outage must not take down the product. Errors are swallowed to next().
 */

import type { Request, Response, NextFunction } from 'express';
import { getRedisClient } from '../utils/redis';
import { logger } from '../services/observabilityService';

// Atomic: increment the window counter and, only on the first hit, set its TTL.
// Keeping both in one round-trip (and one script) removes the incr-then-expire
// race that could orphan a key without a TTL.
const INCR_WITH_TTL = `
local c = redis.call('INCR', KEYS[1])
if c == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return c
`;

export interface RateLimitPerOrgOpts {
    /** Max requests allowed per org per window. */
    maxPerWindow: number;
    /** Window length in milliseconds. */
    windowMs: number;
    /** Key prefix so two limiters (e.g. connect vs export) don't share a bucket. */
    bucketKey: string;
}

export function rateLimitPerOrg(opts: RateLimitPerOrgOpts) {
    return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        const orgId = req.orgContext?.organizationId;
        // Unauthenticated / no-org requests are gated by auth middleware before
        // they reach here; nothing to throttle on the org boundary, so pass.
        if (!orgId) {
            next();
            return;
        }

        const redis = getRedisClient();
        if (!redis) {
            // No Redis configured - fail open (see file header).
            next();
            return;
        }

        const now = Date.now();
        const windowIndex = Math.floor(now / opts.windowMs);
        const key = `ratelimit:${opts.bucketKey}:${orgId}:${windowIndex}`;

        let count: number;
        try {
            const raw = await redis.eval(INCR_WITH_TTL, 1, key, String(opts.windowMs));
            count = Number(raw);
        } catch (err) {
            // Redis unreachable mid-request - fail open, never block on infra.
            logger.debug('[RATE_LIMIT] Redis error - failing open', {
                bucketKey: opts.bucketKey,
                err: err instanceof Error ? err.message : String(err),
            });
            next();
            return;
        }

        if (count > opts.maxPerWindow) {
            const windowEndMs = (windowIndex + 1) * opts.windowMs;
            const retryAfterSec = Math.max(1, Math.ceil((windowEndMs - now) / 1000));
            res.setHeader('Retry-After', String(retryAfterSec));
            res.status(429).json({
                success: false,
                error: 'Too many requests. Please slow down.',
                retry_after_seconds: retryAfterSec,
            });
            return;
        }

        next();
    };
}

/**
 * Integration-connect endpoints: 5/min/org. Tight enough to defeat credential
 * stuffing, loose enough that an operator re-trying OAuth or re-pasting an API
 * key after a typo never gets blocked (F4 root).
 */
export const integrationConnectRateLimit = rateLimitPerOrg({
    maxPerWindow: 5,
    windowMs: 60_000,
    bucketKey: 'integration-connect',
});

/**
 * Webhook create/update/rotate/delete/replay: 10/min/org. Without it an
 * authenticated user could spam endpoint creation (filling the DB) (N3).
 */
export const webhookOpsRateLimit = rateLimitPerOrg({
    maxPerWindow: 10,
    windowMs: 60_000,
    bucketKey: 'webhook-ops',
});

/**
 * Synthetic test-event endpoint: 5/min/org. Each call fans out a real event to
 * every active endpoint in the org, so it gets the tighter cap (N3).
 */
export const webhookTestRateLimit = rateLimitPerOrg({
    maxPerWindow: 5,
    windowMs: 60_000,
    bucketKey: 'webhook-test',
});

/**
 * Billing write endpoints (checkout / change-plan / cancel / refresh-usage):
 * 10/min/org. create-checkout hits Polar (network + customer creation);
 * refresh-usage runs heavy count queries. Generous for the dashboard, catches
 * loops (B2 root).
 */
export const billingOpsRateLimit = rateLimitPerOrg({
    maxPerWindow: 10,
    windowMs: 60_000,
    bucketKey: 'billing-ops',
});

/**
 * Data-export endpoints (campaign lead CSV, report CSV, admin impact CSV):
 * 5/min/org. Each materializes up to 50k+ rows in memory before serialization
 * (R4 root).
 */
export const exportRateLimit = rateLimitPerOrg({
    maxPerWindow: 5,
    windowMs: 60_000,
    bucketKey: 'data-export',
});

/**
 * Protection-critical config flips (campaign pause/resume, mailbox/domain
 * resume, healing acknowledge): 3/min/org. These rarely change legitimately -
 * a rate above 3/min is a script, not a person (SP root).
 */
export const protectionConfigRateLimit = rateLimitPerOrg({
    maxPerWindow: 3,
    windowMs: 60_000,
    bucketKey: 'protection-config',
});

/**
 * Assessment-trigger endpoints (POST /assessment/run, per-domain DNS recheck):
 * 5/min/org. These run expensive DNS + DNSBL fan-out; a retry loop or a
 * compromised credential could DOS the resolver pool and burn DNSBL quota
 * (R2-SP2 root).
 */
export const assessmentRateLimit = rateLimitPerOrg({
    maxPerWindow: 5,
    windowMs: 60_000,
    bucketKey: 'assessment-run',
});
