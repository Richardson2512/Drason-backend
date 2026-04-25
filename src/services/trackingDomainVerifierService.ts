/**
 * Tracking-domain verifier
 *
 * A user wires their custom tracking host (e.g. `links.clientdomain.com`)
 * with a CNAME pointing at our edge ingress (typically the same hostname
 * that resolves to our `BACKEND_URL`). Before we route any production
 * tracking traffic through it we have to verify two things:
 *
 *   1. DNS — the domain resolves and ultimately maps to one of our known
 *      tracking origins. We accept either CNAME-to-superkabe or A-record
 *      that matches our ingress IP set; in dev we also accept a
 *      .superkabe.local devhost via SUPERKABE_TRACKING_INGRESS_HOSTNAMES.
 *   2. HTTP — a HEAD against `https://<domain>/__tracking_health` returns
 *      a 200 from our actual app (verified via a known response header
 *      `X-Superkabe-Tracking: ok`). This catches the case where DNS
 *      resolves correctly but TLS/proxy isn't terminating yet.
 *
 * Verification result is persisted on `ConnectedAccount.tracking_domain_*`
 * fields. Verified rows participate in send-time URL rewriting (see
 * sendQueueService); unverified rows are silently ignored and the global
 * tracking host is used so we never emit broken links.
 */

import { promises as dns } from 'dns';
import { prisma } from '../index';
import { logger } from './observabilityService';

const ACCEPTED_INGRESS_HOSTS = (process.env.SUPERKABE_TRACKING_INGRESS_HOSTNAMES ||
    'tracking.superkabe.com,t.superkabe.com,tracking-edge.superkabe.com')
    .split(',')
    .map(h => h.trim().toLowerCase())
    .filter(Boolean);

const ACCEPTED_INGRESS_IPS = (process.env.SUPERKABE_TRACKING_INGRESS_IPS || '')
    .split(',')
    .map(ip => ip.trim())
    .filter(Boolean);

const HEALTH_PATH = '/t/__tracking_health';
const HEALTH_HEADER = 'x-superkabe-tracking';
const HEALTH_HEADER_VALUE = 'ok';
const HTTP_TIMEOUT_MS = 5000;

export interface VerificationResult {
    ok: boolean;
    /** Stable code so the UI can render specific remediation. */
    code:
        | 'verified'
        | 'no_domain_set'
        | 'dns_resolution_failed'
        | 'dns_target_not_recognized'
        | 'http_unreachable'
        | 'http_status_not_200'
        | 'http_header_missing';
    detail: string;
    cnameTarget: string | null;
    aRecords: string[];
    httpStatus?: number;
}

/**
 * Pure check — does NOT mutate the row. Used by both the verify endpoint
 * and a periodic re-checker (re-runs daily on previously-verified rows
 * to catch DNS drift).
 */
export async function checkTrackingDomain(domain: string): Promise<VerificationResult> {
    const host = domain.trim().toLowerCase();
    if (!host) {
        return { ok: false, code: 'no_domain_set', detail: 'No tracking domain configured', cnameTarget: null, aRecords: [] };
    }

    let cnameTarget: string | null = null;
    let aRecords: string[] = [];
    try {
        // CNAME first; many tracking-domain setups are CNAMEs to our ingress.
        try {
            const cnames = await dns.resolveCname(host);
            cnameTarget = cnames[0]?.toLowerCase() || null;
        } catch {
            // Not a CNAME — fall through to A-record check.
        }
        try {
            aRecords = await dns.resolve4(host);
        } catch {
            aRecords = [];
        }
    } catch (err: unknown) {
        return {
            ok: false,
            code: 'dns_resolution_failed',
            detail: `DNS lookup failed: ${(err as Error)?.message || 'unknown'}`,
            cnameTarget: null,
            aRecords: [],
        };
    }

    if (!cnameTarget && aRecords.length === 0) {
        return { ok: false, code: 'dns_resolution_failed', detail: 'Domain does not resolve via CNAME or A record', cnameTarget: null, aRecords: [] };
    }

    const cnameMatches = cnameTarget && ACCEPTED_INGRESS_HOSTS.some(h => cnameTarget!.endsWith(h));
    const aMatches = aRecords.some(ip => ACCEPTED_INGRESS_IPS.includes(ip));
    if (!cnameMatches && !aMatches) {
        return {
            ok: false,
            code: 'dns_target_not_recognized',
            detail: cnameTarget
                ? `CNAME points to "${cnameTarget}" which is not a Superkabe tracking ingress`
                : `A record(s) ${aRecords.join(', ')} are not Superkabe tracking ingress IPs`,
            cnameTarget,
            aRecords,
        };
    }

    // HTTP probe via HEAD; uses fetch with AbortController for timeout.
    const ctrl = new AbortController();
    const timeoutHandle = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
    let response: Response;
    try {
        response = await fetch(`https://${host}${HEALTH_PATH}`, { method: 'HEAD', signal: ctrl.signal });
    } catch (err: unknown) {
        return {
            ok: false,
            code: 'http_unreachable',
            detail: `HTTPS probe failed: ${(err as Error)?.message || 'unknown'}`,
            cnameTarget,
            aRecords,
        };
    } finally {
        clearTimeout(timeoutHandle);
    }

    if (response.status !== 200) {
        return {
            ok: false,
            code: 'http_status_not_200',
            detail: `Tracking endpoint returned ${response.status}; expected 200`,
            cnameTarget,
            aRecords,
            httpStatus: response.status,
        };
    }
    if (response.headers.get(HEALTH_HEADER) !== HEALTH_HEADER_VALUE) {
        return {
            ok: false,
            code: 'http_header_missing',
            detail: 'Domain serves 200 but missing X-Superkabe-Tracking header — proxy not configured correctly',
            cnameTarget,
            aRecords,
            httpStatus: response.status,
        };
    }

    return {
        ok: true,
        code: 'verified',
        detail: 'Domain resolves to Superkabe tracking ingress and HTTPS health probe succeeded',
        cnameTarget,
        aRecords,
        httpStatus: 200,
    };
}

/**
 * Idempotent verify-and-persist for a single ConnectedAccount.
 * Updates `tracking_domain_verified`, `tracking_domain_verified_at`,
 * `tracking_domain_last_check_at`, and `tracking_domain_last_error`.
 */
export async function verifyAndPersistForAccount(accountId: string): Promise<VerificationResult> {
    const account = await prisma.connectedAccount.findUnique({
        where: { id: accountId },
        select: { tracking_domain: true },
    });
    const domain = account?.tracking_domain || '';

    const result = await checkTrackingDomain(domain);
    const now = new Date();
    try {
        await prisma.connectedAccount.update({
            where: { id: accountId },
            data: {
                tracking_domain_verified: result.ok,
                tracking_domain_verified_at: result.ok ? now : null,
                tracking_domain_last_check_at: now,
                tracking_domain_last_error: result.ok ? null : `${result.code}: ${result.detail}`.slice(0, 500),
            },
        });
    } catch (err: unknown) {
        logger.error('[TRACKING-DOMAIN] Persist failed', err instanceof Error ? err : new Error(String(err)));
    }
    return result;
}
