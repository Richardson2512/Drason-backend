/**
 * Redirect-URI validator tests - the single source of truth for "is
 * this DCR-registered redirect target safe?" across every OAuth flow.
 *
 * A regression here is the G2 (HIGH) root cause coming back: a hostile
 * DCR client registers `javascript:` / `http://attacker.example` and
 * the AS hands them the auth code. The accept/reject contract is
 * frozen below.
 */

import { validateRedirectUri, validateRedirectUriList } from '../src/utils/redirectUriValidator';

describe('validateRedirectUri - accept list', () => {
    it('accepts a plain https URL', () => {
        const r = validateRedirectUri('https://claude.ai/oauth/callback');
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.normalized).toBe('https://claude.ai/oauth/callback');
    });
    it('accepts https with port + path + query', () => {
        const r = validateRedirectUri('https://example.com:8443/cb?x=1');
        expect(r.ok).toBe(true);
    });
    it('accepts http://localhost (dev)', () => {
        expect(validateRedirectUri('http://localhost:3000/cb').ok).toBe(true);
    });
    it('accepts http://127.0.0.1 (dev)', () => {
        expect(validateRedirectUri('http://127.0.0.1:5173/cb').ok).toBe(true);
    });
});

describe('validateRedirectUri - reject list (the meat of the contract)', () => {
    it('rejects javascript: scheme', () => {
        const r = validateRedirectUri('javascript:fetch("/steal?c="+code)');
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.code).toBe('scheme_not_allowed');
    });
    it('rejects data: scheme', () => {
        expect(validateRedirectUri('data:text/html,<script>alert(1)</script>').ok).toBe(false);
    });
    it('rejects file: scheme', () => {
        expect(validateRedirectUri('file:///etc/passwd').ok).toBe(false);
    });
    it('rejects http on non-loopback host', () => {
        const r = validateRedirectUri('http://attacker.example/recv');
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.code).toBe('http_requires_loopback');
    });
    it('rejects userinfo (user:pass@host)', () => {
        const r = validateRedirectUri('https://user:pass@example.com/cb');
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.code).toBe('userinfo_not_allowed');
    });
    it('rejects a URL fragment (RFC 6749 §3.1.2)', () => {
        const r = validateRedirectUri('https://example.com/cb#injected');
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.code).toBe('fragment_not_allowed');
    });
    it('rejects an unparseable string', () => {
        expect(validateRedirectUri('not a url').ok).toBe(false);
    });
    it('rejects empty / non-string', () => {
        expect(validateRedirectUri('').ok).toBe(false);
        expect(validateRedirectUri(null).ok).toBe(false);
        expect(validateRedirectUri(undefined).ok).toBe(false);
        expect(validateRedirectUri(42).ok).toBe(false);
    });
    it('rejects absurdly long URLs', () => {
        const r = validateRedirectUri('https://example.com/' + 'a'.repeat(5000));
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.code).toBe('too_long');
    });
});

describe('validateRedirectUriList', () => {
    it('accepts a list of valid URIs and returns normalized array', () => {
        const r = validateRedirectUriList([
            'https://a.example/cb',
            'http://localhost:3000/cb',
        ]);
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.normalized).toHaveLength(2);
    });
    it('rejects with the index of the FIRST bad entry', () => {
        const r = validateRedirectUriList([
            'https://good.example/cb',
            'javascript:bad()',
            'https://also-good.example/cb',
        ]) as any;
        expect(r.ok).toBe(false);
        expect(r.index).toBe(1);
        expect(r.code).toBe('scheme_not_allowed');
    });
    it('rejects an empty array', () => {
        expect((validateRedirectUriList([]) as any).ok).toBe(false);
    });
    it('rejects a non-array', () => {
        expect((validateRedirectUriList('https://example.com/cb' as any) as any).ok).toBe(false);
    });
});
