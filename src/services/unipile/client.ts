/**
 * Unipile REST client - single canonical wrapper for the Unipile LinkedIn
 * API. All Super LinkedIn modules go through this client so retry/throttle/
 * auth behavior is consistent.
 *
 * Unipile exposes:
 *   - REST endpoints under https://api{N}.unipile.com:13111/api/v1
 *     (the cluster digit is workspace-specific and returned at signup)
 *   - Webhook POSTs to our endpoint (HMAC-signed, see verifyWebhook)
 *
 * Documentation lives at https://developer.unipile.com/reference.
 *
 * Configuration (env):
 *   UNIPILE_API_BASE_URL - full base URL incl. port and /api/v1 prefix
 *   UNIPILE_API_KEY      - workspace API key (X-API-KEY header)
 *   UNIPILE_WEBHOOK_SECRET - HMAC secret for inbound webhook verification
 *
 * Design parallels the existing kimiClient/geminiClient: stub mode when
 * UNIPILE_API_KEY is unset, retry on transient failures, FIFO-queued
 * concurrency cap so we don't trip Unipile's own rate guards.
 */

import crypto from 'crypto';
import { logger } from '../observabilityService';

// ────────────────────────────────────────────────────────────────────
// Configuration
// ────────────────────────────────────────────────────────────────────

const BASE_URL = process.env.UNIPILE_API_BASE_URL || '';

export function isUnipileConfigured(): boolean {
    return Boolean(process.env.UNIPILE_API_KEY && BASE_URL);
}

// ────────────────────────────────────────────────────────────────────
// Semaphore - Unipile pre-rate-limits requests before they reach
// LinkedIn. Staying under their cap prevents request queuing latency.
// ────────────────────────────────────────────────────────────────────

const MAX_CONCURRENT = parseInt(process.env.UNIPILE_MAX_CONCURRENT || '10', 10);
let inFlight = 0;
const waitQueue: Array<() => void> = [];

function acquireSlot(): Promise<() => void> {
    return new Promise(resolve => {
        const grant = () => {
            inFlight += 1;
            const release = () => {
                inFlight -= 1;
                const next = waitQueue.shift();
                if (next) next();
            };
            resolve(release);
        };
        if (inFlight < MAX_CONCURRENT) grant();
        else waitQueue.push(grant);
    });
}

export function getUnipileStats() {
    return { inFlight, waiting: waitQueue.length, maxConcurrent: MAX_CONCURRENT };
}

// ────────────────────────────────────────────────────────────────────
// Retry helper - matches the kimi/gemini client pattern
// ────────────────────────────────────────────────────────────────────

import { recordUnipile429 } from './rateLimitTracker';

const RETRY_DELAYS_MS = [1_500, 3_000, 6_000];
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

function isRetryable(err: unknown): boolean {
    const e = err as { status?: number; message?: string };
    if (typeof e?.status === 'number' && RETRYABLE_STATUSES.has(e.status)) return true;
    const msg = (e?.message || '').toLowerCase();
    if (msg.includes('econnreset') || msg.includes('etimedout') || msg.includes('socket hang up')) return true;
    if (msg.includes('connection error') || msg.includes('timeout')) return true;
    return false;
}

function jitter(baseMs: number): number {
    const factor = 0.75 + Math.random() * 0.5;
    return Math.round(baseMs * factor);
}

// ────────────────────────────────────────────────────────────────────
// HTTP error class - preserved through retries so callers can introspect
// ────────────────────────────────────────────────────────────────────

export class UnipileHttpError extends Error {
    constructor(
        public status: number,
        public path: string,
        public body: unknown,
        msg: string,
    ) {
        super(msg);
        this.name = 'UnipileHttpError';
    }
}

// ────────────────────────────────────────────────────────────────────
// Request primitive - direct fetch (no axios dep) with retry + semaphore
// ────────────────────────────────────────────────────────────────────

export interface UnipileRequest {
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    path: string;
    query?: Record<string, string | number | boolean | undefined>;
    body?: unknown;
    /** Logging tag for retry warnings. */
    tag?: string;
    /** LinkedInAccount.id this call is scoped to. When set, 429 responses
     *  feed the per-account rate-limit tracker so the UI can surface a
     *  throttling banner without us having to parse the URL. */
    accountId?: string;
}

export async function unipileRequest<T = unknown>(req: UnipileRequest): Promise<T> {
    if (!isUnipileConfigured()) {
        logger.info('[UNIPILE] Stub mode - returning empty result', { tag: req.tag, path: req.path });
        return {} as T;
    }

    const release = await acquireSlot();
    try {
        let lastError: unknown = null;
        for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
            try {
                return await callUnipile<T>(req);
            } catch (err) {
                lastError = err;
                const e = err as { status?: number; message?: string };
                // Record every 429 we observe - even on the terminal
                // attempt where we're about to give up - so the operator
                // sees the throttling in the UI banner.
                if (e?.status === 429 && req.accountId) {
                    recordUnipile429(req.accountId);
                }
                if (!isRetryable(err) || attempt === RETRY_DELAYS_MS.length) throw err;
                const wait = jitter(RETRY_DELAYS_MS[attempt]);
                logger.warn('[UNIPILE] Retryable failure - backing off', {
                    tag: req.tag,
                    path: req.path,
                    attempt: attempt + 1,
                    of: RETRY_DELAYS_MS.length + 1,
                    waitMs: wait,
                    status: e?.status,
                    msg: (e?.message || '').slice(0, 200),
                });
                await new Promise(resolve => setTimeout(resolve, wait));
            }
        }
        throw lastError;
    } finally {
        release();
    }
}

async function callUnipile<T>(req: UnipileRequest): Promise<T> {
    const url = buildUrl(req.path, req.query);
    const init: RequestInit = {
        method: req.method,
        headers: {
            'X-API-KEY': process.env.UNIPILE_API_KEY as string,
            'Accept': 'application/json',
            ...(req.body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(req.body ? { body: JSON.stringify(req.body) } : {}),
    };

    const res = await fetch(url, init);
    const text = await res.text();
    let parsed: unknown = null;
    if (text) {
        try { parsed = JSON.parse(text); } catch { parsed = text; }
    }

    if (!res.ok) {
        throw new UnipileHttpError(
            res.status,
            req.path,
            parsed,
            `[UNIPILE] ${req.method} ${req.path} → ${res.status}`,
        );
    }
    return parsed as T;
}

function buildUrl(path: string, query?: UnipileRequest['query']): string {
    const base = BASE_URL.endsWith('/') ? BASE_URL.slice(0, -1) : BASE_URL;
    const cleanPath = path.startsWith('/') ? path : `/${path}`;
    if (!query) return base + cleanPath;
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null) params.set(k, String(v));
    }
    const qs = params.toString();
    return qs ? `${base}${cleanPath}?${qs}` : base + cleanPath;
}

// ────────────────────────────────────────────────────────────────────
// Webhook signature verification
//
// Unipile signs each webhook POST with HMAC-SHA256 of the raw body using
// the shared secret. The signature is sent as an `x-unipile-signature`
// header (hex-encoded). Verification MUST happen on the raw body bytes -
// re-serializing parsed JSON breaks the comparison.
// ────────────────────────────────────────────────────────────────────

/**
 * Header names Unipile (or any reasonable webhook system) may carry the
 * HMAC signature in. Multiple are accepted because Unipile's public docs
 * say only "a signature header" without naming it - the first non-empty
 * candidate that matches our computation passes verification.
 */
const SIGNATURE_HEADER_CANDIDATES = [
    'x-unipile-signature',
    'x-unipile-signature-256',
    'x-webhook-signature',
    'x-webhook-signature-256',
    'webhook-signature',
];

/**
 * HMAC-SHA256 verifier for Unipile webhooks.
 *
 * Accepts either a single header string (back-compat) or the full headers
 * bag - when the latter, every known signature-header name is tried.
 *
 * Encoding-tolerant: real signatures from major webhook providers use
 * either hex or base64. We compute both and accept whichever matches.
 * Also strips the common `sha256=` prefix some providers (GitHub-style)
 * include before the digest.
 *
 * SHA-256 is the algorithm assumption - the only widely-used HMAC variant
 * for webhooks in 2025+. If Unipile turns out to use SHA-1 we'll see
 * persistent verification failures in logs and flip to a dual-compute.
 */
export function verifyUnipileWebhook(
    rawBody: string | Buffer,
    signatureHeaderOrHeaders: string | Record<string, string | string[] | undefined> | undefined,
): boolean {
    const secret = process.env.UNIPILE_WEBHOOK_SECRET;
    if (!secret) {
        logger.warn('[UNIPILE] Webhook received but UNIPILE_WEBHOOK_SECRET is unset - rejecting');
        return false;
    }

    // Collect every plausible signature value from the header bag.
    const candidates: string[] = [];
    if (typeof signatureHeaderOrHeaders === 'string') {
        candidates.push(signatureHeaderOrHeaders);
    } else if (signatureHeaderOrHeaders && typeof signatureHeaderOrHeaders === 'object') {
        for (const name of SIGNATURE_HEADER_CANDIDATES) {
            const v = signatureHeaderOrHeaders[name];
            if (typeof v === 'string') candidates.push(v);
            else if (Array.isArray(v) && v.length > 0) candidates.push(v[0]);
        }
    }

    if (candidates.length === 0) return false;

    const body = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody;
    const digest = crypto.createHmac('sha256', secret).update(body).digest();
    const computedHex = digest.toString('hex');
    const computedBase64 = digest.toString('base64');

    for (const raw of candidates) {
        // Strip GitHub-style "sha256=" prefix if present.
        const stripped = raw.replace(/^sha256=/i, '').trim();
        if (timingSafeEqualString(stripped, computedHex)) return true;
        if (timingSafeEqualString(stripped, computedBase64)) return true;
    }
    return false;
}

function timingSafeEqualString(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    try {
        return crypto.timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
    } catch {
        return false;
    }
}
