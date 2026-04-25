/**
 * Outbound webhook signing — HMAC-SHA256.
 *
 * Stripe-compatible scheme. Receivers verify by:
 *   1. Reading `X-Superkabe-Signature: t=<unix_ts>,v1=<hex>`
 *   2. Recomputing HMAC-SHA256 of `${t}.${rawBody}` with the endpoint secret
 *   3. Timing-safe comparing the recomputed hex to v1
 *   4. Rejecting events older than 5 minutes (t < now-300s)
 *
 * The replay window is enforced by the receiver, not us — we just stamp `t`.
 */

import crypto from 'crypto';

const SIG_SCHEME_VERSION = 'v1';

export interface SignedRequest {
    /** Header value to attach as X-Superkabe-Signature. */
    signatureHeader: string;
    /** Unix-seconds timestamp embedded in the signature (also returned for logging). */
    timestamp: number;
}

/**
 * Build the signature header for a payload bound for a customer endpoint.
 *
 * @param rawBody   Stringified JSON body, byte-identical to what we POST.
 * @param secret    Endpoint's secret (stored in WebhookEndpoint.secret).
 * @param now       Optional override for unit tests.
 */
export function signWebhookPayload(
    rawBody: string,
    secret: string,
    now: Date = new Date()
): SignedRequest {
    const timestamp = Math.floor(now.getTime() / 1000);
    const signedPayload = `${timestamp}.${rawBody}`;
    const hmac = crypto
        .createHmac('sha256', secret)
        .update(signedPayload)
        .digest('hex');
    return {
        signatureHeader: `t=${timestamp},${SIG_SCHEME_VERSION}=${hmac}`,
        timestamp,
    };
}

/**
 * Generate a cryptographically random secret to hand a customer when they
 * create a new endpoint. Shown ONCE on creation; we store the raw value (it
 * needs to be readable for re-signing, unlike a password). 32 bytes = 256
 * bits of entropy, encoded as base64url for clean copy/paste.
 */
export function generateEndpointSecret(): string {
    return `whsec_${crypto.randomBytes(32).toString('base64url')}`;
}
