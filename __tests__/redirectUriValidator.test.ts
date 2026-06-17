/**
 * Locks the OAuth redirect_uri validation contract (API/MCP audit G2). The
 * DCR /register path now validates caller-supplied redirect_uris before
 * persisting, closing an open-redirect-into-auth-code-theft vector. Legit MCP
 * clients (Claude.ai https, local http://localhost) must pass; dangerous
 * schemes / non-loopback http / userinfo / fragments must be rejected.
 */

import { validateRedirectUri, validateRedirectUriList } from '../src/utils/redirectUriValidator';

describe('validateRedirectUri', () => {
    it('accepts https redirect URIs (real MCP clients)', () => {
        expect(validateRedirectUri('https://claude.ai/api/mcp/auth_callback').ok).toBe(true);
    });

    it('accepts http only for loopback hosts', () => {
        expect(validateRedirectUri('http://localhost:3000/cb').ok).toBe(true);
        expect(validateRedirectUri('http://127.0.0.1/cb').ok).toBe(true);
        const r = validateRedirectUri('http://attacker.example/cb');
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.code).toBe('http_requires_loopback');
    });

    it('rejects dangerous schemes', () => {
        expect(validateRedirectUri('javascript:fetch("/x")').ok).toBe(false);
        expect(validateRedirectUri('data:text/html,x').ok).toBe(false);
        expect(validateRedirectUri('file:///etc/passwd').ok).toBe(false);
    });

    it('rejects userinfo and fragments', () => {
        const u = validateRedirectUri('https://user:pass@host/cb');
        expect(u.ok).toBe(false);
        if (!u.ok) expect(u.code).toBe('userinfo_not_allowed');
        const f = validateRedirectUri('https://host/cb#frag');
        expect(f.ok).toBe(false);
        if (!f.ok) expect(f.code).toBe('fragment_not_allowed');
    });

    it('rejects empty and non-absolute URIs', () => {
        expect(validateRedirectUri('').ok).toBe(false);
        expect(validateRedirectUri('/relative/path').ok).toBe(false);
    });
});

describe('validateRedirectUriList', () => {
    it('requires a non-empty array', () => {
        expect(validateRedirectUriList([]).ok).toBe(false);
        expect(validateRedirectUriList('not-an-array' as any).ok).toBe(false);
    });

    it('returns the first failure with its index', () => {
        const r = validateRedirectUriList(['https://ok.example/cb', 'javascript:bad']);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.index).toBe(1);
    });

    it('normalizes a valid list', () => {
        const r = validateRedirectUriList(['https://claude.ai/cb']);
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.normalized).toEqual(['https://claude.ai/cb']);
    });
});
