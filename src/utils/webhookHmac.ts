/**
 * Shared webhook HMAC verification - one place every webhook handler
 * goes for signature checks so the crypto AND the replay-protection
 * policy cannot drift between integrations. Was previously rolled
 * separately in each handler (Clay accepted body-only HMAC with NO
 * timestamp - F3 root: a captured request was replayable forever).
 *
 * Modern path (recommended for every new integration): the signed
 * payload is `${timestamp}.${body}` and the timestamp must be within
 * +/- 5 min of server clock. Same pattern Stripe, GitHub, Slack use.
 *
 * Legacy path (body-only HMAC, no timestamp): still verified
 * cryptographically but flagged as `timestamped: false` so callers can
 * log a warning and migrate. We do NOT reject legacy outright - that
 * would break every Clay webhook in the field overnight.
 */

import crypto from 'crypto';

export interface VerifyHmacOpts {
    /** Raw body bytes / string exactly as received. Re-serializing parsed JSON breaks the comparison. */
    body: string;
    /** Hex- or base64-encoded HMAC-SHA256 from the signature header. */
    signature: string;
    /** Shared secret for the org / integration. */
    secret: string;
    /** When present, included in the HMAC payload as `${timestamp}.${body}` and validated within the window. */
    timestamp?: string;
    /** Max allowed clock skew in seconds (default 300 = 5 min). */
    maxClockSkewSec?: number;
}

export type VerifyHmacReason =
    | 'missing_signature'
    | 'malformed_timestamp'
    | 'stale_timestamp'
    | 'invalid_signature';

export interface VerifyHmacResult {
    valid: boolean;
    reason?: VerifyHmacReason;
    /** True when this verification went through the modern timestamped path. */
    timestamped: boolean;
}

function timingSafeStringEqual(a: string, b: string): boolean {
    const ab = Buffer.from(a, 'utf8');
    const bb = Buffer.from(b, 'utf8');
    if (ab.length !== bb.length) return false;
    try { return crypto.timingSafeEqual(ab, bb); } catch { return false; }
}

export function verifyTimestampedHmac(opts: VerifyHmacOpts): VerifyHmacResult {
    if (!opts.signature) {
        return { valid: false, reason: 'missing_signature', timestamped: false };
    }

    const timestamped = typeof opts.timestamp === 'string' && opts.timestamp.length > 0;
    const maxSkew = opts.maxClockSkewSec ?? 300;

    if (timestamped) {
        const ts = parseInt(opts.timestamp!, 10);
        if (!Number.isFinite(ts) || ts <= 0) {
            return { valid: false, reason: 'malformed_timestamp', timestamped: true };
        }
        const nowSec = Math.floor(Date.now() / 1000);
        if (Math.abs(nowSec - ts) > maxSkew) {
            return { valid: false, reason: 'stale_timestamp', timestamped: true };
        }
    }

    const payload = timestamped ? `${opts.timestamp}.${opts.body}` : opts.body;
    const digest = crypto.createHmac('sha256', opts.secret).update(payload).digest();
    const expectedHex = digest.toString('hex');
    const expectedBase64 = digest.toString('base64');
    const given = opts.signature.replace(/^sha256=/i, '').trim();

    const valid = timingSafeStringEqual(given, expectedHex) || timingSafeStringEqual(given, expectedBase64);
    return { valid, reason: valid ? undefined : 'invalid_signature', timestamped };
}
