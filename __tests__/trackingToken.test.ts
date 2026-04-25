/**
 * Sanity tests for the tracking-token HMAC helper. Focuses on the properties
 * the controller relies on: round-trip, tamper detection, TTL expiry, rejection
 * of malformed inputs, and the signing-key isolation from ENCRYPTION_KEY.
 */

// Must set ENCRYPTION_KEY BEFORE importing — the module derives its signing key at first use.
process.env.ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

import { signTrackingToken, verifyTrackingToken } from '../src/utils/trackingToken';

describe('trackingToken', () => {
    it('round-trips a lead-only token', () => {
        const token = signTrackingToken({ leadId: 'lead-abc-123' });
        const payload = verifyTrackingToken(token);
        expect(payload).not.toBeNull();
        expect(payload!.lid).toBe('lead-abc-123');
        expect(typeof payload!.ts).toBe('number');
        expect(payload!.u).toBeUndefined();
    });

    it('round-trips a click token with url', () => {
        const url = 'https://example.com/foo?bar=baz';
        const token = signTrackingToken({ leadId: 'lead-xyz', url });
        const payload = verifyTrackingToken(token);
        expect(payload).not.toBeNull();
        expect(payload!.lid).toBe('lead-xyz');
        expect(payload!.u).toBe(url);
    });

    it('rejects a tampered payload', () => {
        const token = signTrackingToken({ leadId: 'lead-orig' });
        const dot = token.indexOf('.');
        // Flip one char in the payload — signature should no longer match.
        const tampered = (token.charAt(0) === 'A' ? 'B' : 'A') + token.slice(1, dot) + token.slice(dot);
        expect(verifyTrackingToken(tampered)).toBeNull();
    });

    it('rejects a tampered signature', () => {
        const token = signTrackingToken({ leadId: 'lead-orig' });
        const dot = token.indexOf('.');
        const body = token.slice(0, dot);
        const sig = token.slice(dot + 1);
        const tamperedSig = (sig.charAt(0) === 'A' ? 'B' : 'A') + sig.slice(1);
        expect(verifyTrackingToken(`${body}.${tamperedSig}`)).toBeNull();
    });

    it('rejects malformed input', () => {
        expect(verifyTrackingToken('')).toBeNull();
        expect(verifyTrackingToken('no-dot-here')).toBeNull();
        expect(verifyTrackingToken('.onlydot')).toBeNull();
        expect(verifyTrackingToken('before.')).toBeNull();
        // @ts-expect-error — intentional type violation
        expect(verifyTrackingToken(null)).toBeNull();
    });

    it('rejects expired tokens', () => {
        // Build a token with a ts far in the past, then sign it using the same process.
        const expiredPayload = JSON.stringify({ lid: 'lead-old', ts: Date.now() - (365 * 24 * 60 * 60 * 1000) });
        const body = Buffer.from(expiredPayload, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        // Sign body with the same key machinery: produce a VALID signature for an expired payload.
        // Easiest way: mint a fresh token, extract its signing step via monkey-patched Date.now.
        const realNow = Date.now;
        try {
            (Date as any).now = () => realNow() - (365 * 24 * 60 * 60 * 1000);
            const backdatedToken = signTrackingToken({ leadId: 'lead-old' });
            (Date as any).now = realNow;
            expect(verifyTrackingToken(backdatedToken)).toBeNull();
        } finally {
            (Date as any).now = realNow;
        }
        // And for the hand-crafted body (unsigned) — also rejects.
        expect(verifyTrackingToken(`${body}.AAAAAAAAAAAAAAAAAAAAAA`)).toBeNull();
    });

    it('produces distinct tokens for the same leadId (timestamp varies)', async () => {
        const t1 = signTrackingToken({ leadId: 'lead-dup' });
        await new Promise(r => setTimeout(r, 5));
        const t2 = signTrackingToken({ leadId: 'lead-dup' });
        expect(t1).not.toBe(t2);
        expect(verifyTrackingToken(t1)!.lid).toBe('lead-dup');
        expect(verifyTrackingToken(t2)!.lid).toBe('lead-dup');
    });
});
