/**
 * Safe outbound fetch - the ONE place every customer-influenced HTTP
 * destination in the backend is reached.
 *
 * Wraps the native `fetch()` with three protections the raw API does
 * not give you:
 *
 *   1. PRE-FETCH URL VALIDATION. Calls `validateSafeOutboundUrl` (which
 *      resolves DNS and rejects private/loopback/link-local IPs) right
 *      before issuing the request. Closes the time-of-check / time-of-
 *      use window between "validated at create time" and "fetched
 *      hours later when the attacker's DNS now points at 10.0.0.1."
 *
 *   2. MANUAL REDIRECT FOLLOWING WITH RE-VALIDATION ON EACH HOP.
 *      Default fetch follows up to 20 redirects automatically; an
 *      attacker registers `https://attacker.example/back` which 302s
 *      to `http://169.254.169.254/...`, defeating any one-shot
 *      validation. We set `redirect: 'manual'`, capture the `Location`
 *      header on 3xx, validate it through the same pipeline, and only
 *      then re-issue. Max hops capped.
 *
 *   3. STREAM-BOUNDED RESPONSE READ. Default fetch + .text() reads the
 *      ENTIRE body before any size check. A malicious responder could
 *      send a 1 GB response and OOM the worker, OR send a 4 KB-and-1-
 *      byte response specifically to leak the bytes that get truncated.
 *      We pump the response body chunk-by-chunk through a counter and
 *      abort the read once `maxBytes` is reached. Sets `truncated: true`
 *      so the caller can record the fact in the delivery log.
 *
 * Audit trail: Notifications audit N1 (CRITICAL SSRF) + N4 (redirect
 * follow defeats URL check) + N5 (unbounded response read) all collapse
 * to this single wrapper.
 */

import { validateSafeOutboundUrl, type SafeOutboundUrlResult } from './safeOutboundUrl';
import { logger } from '../services/observabilityService';

export interface SafeFetchOpts {
    method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    headers?: Record<string, string>;
    /** Request body. Strings are passed through verbatim - the one
     *  current caller (webhook dispatcher) already JSON.stringifies. */
    body?: string;
    /** Total request timeout including redirects. Defaults to 15 seconds. */
    timeoutMs?: number;
    /** Maximum bytes to read from the response body. Default 64 KB. */
    maxBytes?: number;
    /** Maximum redirects to follow (each one re-validated). Default 3. */
    maxRedirects?: number;
}

export interface SafeFetchSuccess {
    ok: true;
    status: number;
    statusText: string;
    /** Lowercased header names. */
    headers: Record<string, string>;
    /** Decoded as UTF-8. May be truncated; check `truncated`. */
    body: string;
    /** True when the response body exceeded `maxBytes` and we cut it off. */
    truncated: boolean;
    /** Final URL after redirect chain. */
    finalUrl: string;
}
export interface SafeFetchFailure {
    ok: false;
    /** Categorised so the caller can drive UI + audit-log behaviour. */
    reason:
        | 'url_blocked'           // pre-fetch validator rejected
        | 'redirect_blocked'      // 3xx target failed re-validation
        | 'too_many_redirects'
        | 'timeout'
        | 'network_error';
    message: string;
    /** Set when reason='url_blocked' or 'redirect_blocked'. */
    validationError?: Extract<SafeFetchFailureValidation, { ok: false }>;
}
type SafeFetchFailureValidation = SafeOutboundUrlResult;
export type SafeFetchResult = SafeFetchSuccess | SafeFetchFailure;

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 64 * 1024;
const DEFAULT_MAX_REDIRECTS = 3;

export async function safeFetch(rawUrl: string, opts: SafeFetchOpts = {}): Promise<SafeFetchResult> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;

    const abortController = new AbortController();
    const overallTimer = setTimeout(() => abortController.abort('overall_timeout'), timeoutMs);

    try {
        let currentUrl = rawUrl;
        for (let hop = 0; hop <= maxRedirects; hop++) {
            // Validate (with DNS resolution) before EVERY hop. This is the
            // load-bearing line: a 302 to a forbidden destination dies here.
            const validation = await validateSafeOutboundUrl(currentUrl);
            if (!validation.ok) {
                return {
                    ok: false,
                    reason: hop === 0 ? 'url_blocked' : 'redirect_blocked',
                    message: validation.message,
                    validationError: validation,
                };
            }

            let res: Response;
            try {
                res = await fetch(validation.normalized, {
                    method: opts.method ?? 'POST',
                    headers: opts.headers,
                    body: opts.body,
                    redirect: 'manual',
                    signal: abortController.signal,
                });
            } catch (err) {
                if (err instanceof Error && (err.name === 'AbortError' || /aborted/i.test(err.message))) {
                    return { ok: false, reason: 'timeout', message: `Request aborted after ${timeoutMs}ms` };
                }
                return {
                    ok: false,
                    reason: 'network_error',
                    message: err instanceof Error ? err.message : String(err),
                };
            }

            // Manual redirect handling. fetch() with redirect:'manual'
            // returns res.status in 3xx with res.type === 'opaqueredirect'
            // in browsers, but in undici (Node) the status + Location
            // header are visible directly.
            if (res.status >= 300 && res.status < 400) {
                const location = res.headers.get('location');
                if (!location) {
                    // 3xx with no Location - treat as terminal and return what we have.
                    return await readResponse(res, maxBytes, validation.normalized);
                }
                // Resolve relative redirects against the current URL.
                try {
                    currentUrl = new URL(location, validation.normalized).toString();
                } catch {
                    return { ok: false, reason: 'redirect_blocked', message: `Redirect Location is not a valid URL: ${location}` };
                }
                continue; // re-validate + re-issue
            }

            return await readResponse(res, maxBytes, validation.normalized);
        }

        return { ok: false, reason: 'too_many_redirects', message: `Exceeded ${maxRedirects} redirects` };
    } finally {
        clearTimeout(overallTimer);
    }
}

async function readResponse(res: Response, maxBytes: number, finalUrl: string): Promise<SafeFetchSuccess> {
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });

    let body = '';
    let truncated = false;
    const reader = res.body?.getReader();
    if (reader) {
        const decoder = new TextDecoder('utf-8', { fatal: false });
        let total = 0;
        try {
            // eslint-disable-next-line no-constant-condition
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                total += value.length;
                if (total > maxBytes) {
                    // Take just the prefix that fits, mark truncated, abort the rest.
                    const overshoot = total - maxBytes;
                    const keepLen = Math.max(0, value.length - overshoot);
                    body += decoder.decode(value.subarray(0, keepLen), { stream: false });
                    truncated = true;
                    try { await reader.cancel('safefetch_max_bytes'); } catch { /* ignore */ }
                    break;
                }
                body += decoder.decode(value, { stream: true });
            }
            if (!truncated) body += decoder.decode();
        } catch (err) {
            // Mid-stream read failure - return what we have, mark as
            // truncated since the body is incomplete.
            logger.debug('[SAFE_FETCH] stream read interrupted', {
                err: err instanceof Error ? err.message : String(err),
            });
            truncated = true;
        }
    }

    return {
        ok: true,
        status: res.status,
        statusText: res.statusText,
        headers,
        body,
        truncated,
        finalUrl,
    };
}
