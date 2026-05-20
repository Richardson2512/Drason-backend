/**
 * Webhook HMAC utility tests.
 *
 * This is the single source of truth for "did this webhook actually come
 * from the integration that owns the secret, and is it not a replay?"
 * across every integration that uses HMAC (Clay today; Unipile / future
 * to migrate). A regression here is a security regression - the contract
 * is frozen below.
 */

import crypto from 'crypto';
import { verifyTimestampedHmac } from '../src/utils/webhookHmac';

const SECRET = 'test-secret-please-ignore';
const BODY = JSON.stringify({ email: 'lead@example.com', source: 'clay' });

function hex(payload: string): string {
    return crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
}

describe('verifyTimestampedHmac - missing-signature short-circuit', () => {
    it('returns missing_signature when no signature is provided', () => {
        expect(verifyTimestampedHmac({ body: BODY, signature: '', secret: SECRET }))
            .toEqual({ valid: false, reason: 'missing_signature', timestamped: false });
    });
});

describe('verifyTimestampedHmac - LEGACY body-only path (back-compat)', () => {
    it('verifies a correctly-signed body without a timestamp', () => {
        const sig = hex(BODY);
        const r = verifyTimestampedHmac({ body: BODY, signature: sig, secret: SECRET });
        expect(r).toEqual({ valid: true, timestamped: false });
    });
    it('accepts sha256= prefix (GitHub-style)', () => {
        const sig = `sha256=${hex(BODY)}`;
        expect(verifyTimestampedHmac({ body: BODY, signature: sig, secret: SECRET }).valid).toBe(true);
    });
    it('rejects a tampered body', () => {
        const sig = hex(BODY);
        const r = verifyTimestampedHmac({ body: BODY + 'x', signature: sig, secret: SECRET });
        expect(r).toEqual({ valid: false, reason: 'invalid_signature', timestamped: false });
    });
    it('rejects a wrong secret', () => {
        const sig = crypto.createHmac('sha256', 'wrong').update(BODY).digest('hex');
        expect(verifyTimestampedHmac({ body: BODY, signature: sig, secret: SECRET }).valid).toBe(false);
    });
});

describe('verifyTimestampedHmac - MODERN timestamped path (F3 fix)', () => {
    const nowSec = () => Math.floor(Date.now() / 1000);

    it('verifies signed `${timestamp}.${body}` within the window', () => {
        const ts = String(nowSec());
        const sig = hex(`${ts}.${BODY}`);
        const r = verifyTimestampedHmac({ body: BODY, signature: sig, secret: SECRET, timestamp: ts });
        expect(r).toEqual({ valid: true, timestamped: true });
    });

    it('REJECTS a request with a timestamp outside the 5-min window (replay protection)', () => {
        const ts = String(nowSec() - 60 * 60); // 1 hour old
        const sig = hex(`${ts}.${BODY}`);
        const r = verifyTimestampedHmac({ body: BODY, signature: sig, secret: SECRET, timestamp: ts });
        expect(r).toEqual({ valid: false, reason: 'stale_timestamp', timestamped: true });
    });

    it('rejects a malformed timestamp', () => {
        const r = verifyTimestampedHmac({ body: BODY, signature: 'whatever', secret: SECRET, timestamp: 'not-a-number' });
        expect(r).toEqual({ valid: false, reason: 'malformed_timestamp', timestamped: true });
    });

    it('rejects a request whose signature was computed without the timestamp prefix (would-be replay)', () => {
        const ts = String(nowSec());
        // attacker signs only the body, hoping the server ignores the timestamp
        const sig = hex(BODY);
        const r = verifyTimestampedHmac({ body: BODY, signature: sig, secret: SECRET, timestamp: ts });
        expect(r).toEqual({ valid: false, reason: 'invalid_signature', timestamped: true });
    });

    it('respects a custom skew window', () => {
        const ts = String(nowSec() - 120); // 2 min old
        const sig = hex(`${ts}.${BODY}`);
        // tight 60s window rejects
        expect(verifyTimestampedHmac({ body: BODY, signature: sig, secret: SECRET, timestamp: ts, maxClockSkewSec: 60 }))
            .toEqual({ valid: false, reason: 'stale_timestamp', timestamped: true });
        // default 5min window accepts
        expect(verifyTimestampedHmac({ body: BODY, signature: sig, secret: SECRET, timestamp: ts }))
            .toEqual({ valid: true, timestamped: true });
    });
});
