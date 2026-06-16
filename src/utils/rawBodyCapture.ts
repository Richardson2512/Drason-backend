/**
 * Which inbound request paths need their RAW body captured for HMAC signature
 * verification.
 *
 * Providers (Slack, Polar, HubSpot, Clay, ...) sign the byte-exact request
 * payload. Re-stringifying req.body produces different bytes (whitespace /
 * key-order / unicode-escaping), so a recomputed HMAC never matches. The
 * body-parser `verify` hook stashes req.rawBody only for the paths this
 * predicate matches.
 *
 * This is matched by CATEGORY, not per-feature. An earlier version enumerated
 * individual prefixes and silently broke every webhook whose path wasn't on
 * the list (HubSpot webhooks + the Clay HMAC path both shipped un-listed and
 * rejected every real call, because their verifiers fell back to hashing a
 * re-stringified body). Matching the architectural category - any provider
 * webhook or ingest endpoint - means a future provider is covered
 * automatically and that class of bug cannot recur. The companion test freezes
 * this contract.
 */
export function needsRawBody(url: string): boolean {
    if (!url) return false;
    return (
        url.startsWith('/slack') ||                            // Slack events / commands / interactivity
        url.startsWith('/api/billing/') ||                     // Polar webhook + legacy alias
        url.startsWith('/api/ingest') ||                       // Clay + generic lead ingest (HMAC path)
        /^\/api\/integrations\/[^/]+\/webhooks?(?:$|[/?])/.test(url) // any provider webhook (HubSpot today)
    );
}
