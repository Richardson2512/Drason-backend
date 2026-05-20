/**
 * Per-org rate limit middleware.
 *
 * Built specifically for credential-validation endpoints (paste API key,
 * paste OAuth tokens, /authorize launchers) where the absence of a
 * platform-side throttle becomes a credential-stuffing surface: an
 * attacker on a compromised account could iterate keys against
 * upstream providers as fast as the workspace's request budget allows
 * (F4 root). Each upstream API has its own rate limits, but the
 * platform never added its own gate.
 *
 * Implementation note (PROD CAVEAT): in-memory per process. Adequate
 * for single-instance staging and a defense-in-depth tripwire for prod;
 * a determined attacker hitting a multi-replica prod deployment can
 * still get N x maxPerWindow attempts by getting load-balanced across
 * N replicas. The proper prod-scale fix is a Redis-backed counter
 * (ioredis + INCR + EXPIRE) - swap the storage layer here without
 * touching the call sites.
 */

import type { Request, Response, NextFunction } from 'express';

interface Bucket {
    count: number;
    windowStartMs: number;
}

const buckets = new Map<string, Bucket>();
const PRUNE_INTERVAL_MS = 60_000;
let prunedAt = Date.now();

export interface RateLimitPerOrgOpts {
    /** Max requests allowed per org per window. */
    maxPerWindow: number;
    /** Window length in milliseconds. */
    windowMs: number;
    /** Optional key prefix so two different limiters (e.g. connect vs export) don't share a bucket. */
    bucketKey?: string;
}

export function rateLimitPerOrg(opts: RateLimitPerOrgOpts) {
    return (req: Request, res: Response, next: NextFunction): void => {
        const orgId = req.orgContext?.organizationId;
        // Unauthenticated requests are gated by the auth middleware before
        // they reach here; nothing to throttle on org boundary, so pass.
        if (!orgId) {
            next();
            return;
        }

        const key = `${opts.bucketKey ?? 'rl'}:${orgId}`;
        const now = Date.now();
        const cur = buckets.get(key);

        if (!cur || now - cur.windowStartMs >= opts.windowMs) {
            buckets.set(key, { count: 1, windowStartMs: now });
            // Opportunistic prune of stale buckets so the map can't grow
            // unbounded over a long-running process.
            if (now - prunedAt > PRUNE_INTERVAL_MS) {
                for (const [k, b] of buckets) {
                    if (now - b.windowStartMs > opts.windowMs * 4) buckets.delete(k);
                }
                prunedAt = now;
            }
            next();
            return;
        }

        if (cur.count >= opts.maxPerWindow) {
            const retryAfterSec = Math.max(1, Math.ceil((cur.windowStartMs + opts.windowMs - now) / 1000));
            res.setHeader('Retry-After', String(retryAfterSec));
            res.status(429).json({
                success: false,
                error: 'Too many requests. Please slow down.',
                retry_after_seconds: retryAfterSec,
            });
            return;
        }

        cur.count++;
        next();
    };
}

/**
 * Preset for integration-connect endpoints: 5 attempts per minute per
 * org. Tight enough to defeat credential-stuffing, loose enough that a
 * legitimate operator going through OAuth re-tries / "paste my API key
 * three times because I made a typo" never gets blocked.
 */
export const integrationConnectRateLimit = rateLimitPerOrg({
    maxPerWindow: 5,
    windowMs: 60_000,
    bucketKey: 'integration-connect',
});

/**
 * Preset for webhook-ops endpoints: 10 attempts per minute per org for
 * create/update/rotate, and the tighter `webhookTestRateLimit` (below)
 * for /test which fans out a real event to every active endpoint in
 * the org. Notifications audit N3: without this, an authenticated user
 * could spam endpoint creation (filling the DB) or trigger /test in a
 * loop to amplify fan-out.
 */
export const webhookOpsRateLimit = rateLimitPerOrg({
    maxPerWindow: 10,
    windowMs: 60_000,
    bucketKey: 'webhook-ops',
});

/**
 * Tighter preset for the synthetic test-event endpoint: each call fans
 * out to every active webhook in the org, so we cap at 5/min/org.
 */
export const webhookTestRateLimit = rateLimitPerOrg({
    maxPerWindow: 5,
    windowMs: 60_000,
    bucketKey: 'webhook-test',
});

/**
 * Preset for billing write endpoints (checkout / change-plan / cancel /
 * refresh-usage). Each create-checkout call hits Polar (real network
 * cost + customer-creation); refresh-usage runs two count queries
 * against multi-million-row send/validation tables. 10/min/org is
 * generous for legitimate dashboard interaction but catches loops.
 * Billing audit B2 root-cause fix.
 */
export const billingOpsRateLimit = rateLimitPerOrg({
    maxPerWindow: 10,
    windowMs: 60_000,
    bucketKey: 'billing-ops',
});

/**
 * Preset for data-export endpoints (campaign lead CSV, generateReport
 * full-org CSV, super-admin impact CSV). Each call materializes up to
 * 50k+ rows in memory before CSV serialization. 5/min/org leaves
 * headroom for "I downloaded but it had a typo, let me try again"
 * but catches the export-in-a-loop attempt.
 * Reports audit R4 root-cause fix.
 */
export const exportRateLimit = rateLimitPerOrg({
    maxPerWindow: 5,
    windowMs: 60_000,
    bucketKey: 'data-export',
});
