/**
 * Zapmail integration — typed client over the Zapmail v2 API.
 *
 * Ground truth from docs.zapmail.ai (2026-04-26 crawl):
 *   • Base URL:     https://api.zapmail.ai/api
 *   • Auth header:  x-auth-zapmail: <api-key>           (NOT Authorization: Bearer)
 *   • Optional:     x-workspace-key, x-service-provider (GOOGLE | MICROSOFT)
 *   • Rate limits:  5 req/sec, 20 req/min global. Custom OAuth: 3/mailbox/7d.
 *
 * Used endpoints:
 *   GET  /v2/users                          — validate key (lightweight)
 *   GET  /v2/mailboxes/list                 — paginated mailbox listing, GROUPED by domain
 *   POST /v2/domains/add-client-id          — attach our Google OAuth client_id to domain IDs
 *   POST /v2/mailboxes/custom-oauth         — kick off Zapmail-orchestrated OAuth per mailbox
 *   GET  /v2/exports/status?exportId=…      — poll orchestration status
 *
 * NOTE: token delivery for custom-oauth is undocumented. Best inference is that
 * Zapmail walks the consent server-side as the mailbox user; the auth code then
 * lands at the redirect_uri encoded in the OAuth URL we supplied — i.e. our
 * existing OAuth callback. This is tested behavior, not a documented contract.
 */

const BASE_URL = process.env.ZAPMAIL_BASE_URL || 'https://api.zapmail.ai/api';

export type ZapmailProvider = 'GOOGLE' | 'MICROSOFT';

export interface ZapmailMailbox {
    id: string;
    email: string;
    domain: string;
    domainId: string;
    provider: 'google' | 'microsoft';
    firstName?: string | null;
    lastName?: string | null;
    displayName?: string;
    status?: string;
    isWarmedUp?: boolean;
    workspaceId?: string;
}

interface RawMailbox {
    id: string;
    username?: string;
    email: string;
    firstName?: string | null;
    lastName?: string | null;
    status?: string;
    isWarmedUp?: boolean;
}

interface RawDomainGroup {
    id?: string;
    domainId?: string;
    domain?: string;
    domainName?: string;
    name?: string;
    mailboxes?: RawMailbox[];
}

async function zapmailFetch(
    path: string,
    apiKey: string,
    options: {
        method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
        body?: unknown;
        workspaceKey?: string;
        serviceProvider?: ZapmailProvider;
        query?: Record<string, string | number | undefined>;
    } = {},
): Promise<unknown> {
    const { method = 'GET', body, workspaceKey, serviceProvider, query } = options;

    let url = `${BASE_URL}${path}`;
    if (query) {
        const params = new URLSearchParams();
        for (const [k, v] of Object.entries(query)) {
            if (v !== undefined && v !== null) params.append(k, String(v));
        }
        const qs = params.toString();
        if (qs) url += `?${qs}`;
    }

    const headers: Record<string, string> = {
        'x-auth-zapmail': apiKey,
        Accept: 'application/json',
    };
    if (workspaceKey) headers['x-workspace-key'] = workspaceKey;
    if (serviceProvider) headers['x-service-provider'] = serviceProvider;
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const res = await fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
        const text = await res.text().catch(() => '');
        let parsed: { message?: string; errorId?: string } | null = null;
        try { parsed = JSON.parse(text); } catch { /* not json */ }
        const msg = parsed?.message || text.slice(0, 200) || res.statusText;
        if (res.status === 401 || res.status === 403) {
            throw new Error('Zapmail rejected the API key. Generate a fresh key in Zapmail → Settings → Integrations → API.');
        }
        if (res.status === 429) {
            throw new Error(`Zapmail rate-limited the request: ${msg}`);
        }
        throw new Error(`Zapmail API error (${res.status}): ${msg}`);
    }

    return res.json().catch(() => {
        throw new Error('Zapmail returned a non-JSON response');
    });
}

/**
 * Lightweight key validation. Calling /v2/users returns the authenticated
 * user's profile — succeeds 200 if the key is valid, 401 otherwise.
 */
export async function validateZapmailKey(apiKey: string): Promise<{ ok: true }> {
    await zapmailFetch('/v2/users', apiKey);
    return { ok: true };
}

/**
 * List mailboxes for one provider. Zapmail returns mailboxes GROUPED under
 * `data.domains[].mailboxes[]`, with the domain object exposing `domain` + `id`.
 *
 * We flatten and tag each row with the provider passed in (since the listing
 * itself doesn't include a provider field — provider is scoped via header).
 *
 * Pagination: Zapmail returns `{currentPage, nextPage, totalPages, ...}`. We
 * walk all pages here so callers see a single list.
 */
export async function listMailboxesForProvider(
    apiKey: string,
    provider: ZapmailProvider,
    workspaceKey?: string,
): Promise<ZapmailMailbox[]> {
    const out: ZapmailMailbox[] = [];
    const seen = new Set<string>();
    let page = 1;
    const limit = 100;
    const maxPages = 50; // safety net — 5k mailboxes max

    for (; page <= maxPages; page++) {
        const data = (await zapmailFetch('/v2/mailboxes/list', apiKey, {
            workspaceKey,
            serviceProvider: provider,
            query: { page, limit },
        })) as {
            data?: { domains?: RawDomainGroup[]; nextPage?: number | null; totalPages?: number };
        };

        const domains = data?.data?.domains || [];
        for (const d of domains) {
            const domainId = d.id || d.domainId || '';
            const domainName = d.domain || d.domainName || d.name || '';
            const mailboxes = d.mailboxes || [];
            for (const m of mailboxes) {
                if (!m.email || seen.has(m.email)) continue;
                seen.add(m.email);
                const displayName =
                    [m.firstName, m.lastName].filter(Boolean).join(' ').trim() || m.username || undefined;
                out.push({
                    id: m.id,
                    email: m.email.toLowerCase(),
                    domain: domainName,
                    domainId,
                    provider: provider === 'GOOGLE' ? 'google' : 'microsoft',
                    firstName: m.firstName ?? null,
                    lastName: m.lastName ?? null,
                    displayName,
                    status: m.status,
                    isWarmedUp: m.isWarmedUp,
                });
            }
        }

        const nextPage = data?.data?.nextPage;
        if (!nextPage || nextPage <= page) break;
        page = nextPage - 1; // loop will increment
    }

    return out;
}

/**
 * List both Google and Microsoft mailboxes in one call. Returns a flat list.
 * Failures on one provider don't kill the other — we log and continue.
 */
export async function listAllMailboxes(apiKey: string, workspaceKey?: string): Promise<{
    mailboxes: ZapmailMailbox[];
    errors: { provider: ZapmailProvider; message: string }[];
}> {
    const errors: { provider: ZapmailProvider; message: string }[] = [];
    const results: ZapmailMailbox[][] = [];

    for (const provider of ['GOOGLE', 'MICROSOFT'] as ZapmailProvider[]) {
        try {
            results.push(await listMailboxesForProvider(apiKey, provider, workspaceKey));
        } catch (err: unknown) {
            const e = err as { message?: string };
            errors.push({ provider, message: e?.message || 'Unknown error' });
        }
    }

    return { mailboxes: results.flat(), errors };
}

/**
 * Attach our Google OAuth client_id to a set of customer domains. This must be
 * called BEFORE custom-oauth for Google mailboxes — it whitelists our partner
 * client_id on those domains so the per-mailbox OAuth links are accepted.
 *
 * Response message ("Client ID will be added to the domains soon") suggests the
 * association is async — caller should wait briefly before calling custom-oauth.
 */
export async function addGoogleClientIdToDomains(
    apiKey: string,
    args: { domainIds: string[]; clientId: string; appName: string; workspaceKey?: string },
): Promise<void> {
    if (args.domainIds.length === 0) return;
    await zapmailFetch('/v2/domains/add-client-id', apiKey, {
        method: 'POST',
        body: {
            domainIds: args.domainIds,
            clientId: args.clientId,
            app: args.appName,
        },
        workspaceKey: args.workspaceKey,
    });
}

export interface CustomOAuthMailboxEntry {
    mailboxId: string;
    oauthLink: string;
}

export interface CustomOAuthRequest {
    google?: {
        appName: string;
        clientId: string;
        // domainId -> mailbox entries on that domain
        mailboxesPerDomain: Record<string, CustomOAuthMailboxEntry[]>;
    };
    microsoft?: {
        // No clientId/appName field documented for Microsoft. Just the per-domain
        // mailbox entries; the oauthLink itself encodes our Azure app's client_id.
        mailboxesPerDomain: Record<string, CustomOAuthMailboxEntry[]>;
    };
}

/**
 * Trigger Zapmail's server-side OAuth orchestration. Zapmail logs into each
 * mailbox using the credentials it owns and walks our consent URL. Auth codes
 * land at the redirect_uri inside oauthLink (i.e. our existing callback).
 *
 * Returns Zapmail's exportId for status polling.
 */
export async function triggerCustomOAuth(
    apiKey: string,
    request: CustomOAuthRequest,
    workspaceKey?: string,
): Promise<{ exportId: number }> {
    const data = (await zapmailFetch('/v2/mailboxes/custom-oauth', apiKey, {
        method: 'POST',
        body: request,
        workspaceKey,
    })) as { data?: { exportId: number } };

    if (!data?.data?.exportId) {
        throw new Error('Zapmail did not return an exportId for the OAuth orchestration');
    }
    return { exportId: data.data.exportId };
}

export interface ExportStatus {
    exportId: number;
    status: string;
    progress?: { total?: number; completed?: number; failed?: number };
    raw: unknown;
}

/**
 * Poll the export-job status. Used to surface "Zapmail is authorizing your
 * mailboxes" progress in the UI. Returns the raw payload alongside best-effort
 * normalized fields — Zapmail's exact status enum isn't fully documented.
 */
export async function getExportStatus(
    apiKey: string,
    exportId: number,
    workspaceKey?: string,
): Promise<ExportStatus> {
    const data = (await zapmailFetch('/v2/exports/status', apiKey, {
        workspaceKey,
        query: { exportId },
    })) as {
        data?: {
            status?: string;
            total?: number;
            completed?: number;
            failed?: number;
            progress?: { total?: number; completed?: number; failed?: number };
        };
    };

    const d = data?.data || {};
    return {
        exportId,
        status: d.status || 'unknown',
        progress: d.progress || {
            total: d.total,
            completed: d.completed,
            failed: d.failed,
        },
        raw: data,
    };
}
