/**
 * Scaled Mail API integration.
 *
 * Reference: https://api.scaledmail.com (Apidog-hosted spec, sitemap-listed
 * endpoints under https://server.scaledmail.com/api/v1).
 *
 * What's confirmed by the published spec:
 *   - Base URL:  https://server.scaledmail.com/api/v1
 *   - Auth:      Authorization: Bearer <apiKey>  (key from app.scaledmail.com/settings)
 *   - Rate cap:  5 requests/second (enforced by Scaled Mail)
 *   - Listing flow is THREE-TIER, unlike Zapmail's flat /export:
 *
 *       GET /organizations
 *           → list of workspaces the API key can see
 *       GET /purchased-domains?organization_id=X&available=false
 *           → all domains owned by that org (available=false includes ones
 *             that already have mailboxes provisioned)
 *       GET /mailboxes/{domain_id}?organization_id=X
 *           → mailboxes under one domain, with credentials
 *
 * What's NOT in the public spec:
 *   - Response field shapes (Apidog page shows `properties: {}` for every
 *     200 response). The mailbox object's field names - email vs username,
 *     password vs app_password vs smtp_password, provider vs service_type,
 *     etc. - must be inferred at runtime.
 *
 * To stay safe under that uncertainty this module:
 *   1. Reads each field via a list of plausible aliases. If Scaled Mail
 *      uses ANY of {appPassword, app_password, smtp_password, smtpPassword,
 *      password} for the SMTP credential, we'll find it.
 *   2. Logs the raw shape of the FIRST mailbox object returned per
 *      organization (at debug level) so a misalignment is visible without
 *      leaking creds in normal logs.
 *   3. Returns mailboxes with `appPassword: null` when no password field
 *      is recognized - the import service already handles that gracefully
 *      by marking the row "not ready" rather than failing the batch.
 *
 * When you have a real API key, hit listAllMailboxes once and check the
 * debug log to confirm field names; tighten the alias list if you want.
 */

import { logger } from './observabilityService';

const BASE_URL = 'https://server.scaledmail.com/api/v1';

/** Scaled Mail enforces a hard 5 req/sec ceiling. We pace at 4/sec to leave
 *  headroom for retries and clock skew. A simple in-process throttle is
 *  enough - the bulk-import controller is single-tenant per request and
 *  not invoked concurrently within a single Node process for the same key. */
const MIN_REQUEST_INTERVAL_MS = 250; // 4 req/sec
let lastRequestAt = 0;

async function throttle(): Promise<void> {
    const now = Date.now();
    const wait = Math.max(0, lastRequestAt + MIN_REQUEST_INTERVAL_MS - now);
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
    lastRequestAt = Date.now();
}

export interface ScaledMailOrganization {
    id: string;
    name?: string;
}

export interface ScaledMailDomain {
    id: string;
    domain: string;
    organizationId: string;
}

/** Normalized Scaled Mail mailbox. Field aliases are resolved during
 *  parsing - see extractMailbox(). Credentials may be null when the
 *  underlying mailbox is still being provisioned by Scaled Mail. */
export interface ScaledMailMailbox {
    id: string;
    email: string;
    domain: string;
    domainId: string;
    organizationId: string;
    provider: 'google' | 'microsoft';
    displayName?: string;
    appPassword: string | null;
    /** Status string returned by Scaled Mail (e.g. "active", "warming"). */
    status?: string | null;
    isWarmedUp?: boolean;
}

/**
 * Low-level fetch wrapper - applies auth, throttling, and consistent
 * error mapping. Mirrors the shape of zapmailFetch so error UX is uniform
 * across resellers.
 */
async function scaledMailFetch(
    path: string,
    apiKey: string,
    options: {
        method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
        query?: Record<string, string | number | boolean | undefined>;
    } = {},
): Promise<unknown> {
    const { method = 'GET', query } = options;

    let url = `${BASE_URL}${path}`;
    if (query) {
        const params = new URLSearchParams();
        for (const [k, v] of Object.entries(query)) {
            if (v !== undefined && v !== null) params.append(k, String(v));
        }
        const qs = params.toString();
        if (qs) url += `?${qs}`;
    }

    await throttle();

    const res = await fetch(url, {
        method,
        headers: {
            Authorization: `Bearer ${apiKey}`,
            Accept: 'application/json',
        },
    });

    if (!res.ok) {
        const text = await res.text().catch(() => '');
        const truncated = text.slice(0, 200);
        if (res.status === 401 || res.status === 403) {
            throw new Error(
                'Scaled Mail rejected the API key. Generate a fresh key at app.scaledmail.com/settings.',
            );
        }
        if (res.status === 429) {
            throw new Error(`Scaled Mail rate-limited the request: ${truncated || res.statusText}`);
        }
        throw new Error(`Scaled Mail API error (${res.status}): ${truncated || res.statusText}`);
    }

    return res.json().catch(() => {
        throw new Error('Scaled Mail returned a non-JSON response');
    });
}

/** Read a value out of an object trying several plausible keys.
 *  Used because Scaled Mail's response field names aren't documented. */
function pickString(obj: Record<string, any>, keys: string[]): string | null {
    for (const k of keys) {
        const v = obj[k];
        if (typeof v === 'string' && v.trim().length > 0) return v.trim();
    }
    return null;
}

function pickBoolean(obj: Record<string, any>, keys: string[]): boolean | undefined {
    for (const k of keys) {
        const v = obj[k];
        if (typeof v === 'boolean') return v;
    }
    return undefined;
}

/** Some APIs return a bare array, others wrap in {data: [...]}. Scaled
 *  Mail's spec doesn't say which - accept both. */
function extractArray(payload: unknown): any[] {
    if (Array.isArray(payload)) return payload;
    if (payload && typeof payload === 'object') {
        const obj = payload as Record<string, any>;
        if (Array.isArray(obj.data)) return obj.data;
        if (Array.isArray(obj.items)) return obj.items;
        if (Array.isArray(obj.results)) return obj.results;
        if (Array.isArray(obj.mailboxes)) return obj.mailboxes;
        if (Array.isArray(obj.domains)) return obj.domains;
        if (Array.isArray(obj.organizations)) return obj.organizations;
    }
    return [];
}

/**
 * Validate that the API key works. Calls GET /organizations - succeeds
 * 200 with a list (possibly empty), 401/403 on bad key. Throws our
 * standard friendly error message for invalid keys.
 */
export async function validateScaledMailKey(apiKey: string): Promise<{ ok: true }> {
    await scaledMailFetch('/organizations', apiKey);
    return { ok: true };
}

/** List every workspace/organization this key has access to. */
export async function listOrganizations(apiKey: string): Promise<ScaledMailOrganization[]> {
    const payload = await scaledMailFetch('/organizations', apiKey);
    const rows = extractArray(payload);

    return rows
        .map((row): ScaledMailOrganization | null => {
            if (!row || typeof row !== 'object') return null;
            const id = pickString(row, ['id', 'organization_id', 'organizationId', '_id']);
            if (!id) return null;
            const name = pickString(row, ['name', 'organization_name', 'workspace_name', 'title']) || undefined;
            return { id, name };
        })
        .filter((o): o is ScaledMailOrganization => o !== null);
}

/**
 * List domains the customer owns under one organization. `available=false`
 * is required to include domains that already have mailboxes - without it
 * Scaled Mail filters to "domains usable for new orders" only, which is
 * the wrong set for an import flow.
 */
export async function listPurchasedDomains(
    apiKey: string,
    organizationId: string,
): Promise<ScaledMailDomain[]> {
    const payload = await scaledMailFetch('/purchased-domains', apiKey, {
        query: { organization_id: organizationId, available: false },
    });
    const rows = extractArray(payload);

    return rows
        .map((row): ScaledMailDomain | null => {
            if (!row || typeof row !== 'object') return null;
            const id = pickString(row, ['id', 'domain_id', 'domainId', '_id']);
            const domain = pickString(row, ['domain', 'domain_name', 'name', 'hostname']);
            if (!id || !domain) return null;
            return { id, domain: domain.toLowerCase(), organizationId };
        })
        .filter((d): d is ScaledMailDomain => d !== null);
}

/**
 * List mailboxes under one domain. The response field shape is the
 * undocumented part - see extractMailbox() for the alias-matching logic.
 */
export async function listMailboxesByDomain(
    apiKey: string,
    organizationId: string,
    domain: ScaledMailDomain,
    /** Set true on the first call per session to dump the raw shape of
     *  the first mailbox into debug logs (no credentials surfaced) so
     *  the operator can verify field names against this implementation. */
    logShape = false,
): Promise<ScaledMailMailbox[]> {
    const payload = await scaledMailFetch(`/mailboxes/${encodeURIComponent(domain.id)}`, apiKey, {
        query: { organization_id: organizationId },
    });
    const rows = extractArray(payload);

    if (logShape && rows.length > 0) {
        const shape = Object.keys(rows[0] || {}).sort();
        logger.debug('[SCALEDMAIL] First mailbox keys (per domain)', {
            domain: domain.domain,
            keys: shape,
        });
    }

    return rows
        .map(row => extractMailbox(row, domain, organizationId))
        .filter((m): m is ScaledMailMailbox => m !== null);
}

/**
 * Defensively map a raw mailbox row into our normalized shape.
 *
 * Scaled Mail's published OpenAPI spec leaves the response schema empty,
 * so we accept several plausible field names per attribute. Any name
 * that lands in the wild gets caught here without code changes.
 */
function extractMailbox(
    raw: any,
    domain: ScaledMailDomain,
    organizationId: string,
): ScaledMailMailbox | null {
    if (!raw || typeof raw !== 'object') return null;

    const id = pickString(raw, ['id', 'mailbox_id', 'mailboxId', '_id']);
    const email = pickString(raw, ['email', 'email_address', 'address', 'username']);
    if (!id || !email) return null;

    // Provider - Scaled Mail sells both Google Workspace and Microsoft 365
    // mailboxes. Default to google because their flagship product is
    // Workspace; fall through to microsoft on any clear signal.
    const providerRaw = (
        pickString(raw, ['provider', 'service_provider', 'mailbox_provider', 'type', 'service']) || ''
    ).toLowerCase();
    const provider: 'google' | 'microsoft' =
        providerRaw.includes('microsoft') || providerRaw.includes('outlook') || providerRaw.includes('365')
            ? 'microsoft'
            : 'google';

    const appPassword = pickString(raw, [
        'app_password',
        'appPassword',
        'smtp_password',
        'smtpPassword',
        'password',
    ]);

    const firstName = pickString(raw, ['first_name', 'firstName', 'givenName']);
    const lastName = pickString(raw, ['last_name', 'lastName', 'familyName']);
    const fullName = pickString(raw, ['full_name', 'fullName', 'name', 'display_name', 'displayName']);
    const displayName = fullName || [firstName, lastName].filter(Boolean).join(' ').trim() || undefined;

    const status = pickString(raw, ['status', 'state', 'mailbox_status']);
    const isWarmedUp =
        pickBoolean(raw, ['is_warmed_up', 'isWarmedUp', 'warmed_up', 'warmedUp', 'is_warm']) ??
        (status ? /warm|active|ready/i.test(status) : undefined);

    return {
        id,
        email: email.toLowerCase(),
        domain: domain.domain,
        domainId: domain.id,
        organizationId,
        provider,
        displayName,
        appPassword,
        status: status ?? null,
        isWarmedUp,
    };
}

/**
 * Walk org → domain → mailbox and return the flattened mailbox list.
 * Per-domain failures are logged and skipped; per-org failures abort
 * that org but let the others continue (so a customer with one bad
 * workspace still imports from their good ones).
 *
 * Pacing: every API call goes through the throttle. With ~250ms between
 * calls, a customer with 1 org / 50 domains / 1 mailbox-list-call per
 * domain pays roughly 50 × 250ms = ~12.5s. That's well inside any UI
 * timeout and below Scaled Mail's 5/sec ceiling.
 */
export async function listAllMailboxes(apiKey: string): Promise<{
    mailboxes: ScaledMailMailbox[];
    errors: Array<{ scope: 'organization' | 'domain'; id: string; message: string }>;
}> {
    const out: ScaledMailMailbox[] = [];
    const errors: Array<{ scope: 'organization' | 'domain'; id: string; message: string }> = [];
    const seenEmails = new Set<string>();

    let orgs: ScaledMailOrganization[];
    try {
        orgs = await listOrganizations(apiKey);
    } catch (err) {
        // Caller wants this to bubble - bad key, network down, etc. Don't
        // mask the failure as "0 mailboxes found".
        throw err;
    }

    let firstMailboxLogged = false;

    for (const org of orgs) {
        let domains: ScaledMailDomain[];
        try {
            domains = await listPurchasedDomains(apiKey, org.id);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            errors.push({ scope: 'organization', id: org.id, message });
            logger.warn('[SCALEDMAIL] Failed to list domains for organization', {
                organizationId: org.id, message,
            });
            continue;
        }

        for (const domain of domains) {
            try {
                const mailboxes = await listMailboxesByDomain(
                    apiKey,
                    org.id,
                    domain,
                    !firstMailboxLogged,
                );
                if (mailboxes.length > 0) firstMailboxLogged = true;

                for (const m of mailboxes) {
                    if (seenEmails.has(m.email)) continue;
                    seenEmails.add(m.email);
                    out.push(m);
                }
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                errors.push({ scope: 'domain', id: domain.id, message });
                logger.warn('[SCALEDMAIL] Failed to list mailboxes for domain', {
                    domainId: domain.id, domain: domain.domain, message,
                });
            }
        }
    }

    return { mailboxes: out, errors };
}
