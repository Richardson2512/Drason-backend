/**
 * Safe outbound URL validator - the ONE place every customer-influenced
 * outbound URL in the backend goes for "is this destination safe to hit?".
 *
 * Pre-fix (Notifications audit N1, CRITICAL): customer-registered webhook
 * URLs were validated for shape only - a regex + a production-only http
 * reject. Nothing stopped `http://169.254.169.254/...` (cloud metadata),
 * `http://10.0.0.1:6379` (internal Redis), `http://localhost:5432`
 * (internal Postgres). An authenticated org user could create such a
 * webhook, trigger a test event, and read the response back through the
 * delivery log API. Same class of bug as the OAuth redirect_uri shape-vs-
 * destination mistake (API/MCP audit G2) - just outbound.
 *
 * Contract enforced here:
 *   1. Parseable absolute URL.
 *   2. Scheme ∈ {https, http (only when DNS-resolves to a public IP -
 *      and even then, blocked in production via existing controller-
 *      level https-only check)}.
 *   3. No userinfo (`https://user:pass@host` rejected).
 *   4. Host must NOT be in the hostname blocklist: `localhost`, `*.local`,
 *      `*.localhost`, `*.internal`, `*.cluster.local`, anything matching
 *      OUTBOUND_HOST_BLOCKLIST env (comma-separated, exact match).
 *   5. EVERY A/AAAA the hostname resolves to MUST be a public IP. Private
 *      / loopback / link-local / ULA / multicast / reserved are rejected.
 *      This is the load-bearing check - a public hostname that DNS-
 *      resolves to 10.0.0.1 still fails here, defeating DNS-rebinding
 *      and "I registered example.com which points at internal" attacks.
 *   6. Length cap so absurd inputs can't fill the DB column.
 *
 * Returns a Result type (not throwing) so call sites can map to 400 /
 * audit-log without try/catch ceremony.
 */

import { promises as dns } from 'dns';
import net from 'net';

const MAX_URL_LENGTH = 2048;

// Hostname suffixes / exact matches that should never be reached
// regardless of DNS resolution.
const FORBIDDEN_HOSTNAME_SUFFIXES = [
    '.local',
    '.localhost',
    '.internal',
    '.cluster.local',
    '.railway.internal',
    '.svc.cluster.local',
];
const FORBIDDEN_HOSTNAME_EXACTS = new Set<string>([
    'localhost',
    'metadata.google.internal',
    'metadata',          // GCP shorthand
    'metadata.aws',
]);

/** Comma-separated extra blocklist from env - lets ops add the platform's
 *  own backend hostname / known internal endpoints without a redeploy. */
function envHostBlocklist(): Set<string> {
    const raw = process.env.OUTBOUND_HOST_BLOCKLIST || '';
    return new Set(raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
}

export interface SafeOutboundUrlOk {
    ok: true;
    /** URL normalized via `new URL()` round-trip. */
    normalized: string;
    /** Resolved IPs (useful for the caller to pin DNS for the actual
     *  request, defeating DNS-rebinding between validate and fetch). */
    resolvedIps: string[];
}
export interface SafeOutboundUrlError {
    ok: false;
    code:
        | 'empty'
        | 'too_long'
        | 'unparseable'
        | 'scheme_not_allowed'
        | 'userinfo_not_allowed'
        | 'hostname_blocked'
        | 'dns_failure'
        | 'resolves_to_forbidden_ip';
    message: string;
    /** Set when code='resolves_to_forbidden_ip' - the actual IP. */
    offendingIp?: string;
}
export type SafeOutboundUrlResult = SafeOutboundUrlOk | SafeOutboundUrlError;

export interface SafeOutboundUrlOpts {
    /** Override DNS lookup - tests inject a fake resolver. */
    resolveAddrs?: (hostname: string) => Promise<string[]>;
    /** When true, treat the hostname as already an IP literal (skip DNS).
     *  Used internally by safeFetch when re-validating a redirect target. */
    skipDns?: boolean;
}

export async function validateSafeOutboundUrl(
    raw: unknown,
    opts: SafeOutboundUrlOpts = {},
): Promise<SafeOutboundUrlResult> {
    if (typeof raw !== 'string' || raw.trim().length === 0) {
        return { ok: false, code: 'empty', message: 'URL must be a non-empty string.' };
    }
    if (raw.length > MAX_URL_LENGTH) {
        return { ok: false, code: 'too_long', message: `URL exceeds ${MAX_URL_LENGTH} characters.` };
    }

    let parsed: URL;
    try {
        parsed = new URL(raw);
    } catch {
        return { ok: false, code: 'unparseable', message: 'URL must be absolute and well-formed.' };
    }

    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        return {
            ok: false,
            code: 'scheme_not_allowed',
            message: `Scheme "${parsed.protocol.replace(/:$/, '')}" is not allowed. Use http or https.`,
        };
    }

    if (parsed.username || parsed.password) {
        return {
            ok: false,
            code: 'userinfo_not_allowed',
            message: 'URL must not contain a userinfo (user:pass@) segment.',
        };
    }

    const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, ''); // strip [] for IPv6
    if (!hostname) {
        return { ok: false, code: 'unparseable', message: 'URL has no hostname.' };
    }

    // Hostname-shape blocklist
    if (FORBIDDEN_HOSTNAME_EXACTS.has(hostname)) {
        return { ok: false, code: 'hostname_blocked', message: `Hostname "${hostname}" is blocked.` };
    }
    for (const suffix of FORBIDDEN_HOSTNAME_SUFFIXES) {
        if (hostname.endsWith(suffix)) {
            return { ok: false, code: 'hostname_blocked', message: `Hostname suffix "${suffix}" is blocked.` };
        }
    }
    if (envHostBlocklist().has(hostname)) {
        return { ok: false, code: 'hostname_blocked', message: `Hostname "${hostname}" is in the platform blocklist.` };
    }

    // If the hostname is already a literal IP, we still need to range-
    // check it. Don't trust net.isIP > 0 to mean "skip" - it means
    // "skip the DNS lookup; the IP IS the resolved address."
    const ipFamily = net.isIP(hostname);
    let resolvedIps: string[];
    if (ipFamily > 0) {
        resolvedIps = [hostname];
    } else if (opts.skipDns) {
        // Caller has already resolved (redirect re-validation path).
        resolvedIps = [];
    } else {
        try {
            resolvedIps = await (opts.resolveAddrs ? opts.resolveAddrs(hostname) : resolveAllAddresses(hostname));
        } catch (err) {
            return {
                ok: false,
                code: 'dns_failure',
                message: `DNS lookup for "${hostname}" failed: ${err instanceof Error ? err.message : String(err)}`,
            };
        }
        if (resolvedIps.length === 0) {
            return { ok: false, code: 'dns_failure', message: `DNS lookup for "${hostname}" returned no addresses.` };
        }
    }

    for (const ip of resolvedIps) {
        if (isForbiddenIp(ip)) {
            return {
                ok: false,
                code: 'resolves_to_forbidden_ip',
                message: `Host "${hostname}" resolves to a forbidden IP (${ip}). External-only destinations are allowed.`,
                offendingIp: ip,
            };
        }
    }

    return { ok: true, normalized: parsed.toString(), resolvedIps };
}

async function resolveAllAddresses(hostname: string): Promise<string[]> {
    // dns.lookup() honours /etc/hosts which we don't want for SSRF -
    // it could be poisoned. dns.resolve4/resolve6 go straight to the
    // configured resolver. Use both, allow either to return.
    const [a, aaaa] = await Promise.allSettled([
        dns.resolve4(hostname),
        dns.resolve6(hostname),
    ]);
    const out: string[] = [];
    if (a.status === 'fulfilled') out.push(...a.value);
    if (aaaa.status === 'fulfilled') out.push(...aaaa.value);
    return out;
}

/**
 * The IP gatekeeper. Anything other than a public, routable address is
 * rejected. Documenting every range so a future reviewer can verify
 * coverage without digging through RFCs.
 */
export function isForbiddenIp(ip: string): boolean {
    const family = net.isIP(ip);
    if (family === 4) return isForbiddenIpv4(ip);
    if (family === 6) return isForbiddenIpv6(ip);
    // Not a parseable IP - the caller's hostname check already ran;
    // fall through as "forbidden" so we never accept ambiguity.
    return true;
}

function isForbiddenIpv4(ip: string): boolean {
    const parts = ip.split('.').map(p => parseInt(p, 10));
    if (parts.length !== 4 || parts.some(p => Number.isNaN(p) || p < 0 || p > 255)) return true;
    const [a, b] = parts;
    // 0.0.0.0/8 - "this network", current host
    if (a === 0) return true;
    // 10.0.0.0/8 - RFC 1918 private
    if (a === 10) return true;
    // 100.64.0.0/10 - RFC 6598 carrier-grade NAT (could route to internal CGNAT)
    if (a === 100 && b >= 64 && b <= 127) return true;
    // 127.0.0.0/8 - loopback
    if (a === 127) return true;
    // 169.254.0.0/16 - link-local (INCLUDES the cloud metadata services -
    // AWS 169.254.169.254, GCP 169.254.169.254, ECS task metadata
    // 169.254.170.2, Azure 169.254.169.254)
    if (a === 169 && b === 254) return true;
    // 172.16.0.0/12 - RFC 1918 private
    if (a === 172 && b >= 16 && b <= 31) return true;
    // 192.0.0.0/24 - IETF protocol assignments
    if (a === 192 && b === 0 && parts[2] === 0) return true;
    // 192.0.2.0/24 - documentation
    if (a === 192 && b === 0 && parts[2] === 2) return true;
    // 192.88.99.0/24 - 6to4 relay anycast (deprecated, still routes oddly)
    if (a === 192 && b === 88 && parts[2] === 99) return true;
    // 192.168.0.0/16 - RFC 1918 private
    if (a === 192 && b === 168) return true;
    // 198.18.0.0/15 - benchmarking
    if (a === 198 && (b === 18 || b === 19)) return true;
    // 198.51.100.0/24 - documentation
    if (a === 198 && b === 51 && parts[2] === 100) return true;
    // 203.0.113.0/24 - documentation
    if (a === 203 && b === 0 && parts[2] === 113) return true;
    // 224.0.0.0/4 - multicast
    if (a >= 224 && a <= 239) return true;
    // 240.0.0.0/4 - reserved (includes 255.255.255.255 broadcast)
    if (a >= 240) return true;
    return false;
}

function isForbiddenIpv6(ip: string): boolean {
    const lower = ip.toLowerCase();
    // ::1 loopback
    if (lower === '::1') return true;
    // :: unspecified
    if (lower === '::') return true;
    // IPv4-mapped IPv6 - WHATWG URL parser normalizes the embedded
    // IPv4 into hex form (`::ffff:10.0.0.1` → `::ffff:a00:1`), so we
    // accept BOTH the dotted and the hex form here. Recurse into the
    // IPv4 check on the embedded address.
    const dotted = lower.match(/^::ffff:([0-9.]+)$/);
    if (dotted) return isForbiddenIpv4(dotted[1]);
    const hex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex) {
        const high = parseInt(hex[1], 16);
        const low = parseInt(hex[2], 16);
        const v4 = [(high >> 8) & 0xff, high & 0xff, (low >> 8) & 0xff, low & 0xff].join('.');
        return isForbiddenIpv4(v4);
    }
    // fc00::/7 - unique-local (private)
    if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true;
    // fe80::/10 - link-local (includes IPv6 metadata variants)
    if (/^fe[89ab][0-9a-f]:/.test(lower)) return true;
    // ff00::/8 - multicast
    if (/^ff[0-9a-f]{2}:/.test(lower)) return true;
    // 2001:db8::/32 - documentation
    if (/^2001:db8:/.test(lower)) return true;
    return false;
}
