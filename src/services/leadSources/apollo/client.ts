/**
 * Apollo.io REST client - implements LeadSourceClient.
 *
 * Authenticates with API key in the `X-Api-Key` header (Apollo's
 * Sept-2024 header-only auth). Endpoints used:
 *
 *   POST /v1/auth/health       - connection validation
 *   POST /v1/mixed_people/search  - paginated people search
 *   POST /v1/people/match      - single-record enrichment + email reveal
 *   POST /v1/people/bulk_match - up to 10 enrichments per call
 *   GET  /v1/contact_lists/:id/contacts - saved-list pull
 *   POST /v1/saved_searches/:id/run     - saved-search execution
 *
 * Rate limits are per-plan + per-endpoint + per-window (minute, hour,
 * day). Apollo returns `429` with `Retry-After`. We honor it once.
 */

import {
    LeadSourceAccountInfo,
    LeadSourceClient,
    LeadSourceContact,
    LeadSourceError,
    LeadSourceFilter,
    LeadSourcePagedContacts,
    LeadSourceProvider,
} from '../types';
import { logger } from '../../observabilityService';

const APOLLO_API_BASE = 'https://api.apollo.io/api/v1';
const PAGE_SIZE_DEFAULT = 100; // Apollo's max per page on /mixed_people/search
const BULK_MATCH_BATCH = 10;   // Apollo's max per bulk_match call

interface ApolloClientOpts {
    apiKey: string;
}

export class ApolloLeadSourceClient implements LeadSourceClient {
    readonly provider: LeadSourceProvider = 'apollo';
    private apiKey: string;

    constructor(opts: ApolloClientOpts) {
        this.apiKey = opts.apiKey;
    }

    // ── HTTP plumbing ────────────────────────────────────────────────

    private async apolloFetch(
        path: string,
        init: RequestInit = {},
        attempt = 0,
    ): Promise<Response> {
        const url = path.startsWith('http') ? path : `${APOLLO_API_BASE}${path}`;
        const headers = new Headers(init.headers);
        headers.set('Cache-Control', 'no-cache');
        headers.set('Content-Type', 'application/json');
        headers.set('X-Api-Key', this.apiKey);

        const res = await fetch(url, { ...init, headers });

        // 429 → honor Retry-After once (default 5s, cap 30s)
        if (res.status === 429 && attempt < 1) {
            const ra = Number(res.headers.get('retry-after') || '5') * 1000;
            await new Promise(r => setTimeout(r, Math.min(ra, 30_000)));
            return this.apolloFetch(path, init, attempt + 1);
        }

        return res;
    }

    private async expectJson<T>(res: Response, opName: string): Promise<T> {
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            const detail = text.slice(0, 300);
            const retryable = res.status >= 500 || res.status === 429;

            // Apollo specific: 403 means the customer's plan doesn't include API
            // access. Surface a clean message so the dashboard can prompt them.
            if (res.status === 403) {
                throw new LeadSourceError(
                    'Apollo API access requires a paid plan (Professional or higher). Upgrade at apollo.io/pricing.',
                    false,
                    'plan_gated',
                );
            }
            if (res.status === 401) {
                throw new LeadSourceError(
                    'Apollo API key invalid or revoked. Generate a new key in Apollo → Settings → Integrations.',
                    false,
                    'invalid_key',
                );
            }
            throw new LeadSourceError(
                `Apollo ${opName} failed (${res.status}): ${detail}`,
                retryable,
                String(res.status),
            );
        }
        return res.json() as Promise<T>;
    }

    // ── Validation / account info ────────────────────────────────────

    async validateConnection(): Promise<LeadSourceAccountInfo> {
        // Apollo's auth health endpoint returns the current user's
        // account info. If the API key is invalid we get a 401 here.
        const res = await this.apolloFetch('/auth/health', { method: 'POST' });
        const data = await this.expectJson<any>(res, 'auth health');

        // The endpoint shape is: { is_logged_in: true, user: { ... }, organization: { ... } }
        // Credit balance lives on `current_credits_used` and `total_credits` per-tier;
        // surface what we can find, gracefully fall back to nulls.
        const org = data?.organization ?? {};
        const orgId = String(org?.id ?? data?.user?.organization_id ?? '');
        const orgName = org?.name ?? data?.user?.email ?? 'Apollo workspace';

        // Credits - Apollo wraps these inside a credits object on some plans.
        const creditsBlock = org?.credits || data?.credits || {};
        const used = Number(creditsBlock?.used ?? creditsBlock?.consumed_credits ?? 0);
        const limit = Number(creditsBlock?.total ?? creditsBlock?.granted_credits ?? 0);

        return {
            externalAccountId: orgId,
            externalAccountName: orgName,
            creditsRemaining: limit > 0 ? Math.max(0, limit - used) : null,
            creditsLimit: limit > 0 ? limit : null,
        };
    }

    // ── Search / list ────────────────────────────────────────────────

    async listContacts(opts: {
        filter: LeadSourceFilter;
        cursor: string | null;
        limit?: number;
        revealPersonalEmails?: boolean;
    }): Promise<LeadSourcePagedContacts> {
        const limit = Math.min(opts.limit ?? PAGE_SIZE_DEFAULT, PAGE_SIZE_DEFAULT);
        const page = opts.cursor ? Number(opts.cursor) : 1;

        switch (opts.filter.kind) {
            case 'people_search':
                return this.runPeopleSearch(opts.filter.params, page, limit, !!opts.revealPersonalEmails);

            case 'saved_search':
                return this.runSavedSearch(opts.filter.searchId, page, limit, !!opts.revealPersonalEmails);

            case 'saved_list':
                return this.runSavedList(opts.filter.listId, page, limit, !!opts.revealPersonalEmails);
        }
    }

    private async runPeopleSearch(
        params: Record<string, unknown>,
        page: number,
        limit: number,
        revealEmails: boolean,
    ): Promise<LeadSourcePagedContacts> {
        const body = {
            ...params,
            page,
            per_page: limit,
        };

        const res = await this.apolloFetch('/mixed_people/search', {
            method: 'POST',
            body: JSON.stringify(body),
        });
        const data = await this.expectJson<{
            people: any[];
            pagination?: { page: number; total_pages: number; total_entries: number };
        }>(res, 'people search');

        const ids = (data.people ?? []).map(p => p?.id).filter((x): x is string => typeof x === 'string');

        // Email reveal - bulk_match for up to 10 per call.
        let enrichedById: Map<string, any> = new Map();
        if (revealEmails && ids.length > 0) {
            enrichedById = await this.bulkRevealByIds(ids);
        }

        const contacts = (data.people ?? []).map((p: any) => {
            const enriched = enrichedById.get(p.id);
            return apolloPersonToContact(enriched ?? p);
        });

        const totalPages = data.pagination?.total_pages ?? 0;
        const nextCursor = page < totalPages ? String(page + 1) : null;

        return {
            contacts,
            nextCursor,
            totalCount: data.pagination?.total_entries ?? null,
        };
    }

    private async runSavedSearch(
        searchId: string,
        page: number,
        limit: number,
        revealEmails: boolean,
    ): Promise<LeadSourcePagedContacts> {
        // Saved searches re-run live with their stored filters.
        const res = await this.apolloFetch(`/saved_searches/${encodeURIComponent(searchId)}/run`, {
            method: 'POST',
            body: JSON.stringify({ page, per_page: limit }),
        });
        const data = await this.expectJson<{
            people: any[];
            pagination?: { page: number; total_pages: number; total_entries: number };
        }>(res, 'saved search run');

        const ids = (data.people ?? []).map(p => p?.id).filter((x): x is string => typeof x === 'string');
        let enrichedById: Map<string, any> = new Map();
        if (revealEmails && ids.length > 0) {
            enrichedById = await this.bulkRevealByIds(ids);
        }

        const contacts = (data.people ?? []).map((p: any) =>
            apolloPersonToContact(enrichedById.get(p.id) ?? p),
        );
        const totalPages = data.pagination?.total_pages ?? 0;
        const nextCursor = page < totalPages ? String(page + 1) : null;
        return {
            contacts,
            nextCursor,
            totalCount: data.pagination?.total_entries ?? null,
        };
    }

    private async runSavedList(
        listId: string,
        page: number,
        limit: number,
        revealEmails: boolean,
    ): Promise<LeadSourcePagedContacts> {
        const url = `/contact_lists/${encodeURIComponent(listId)}/contacts?page=${page}&per_page=${limit}`;
        const res = await this.apolloFetch(url, { method: 'GET' });
        const data = await this.expectJson<{
            contacts: any[];
            pagination?: { page: number; total_pages: number; total_entries: number };
        }>(res, 'saved list contacts');

        // Saved-list contacts already include emails on the response
        // (they were curated by the user), so reveal is usually a no-op.
        // Honor the flag anyway in case the user added unenriched contacts.
        const ids = (data.contacts ?? [])
            .map(c => c?.id)
            .filter((x): x is string => typeof x === 'string');

        let enrichedById: Map<string, any> = new Map();
        if (revealEmails && ids.length > 0) {
            enrichedById = await this.bulkRevealByIds(ids);
        }

        const contacts = (data.contacts ?? []).map((c: any) =>
            apolloPersonToContact(enrichedById.get(c.id) ?? c),
        );
        const totalPages = data.pagination?.total_pages ?? 0;
        const nextCursor = page < totalPages ? String(page + 1) : null;
        return {
            contacts,
            nextCursor,
            totalCount: data.pagination?.total_entries ?? null,
        };
    }

    /**
     * Bulk-match by Apollo person id - reveals personal emails. Returns
     * a map keyed by the input id so callers can join enriched fields
     * back to the original list response.
     *
     * Apollo's bulk_match accepts up to 10 ids per call. We page in
     * BULK_MATCH_BATCH-sized chunks.
     */
    private async bulkRevealByIds(ids: string[]): Promise<Map<string, any>> {
        const out = new Map<string, any>();
        for (let i = 0; i < ids.length; i += BULK_MATCH_BATCH) {
            const slice = ids.slice(i, i + BULK_MATCH_BATCH);
            try {
                const res = await this.apolloFetch('/people/bulk_match', {
                    method: 'POST',
                    body: JSON.stringify({
                        details: slice.map(id => ({ id })),
                        reveal_personal_emails: true,
                        reveal_phone_number: false,
                    }),
                });
                const data = await this.expectJson<{ matches: any[] }>(res, 'bulk match');
                for (const m of data.matches ?? []) {
                    if (m?.id) out.set(m.id, m);
                }
            } catch (err) {
                logger.warn('[APOLLO] bulk_match slice failed', {
                    sliceSize: slice.length,
                    err: (err as Error).message?.slice(0, 200),
                });
                // Continue with the other slices - partial enrichment is
                // better than failing the whole import.
            }
        }
        return out;
    }

    // ── Estimate ─────────────────────────────────────────────────────

    async estimateContactCount(filter: LeadSourceFilter): Promise<number | null> {
        // The cleanest way to estimate is to issue a 1-record search
        // and read pagination.total_entries. No credits consumed for
        // search-only (only bulk_match consumes credits).
        const dummy = await this.listContacts({
            filter,
            cursor: null,
            limit: 1,
            revealPersonalEmails: false,
        });
        return dummy.totalCount ?? null;
    }
}

// ── helpers ─────────────────────────────────────────────────────────

function apolloPersonToContact(p: any): LeadSourceContact {
    const org = p?.organization ?? p?.account ?? {};
    return {
        externalId: String(p?.id ?? ''),
        email: String(p?.email ?? '').toLowerCase(),
        firstName: p?.first_name || undefined,
        lastName: p?.last_name || undefined,
        fullName: p?.name || [p?.first_name, p?.last_name].filter(Boolean).join(' ') || undefined,
        company: org?.name || p?.organization_name || undefined,
        title: p?.title || undefined,
        phone: pickFirstPhone(p),
        linkedinUrl: p?.linkedin_url || undefined,
        // Apollo nests the org on the person record; their company
        // LinkedIn lives on the organization sub-object.
        companyLinkedinUrl: org?.linkedin_url || p?.organization?.linkedin_url || undefined,
        customFields: p,
    };
}

function pickFirstPhone(p: any): string | undefined {
    const candidates = [
        p?.sanitized_phone,
        p?.phone,
        p?.mobile_phone,
        p?.work_direct_phone,
        p?.home_phone,
        p?.organization?.primary_phone?.sanitized_number,
    ];
    for (const c of candidates) {
        if (typeof c === 'string' && c.length > 0) return c;
    }
    return undefined;
}
