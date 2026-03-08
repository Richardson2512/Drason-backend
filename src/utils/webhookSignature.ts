/**
 * Shared HMAC-SHA256 webhook signature validation.
 *
 * Used by all webhook controllers (Smartlead, EmailBison, Instantly) to verify
 * inbound webhook authenticity via a timing-safe HMAC comparison.
 */

import crypto from 'crypto';
import { Request } from 'express';
import { logger } from '../services/observabilityService';

/**
 * Validate an HMAC-SHA256 webhook signature.
 *
 * @param req        - Express request with body and headers
 * @param secret     - The shared HMAC secret (null if not configured)
 * @param headerNames - Platform-specific header names to check for the signature
 *                      (e.g. ['x-smartlead-signature', 'x-webhook-signature'])
 * @returns true if the signature is valid, or if no secret is configured in non-production
 */
export function validateWebhookSignature(
    req: Request,
    secret: string | null,
    headerNames: string[]
): boolean {
    if (!secret) {
        if (process.env.NODE_ENV === 'production') {
            logger.warn('[WEBHOOK] No webhook secret configured — rejecting in production');
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

    const expectedSignature = crypto
        .createHmac('sha256', secret)
        .update(JSON.stringify(req.body))
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
