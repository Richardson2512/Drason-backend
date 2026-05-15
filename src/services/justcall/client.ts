/**
 * JustCall.io REST client - wraps every API call we need and centralizes:
 *
 *   - Authentication. JustCall takes credentials as
 *       Authorization: <api_key>:<api_secret>
 *     (colon-joined raw, NOT HTTP Basic). Base64ing the pair returns 401
 *     in our manual tests against /users. If JustCall flips this in the
 *     future, swap formatAuthHeader() and nothing else moves.
 *
 *   - Rate limiting. JustCall returns:
 *       X-Rate-Limit-Burst-Remaining   (per-minute remaining)
 *       X-Rate-Limit-Burst-Reset       (UTC seconds until per-minute reset)
 *       X-Rate-Limit-Remaining         (per-hour remaining)
 *       X-Rate-Limit-Reset             (UTC seconds until per-hour reset)
 *     On 429 we sleep until the burst-reset window plus a small jitter,
 *     then retry once. On preemptive low-burst (≤2 remaining) we sleep
 *     proactively to avoid the round-trip.
 *
 *   - Error shape. JustCall returns
 *       { status: 'error', message: '...', code?: '...' }
 *     Status mapping:
 *       401/403 → not retryable, treat as auth failure (unauthorized)
 *       422     → not retryable (validation)
 *       429     → handled inline (rate limit)
 *       5xx     → retryable
 *
 * Reference: https://developer.justcall.io/reference (v2.1)
 */

import { JustCallError } from './types';
import type {
    JustCallAccountInfo,
    JustCallBulkResult,
    JustCallCampaignSummary,
    JustCallContactInput,
} from './types';
import { logger } from '../observabilityService';

export const JUSTCALL_API_BASE = 'https://api.justcall.io/v2.1';

interface JustCallClientOpts {
    apiKey: string;
    apiSecret: string;
}

function formatAuthHeader(apiKey: string, apiSecret: string): string {
    return `${apiKey}:${apiSecret}`;
}

export class JustCallClient {
    private readonly authHeader: string;

    constructor(opts: JustCallClientOpts) {
        if (!opts.apiKey || !opts.apiSecret) {
            throw new JustCallError('JustCall apiKey and apiSecret are required', false, 'invalid_credentials');
        }
        this.authHeader = formatAuthHeader(opts.apiKey, opts.apiSecret);
    }

    // ── HTTP plumbing ────────────────────────────────────────────────

    private async fetch(
        path: string,
        init: RequestInit = {},
        attempt = 0,
    ): Promise<Response> {
        const url = path.startsWith('http') ? path : `${JUSTCALL_API_BASE}${path}`;
        const headers = new Headers(init.headers);
        headers.set('Authorization', this.authHeader);
        headers.set('Accept', 'application/json');
        if (init.body && !headers.has('Content-Type')) {
            headers.set('Content-Type', 'application/json');
        }

        const res = await fetch(url, { ...init, headers });

        // 429 → sleep until burst reset + jitter, retry once.
        if (res.status === 429 && attempt === 0) {
            const burstReset = Number(res.headers.get('X-Rate-Limit-Burst-Reset')) || 0;
            const nowSec = Math.floor(Date.now() / 1000);
            const wait = burstReset > nowSec
                ? Math.min(burstReset - nowSec + 1, 70)   // never wait > 70s
                : 5;                                       // fallback if header missing
            logger.warn('[JUSTCALL] 429 rate-limit - backing off', { waitSec: wait, path });
            await new Promise(resolve => setTimeout(resolve, wait * 1000));
            return this.fetch(path, init, attempt + 1);
        }

        // Preemptive throttle - if we have 1 burst-call left and need to
        // make multiple, give the per-minute window a moment to refill.
        const burstRemaining = Number(res.headers.get('X-Rate-Limit-Burst-Remaining'));
        if (Number.isFinite(burstRemaining) && burstRemaining <= 1) {
            const burstReset = Number(res.headers.get('X-Rate-Limit-Burst-Reset')) || 0;
            const nowSec = Math.floor(Date.now() / 1000);
            const wait = burstReset > nowSec ? Math.min(burstReset - nowSec + 1, 65) : 0;
            if (wait > 0) {
                logger.debug('[JUSTCALL] burst window almost exhausted - pausing', { waitSec: wait });
                await new Promise(resolve => setTimeout(resolve, wait * 1000));
            }
        }

        return res;
    }

    private async expectJson<T = any>(res: Response, opName: string): Promise<T> {
        const text = await res.text();
        let json: any = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* leave json null */ }

        if (!res.ok) {
            const message =
                json?.message ||
                json?.error?.message ||
                json?.error ||
                text.slice(0, 200) ||
                res.statusText;
            const code = json?.code || json?.error?.code;

            if (res.status === 401 || res.status === 403) {
                throw new JustCallError(
                    `JustCall rejected the credentials: ${message}`,
                    false,
                    'unauthorized',
                    res.status,
                );
            }
            if (res.status === 422) {
                throw new JustCallError(
                    `JustCall ${opName} rejected: ${message}`,
                    false,
                    code || 'validation',
                    422,
                );
            }
            const retryable = res.status >= 500 || res.status === 408;
            throw new JustCallError(
                `JustCall ${opName} failed (${res.status}): ${message}`,
                retryable,
                code,
                res.status,
            );
        }

        return (json ?? {}) as T;
    }

    // ── Identity probe - also serves as key validation ───────────────

    /**
     * GET /users - returns the account's user list. We treat a 200 as
     * "the credentials work" and surface the first user's identity so
     * the dashboard can show "Connected as you@your.co".
     */
    async whoami(): Promise<JustCallAccountInfo> {
        const res = await this.fetch('/users?per_page=1');
        const json = await this.expectJson<any>(res, 'whoami');

        const list: any[] = Array.isArray(json?.data)
            ? json.data
            : Array.isArray(json?.users)
                ? json.users
                : [];
        const first = list[0];
        if (!first) {
            // 200 with empty list still proves the key works - surface what we can.
            return { userId: 'unknown', userEmail: '', accountName: null };
        }
        return {
            userId: String(first.id ?? first.user_id ?? 'unknown'),
            userEmail: String(first.email ?? ''),
            accountName: first.account_name ?? first.organization ?? first.workspace ?? null,
        };
    }

    // ── Sales dialer campaigns ───────────────────────────────────────

    /**
     * GET /sales_dialer/campaigns - list dialer campaigns the connected
     * account can push contacts into. JustCall paginates with `page` +
     * `per_page` (max 100). We walk all pages internally; a customer
     * with thousands of campaigns is a pathological case we don't expect
     * but the loop has a hard 50-page (5k campaign) ceiling.
     */
    async listCampaigns(): Promise<JustCallCampaignSummary[]> {
        const out: JustCallCampaignSummary[] = [];
        const seen = new Set<string>();
        const perPage = 100;
        const maxPages = 50;

        for (let page = 1; page <= maxPages; page++) {
            const res = await this.fetch(`/sales_dialer/campaigns?per_page=${perPage}&page=${page}`);
            const json = await this.expectJson<any>(res, 'listCampaigns');
            const rows: any[] = Array.isArray(json?.data) ? json.data : [];
            if (rows.length === 0) break;

            for (const c of rows) {
                const id = String(c.id ?? c.campaign_id ?? '');
                if (!id || seen.has(id)) continue;
                seen.add(id);
                out.push({
                    id,
                    name: String(c.name ?? `Campaign ${id}`),
                    type: c.type ?? c.campaign_type ?? null,
                    status: c.status ?? c.state ?? null,
                    contactCount: typeof c.contact_count === 'number'
                        ? c.contact_count
                        : typeof c.contacts_count === 'number'
                            ? c.contacts_count
                            : null,
                });
            }

            // Detect "no more pages" - either by page meta or short page.
            const totalPages = Number(json?.total_pages ?? json?.pages ?? 0);
            if (totalPages > 0 && page >= totalPages) break;
            if (rows.length < perPage) break;
        }
        return out;
    }

    /**
     * POST /sales_dialer/campaigns - create a brand-new dialer campaign.
     * Required fields: name + country_code. We default the type to
     * Autodial because that's JustCall's own default and the safest for
     * a freshly-created campaign.
     */
    async createCampaign(opts: { name: string; countryCode: string }): Promise<JustCallCampaignSummary> {
        const body = {
            name: opts.name,
            country_code: opts.countryCode,
            type: 'Autodial',
        };
        const res = await this.fetch('/sales_dialer/campaigns', {
            method: 'POST',
            body: JSON.stringify(body),
        });
        const json = await this.expectJson<any>(res, 'createCampaign');
        const c = json?.data ?? json;
        const id = String(c?.id ?? c?.campaign_id ?? '');
        if (!id) {
            throw new JustCallError('JustCall createCampaign returned no campaign id', false, 'invalid_response');
        }
        return {
            id,
            name: String(c?.name ?? opts.name),
            type: c?.type ?? 'Autodial',
            status: c?.status ?? null,
            contactCount: 0,
        };
    }

    // ── Bulk contact import ──────────────────────────────────────────

    /**
     * POST /sales_dialer/contacts/bulk_import - push up to 250 contacts
     * into a campaign in one call. JustCall returns aggregate counts;
     * the precise field names aren't documented uniformly across the
     * v2.1 spec, so we accept several plausible aliases per metric.
     *
     * The caller is responsible for chunking >250 - see chunk() below.
     */
    async bulkImportContacts(opts: {
        campaignId: string;
        contacts: JustCallContactInput[];
    }): Promise<JustCallBulkResult> {
        if (opts.contacts.length === 0) {
            return { added: 0, skipped: 0, failed: 0, batchId: null };
        }
        if (opts.contacts.length > 250) {
            throw new JustCallError(
                `bulkImportContacts received ${opts.contacts.length} rows - JustCall caps at 250 per request`,
                false,
                'batch_too_large',
            );
        }

        const body = {
            campaign_id: Number(opts.campaignId) || opts.campaignId,
            contacts: opts.contacts,
        };
        const res = await this.fetch('/sales_dialer/contacts/bulk_import', {
            method: 'POST',
            body: JSON.stringify(body),
        });
        const json = await this.expectJson<any>(res, 'bulkImportContacts');
        const data = json?.data ?? json;

        const added = Number(
            data?.added ?? data?.imported ?? data?.created ?? data?.success_count ?? data?.successful ?? 0,
        ) || 0;
        const skipped = Number(
            data?.skipped ?? data?.duplicates ?? data?.duplicate_count ?? 0,
        ) || 0;
        const failed = Number(
            data?.failed ?? data?.errors ?? data?.error_count ?? data?.invalid ?? 0,
        ) || 0;
        const batchId = data?.batch_id ?? data?.import_id ?? data?.id ?? null;

        return {
            added,
            skipped,
            failed,
            batchId: batchId != null ? String(batchId) : null,
        };
    }
}

/**
 * Split a contact list into ≤250-row chunks for bulk import. JustCall's
 * suggested minimum is 10 rows per call, so the last chunk may be small
 * but that's the customer's reality - we don't bunch undersized batches.
 */
export function chunk<T>(items: T[], size: number): T[][] {
    if (size <= 0) throw new Error('chunk size must be > 0');
    const out: T[][] = [];
    for (let i = 0; i < items.length; i += size) {
        out.push(items.slice(i, i + size));
    }
    return out;
}
