/**
 * OAuth redirect_uri validator - the ONE place every dynamic client
 * registration / consent flow checks the shape of a caller-supplied
 * redirect target.
 *
 * Pre-fix (API/MCP audit, G2): SuperkabeClientsStore.registerClient
 * accepted whatever `redirect_uris: string[]` came in on the DCR
 * request and persisted it verbatim. That meant a hostile DCR client
 * could register a redirect like `javascript:fetch(...)` or
 * `http://attacker.example/recv` and on consent approval the server
 * would happily hand back the auth code via that URI. With PKCE
 * verifier in the attacker's hands (they started the flow), the code
 * exchanges into a usable access token - classic open-redirect into
 * auth-code theft.
 *
 * Contract enforced here:
 *   1. Parseable absolute URL (new URL() succeeds with no relative base)
 *   2. Scheme ∈ {https, http (localhost-only)}. js/data/file/blob/etc rejected.
 *   3. No userinfo segment (`https://user:pass@host` rejected).
 *   4. No URL fragment (RFC 6749 §3.1.2 - the AS appends params to the
 *      redirect; a pre-supplied fragment subverts that).
 *   5. In production NODE_ENV, plain `http` is allowed ONLY when the
 *      host resolves to a loopback address (localhost / 127.0.0.1 / ::1).
 *      Everything else must be https.
 *   6. Length cap to defeat absurdly-long inputs that fill the DB.
 *
 * Returning a Result type (not throwing) keeps the validator callable
 * from both controllers (which want to map to 400) and tests.
 */

const MAX_REDIRECT_URI_LENGTH = 2048;

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export interface RedirectUriValidationOk {
    ok: true;
    /** The URI normalized via `URL` round-trip (trailing-slash quirks, etc.). */
    normalized: string;
}
export interface RedirectUriValidationError {
    ok: false;
    /** Stable, programmatic reason - safe to log + return to caller. */
    code:
        | 'empty'
        | 'too_long'
        | 'unparseable'
        | 'scheme_not_allowed'
        | 'http_requires_loopback'
        | 'userinfo_not_allowed'
        | 'fragment_not_allowed';
    /** Human-readable explanation; safe to surface to the OAuth client. */
    message: string;
}
export type RedirectUriValidation = RedirectUriValidationOk | RedirectUriValidationError;

export function validateRedirectUri(raw: unknown): RedirectUriValidation {
    if (typeof raw !== 'string' || raw.trim().length === 0) {
        return { ok: false, code: 'empty', message: 'redirect_uri must be a non-empty string.' };
    }
    if (raw.length > MAX_REDIRECT_URI_LENGTH) {
        return { ok: false, code: 'too_long', message: `redirect_uri exceeds ${MAX_REDIRECT_URI_LENGTH} characters.` };
    }

    let parsed: URL;
    try {
        parsed = new URL(raw);
    } catch {
        return { ok: false, code: 'unparseable', message: 'redirect_uri must be an absolute URL.' };
    }

    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        return {
            ok: false,
            code: 'scheme_not_allowed',
            message: `redirect_uri scheme "${parsed.protocol.replace(/:$/, '')}" is not allowed. Use https (or http for localhost only).`,
        };
    }

    if (parsed.username || parsed.password) {
        return {
            ok: false,
            code: 'userinfo_not_allowed',
            message: 'redirect_uri must not contain a userinfo (user:pass@) segment.',
        };
    }

    if (parsed.hash && parsed.hash !== '') {
        return {
            ok: false,
            code: 'fragment_not_allowed',
            message: 'redirect_uri must not contain a fragment (RFC 6749 §3.1.2).',
        };
    }

    if (parsed.protocol === 'http:') {
        const host = parsed.hostname.toLowerCase();
        if (!LOOPBACK_HOSTS.has(host)) {
            return {
                ok: false,
                code: 'http_requires_loopback',
                message: 'redirect_uri may only use http:// when the host is loopback (localhost / 127.0.0.1 / ::1). Use https for any other host.',
            };
        }
    }

    return { ok: true, normalized: parsed.toString() };
}

/**
 * Validate a list of redirect URIs. Used by DCR /register which accepts
 * an array. Returns ok with the normalized list, or the FIRST failure
 * (so the client can fix one issue at a time and the error message
 * stays specific).
 */
export function validateRedirectUriList(
    raw: unknown
): { ok: true; normalized: string[] } | (RedirectUriValidationError & { index: number }) {
    if (!Array.isArray(raw) || raw.length === 0) {
        return { ok: false, code: 'empty', message: 'redirect_uris must be a non-empty array.', index: -1 };
    }
    const normalized: string[] = [];
    for (let i = 0; i < raw.length; i++) {
        const r = validateRedirectUri(raw[i]);
        if (!r.ok) return { ...r, index: i };
        normalized.push(r.normalized);
    }
    return { ok: true, normalized };
}
