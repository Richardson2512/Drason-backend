/**
 * Tracking Token — HMAC-signed tokens for public email tracking endpoints.
 *
 * The open-pixel, click, and unsubscribe URLs are baked into emails sent to
 * third parties. They must be reachable without auth, but without a signature
 * an attacker who guesses a CampaignLead ID can forge traffic that inflates
 * open/click counts, flips leads to "unsubscribed", or probes for valid IDs.
 *
 * Each token binds a `leadId` (CampaignLead.id) plus optional payload (e.g.
 * the original click URL) and a `ts` issue time to an HMAC signature. The
 * signing key is derived from ENCRYPTION_KEY so we don't add new secrets.
 * Tokens older than MAX_TRACKING_AGE_MS are rejected.
 *
 * Replay protection scope: an attacker cannot forge a token for an arbitrary
 * CampaignLead ID. Legitimate recipient clients (email clients, proxies) will
 * reopen the same signed URL — that's expected and not blocked; the
 * analytics-level "once per first-reply" dedupe stays in the domain layer.
 */

import crypto from 'crypto';

const MAX_TRACKING_AGE_MS = 180 * 24 * 60 * 60 * 1000; // 180 days — matches typical sequence lifetime
const TRUNCATED_SIG_LEN = 22;                          // base64url chars → ~128 bits of entropy

let cachedKey: Buffer | null = null;

function getTrackingKey(): Buffer {
    if (cachedKey) return cachedKey;
    // Derive a dedicated key from the existing ENCRYPTION_KEY so we don't add
    // a new required env var. A separate "context" string keeps this key
    // cryptographically isolated from encryption and JWT signing.
    const source = process.env.ENCRYPTION_KEY;
    if (!source || source.length < 16) {
        throw new Error('FATAL: ENCRYPTION_KEY must be set to derive tracking signing key');
    }
    cachedKey = crypto.createHmac('sha256', source).update('superkabe:tracking:v1').digest();
    return cachedKey;
}

function toBase64Url(buf: Buffer): string {
    return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): Buffer {
    const pad = s.length % 4 === 0 ? 0 : 4 - (s.length % 4);
    const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(pad);
    return Buffer.from(b64, 'base64');
}

export interface TrackingPayload {
    /** CampaignLead.id */
    lid: string;
    /** Token issue time (epoch milliseconds) */
    ts: number;
    /** Optional — the destination URL for click tracking */
    u?: string;
}

/**
 * Produce a signed tracking token for an email URL.
 *
 * Returned format: `<base64url(payload)>.<base64url(hmac)>`
 * Both halves are URL-safe — no escaping required.
 */
export function signTrackingToken(input: { leadId: string; url?: string }): string {
    const payload: TrackingPayload = {
        lid: input.leadId,
        ts: Date.now(),
    };
    if (input.url !== undefined) payload.u = input.url;

    const body = toBase64Url(Buffer.from(JSON.stringify(payload), 'utf8'));
    const sig = toBase64Url(
        crypto.createHmac('sha256', getTrackingKey()).update(body).digest()
    ).slice(0, TRUNCATED_SIG_LEN);
    return `${body}.${sig}`;
}

/**
 * Verify a signed tracking token. Returns the decoded payload on success,
 * or null if malformed, tampered, or expired. Never throws.
 */
export function verifyTrackingToken(token: string): TrackingPayload | null {
    if (!token || typeof token !== 'string') return null;

    const dot = token.indexOf('.');
    if (dot <= 0 || dot === token.length - 1) return null;

    const body = token.slice(0, dot);
    const providedSig = token.slice(dot + 1);

    // Reject wrong-length signatures early to avoid timing-dependent work.
    if (providedSig.length !== TRUNCATED_SIG_LEN) return null;

    // Recompute expected signature and compare in constant time.
    const expectedSig = toBase64Url(
        crypto.createHmac('sha256', getTrackingKey()).update(body).digest()
    ).slice(0, TRUNCATED_SIG_LEN);

    const providedBuf = Buffer.from(providedSig, 'utf8');
    const expectedBuf = Buffer.from(expectedSig, 'utf8');
    if (providedBuf.length !== expectedBuf.length) return null;
    if (!crypto.timingSafeEqual(providedBuf, expectedBuf)) return null;

    // Signature OK — decode and validate the payload.
    let payload: TrackingPayload;
    try {
        payload = JSON.parse(fromBase64Url(body).toString('utf8'));
    } catch {
        return null;
    }
    if (!payload || typeof payload.lid !== 'string' || typeof payload.ts !== 'number') return null;
    if (payload.u !== undefined && typeof payload.u !== 'string') return null;

    // TTL check — tokens older than MAX_TRACKING_AGE_MS are rejected.
    const ageMs = Date.now() - payload.ts;
    if (ageMs < 0 || ageMs > MAX_TRACKING_AGE_MS) return null;

    return payload;
}
