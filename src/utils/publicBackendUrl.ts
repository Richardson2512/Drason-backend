/**
 * Resolve the public-facing backend URL — what customers, Polar, Google,
 * Microsoft, Slack, Clay, etc. should see as our origin.
 *
 * Resolution order:
 *   1. PUBLIC_BACKEND_URL — explicit override, always wins.
 *   2. BACKEND_URL — only if NOT a Railway-internal hostname
 *      (`*.up.railway.app` / `*.railway.internal`). Railway-internal
 *      hostnames pass our healthchecks but are NOT what customers should
 *      see in dashboard URLs, OAuth redirect_uris, tracking pixels, or
 *      webhook URLs we hand to third-party services. Handing a third
 *      party a `*.up.railway.app` URL produces "redirect_uri_mismatch"
 *      from Google, "invalid origin" from various webhook providers, and
 *      a confused-looking customer dashboard.
 *   3. https://api.superkabe.com hardcoded fallback for production.
 *   4. http://localhost:<PORT> for development.
 *
 * Strips trailing slashes — every caller does `${url}/api/...` and a
 * stray `//` produces a redirect_uri / webhook URL that won't match
 * what was registered upstream (exact-string matching is the rule).
 */
export function getPublicBackendUrl(): string {
    const isRailwayInternal = (raw: string): boolean => {
        try {
            const u = new URL(raw);
            return u.hostname.endsWith('.up.railway.app') || u.hostname.endsWith('.railway.internal');
        } catch {
            return false;
        }
    };

    const candidates = [process.env.PUBLIC_BACKEND_URL, process.env.BACKEND_URL];
    for (const raw of candidates) {
        if (!raw) continue;
        const trimmed = raw.replace(/\/+$/, '');
        if (!trimmed) continue;
        if (process.env.NODE_ENV === 'production' && isRailwayInternal(trimmed)) {
            console.warn(`[BACKEND_URL] "${raw}" is a Railway-internal hostname — skipping for public URLs`);
            continue;
        }
        return trimmed;
    }
    return process.env.NODE_ENV === 'production'
        ? 'https://api.superkabe.com'
        : `http://localhost:${process.env.PORT || 4000}`;
}
