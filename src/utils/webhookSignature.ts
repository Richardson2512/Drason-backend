/**
 * Shared HMAC-SHA256 webhook signature validation.
 *
 * Used by inbound webhook handlers (Clay ingestion, Polar billing) to verify
 * authenticity via a timing-safe HMAC comparison.
 */

import crypto from 'crypto';
import { Request } from 'express';
import { logger } from '../services/observabilityService';

/**
 * Validate an HMAC-SHA256 webhook signature.
 *
 * @param req        - Express request with body and headers
 * @param secret     - The shared HMAC secret (null if not configured)
 * @param headerNames - Header names to check for the signature
 *                      (e.g. ['x-clay-signature', 'x-webhook-signature'])
 * @returns true if the signature is valid, or if no secret is configured in non-production
 */
export function validateWebhookSignature(
    req: Request,
    secret: string | null,
    headerNames: string[]
): boolean {
    if (!secret) {
        if (process.env.NODE_ENV === 'production') {
            logger.warn('[WEBHOOK] No webhook secret configured - rejecting in production');
            return false;
        }
        return true; // Allow unsigned in development
    }

    let signature: string | undefined;
    for (const name of headerNames) {
        const val = req.headers[name];
        if (typeof val === 'string' && val) {
            signature = val;
            break;
        }
    }

    if (!signature) {
        logger.warn('[WEBHOOK] Missing signature header');
        return false;
    }

    // HMAC MUST be computed over the raw request bytes the sender signed -
    // re-stringifying req.body produces different bytes (whitespace / key-order
    // / unicode-escaping) and the signature would never match. The raw buffer
    // is captured by needsRawBody() in index.ts for all webhook/ingest paths.
    // Fail CLOSED if it's absent rather than silently hashing a re-serialized
    // body (the exact defect that had killed the HubSpot + Clay verifiers).
    const rawBody = (req as any).rawBody;
    if (!(rawBody instanceof Buffer)) {
        logger.warn('[WEBHOOK] raw body not captured - cannot verify signature (check needsRawBody() allowlist in index.ts)');
        return false;
    }

    const expectedSignature = crypto
        .createHmac('sha256', secret)
        .update(rawBody)
        .digest('hex');

    try {
        return crypto.timingSafeEqual(
            Buffer.from(signature),
            Buffer.from(expectedSignature)
        );
    } catch {
        return false; // Length mismatch
    }
}
