/**
 * Instantly v2 API Client
 *
 * Read-only HTTP wrapper for Instantly.ai's v2 REST API. Used exclusively by
 * the one-time import flow to fetch campaigns, leads, sending accounts, tags,
 * lead labels, block list, and analytics from a customer's Instantly workspace.
 *
 * Field shapes mirror what Instantly's docs (https://developer.instantly.ai/)
 * document at the time of writing — every interface below is derived from a
 * documented field, never invented.
 *
 * Auth:
 *   Authorization: Bearer <API_KEY>     (per-key, scoped to one workspace)
 *
 * Rate limits (workspace-wide, across all keys, v1+v2 combined):
 *   • Global: 100 req/sec AND 6000 req/min
 *   • /api/v2/emails specifically: 20 req/min (5x tighter than global)
 * No Retry-After header is documented; we apply exponential backoff with
 * jitter (1s, 2s, 4s, 8s, 16s ± 20%).
 *
 * Plan gate:
 *   The API returns 402 Payment Required if the workspace's paid plan is
 *   inactive. We surface this as a typed error so the wizard can render a
 *   "your Instantly workspace needs an active plan" message rather than a
 *   generic failure.
 *
 * Pagination: cursor-based with `limit` (max 100) and `starting_after`.
 * Response envelope is `{ items: [...], next_starting_after: string|null }`.
 * Two notable exceptions:
 *   1. Leads list uses POST /api/v2/leads/list (body holds filters + cursor).
 *   2. Accounts list cursor is a compound `timestamp_created&email` string,
 *      not a UUID — opaque to us, just round-trip what the server returns.
 */

import { logger } from './observabilityService';

const BASE_URL = 'https://api.instantly.ai/api/v2';
const MAX_RETRIES = 5;
const PAGE_SIZE = 100;
const LOG_TAG = 'INSTANTLY-CLIENT';

// ─────────────────────────────────────────────────────────────────────────────
// Typed errors
// ─────────────────────────────────────────────────────────────────────────────

export class InstantlyAuthError extends Error {
    constructor(message: string) { super(message); this.name = 'InstantlyAuthError'; }
}
export class InstantlyPaymentRequiredError extends Error {
    constructor() {
        super('The Instantly workspace does not have an active paid plan. The workspace owner must reactivate billing before we can read its data.');
        this.name = 'InstantlyPaymentRequiredError';
    }
}
export class InstantlyRateLimitError extends Error {
    constructor() { super('Instantly rate limit exceeded after retries'); this.name = 'InstantlyRateLimitError'; }
}

// ─────────────────────────────────────────────────────────────────────────────
// Response types — one block per resource. Optional fields use `?` when the
// docs explicitly mark them optional or when their absence is observed.
// ─────────────────────────────────────────────────────────────────────────────

/** GET /api/v2/workspaces/current — used as whoami / key validation. */
export interface InstantlyWorkspace {
    id: string;
    name: string;
    owner: string;
    plan_id?: string | null;
    timestamp_created?: string;
    timestamp_updated?: string;
}

/**
 * Status enum on Campaign and Lead.
 * NOTE: numeric, with NEGATIVE health states. Don't filter `>= 0`.
 *   0 = Draft, 1 = Active, 2 = Paused, 3 = Completed,
 *   4 = Running Subsequences,
 *  -1 = Accounts Unhealthy, -2 = Bounce Protect, -99 = Account Suspended
 */
export type InstantlyCampaignStatus = 0 | 1 | 2 | 3 | 4 | -1 | -2 | -99;

export interface InstantlyCampaign {
    id: string;
    name: string;
    status: InstantlyCampaignStatus;
    email_list?: string[];
    daily_limit?: number;
    email_gap?: number;
    random_wait_max?: number;
    text_only?: boolean;
    first_email_text_only?: boolean;
    link_tracking?: boolean;
    open_tracking?: boolean;
    stop_on_reply?: boolean;
    stop_on_auto_reply?: boolean;
    stop_for_company?: boolean;
    is_evergreen?: boolean;
    pl_value?: number;
    cc_list?: string[];
    bcc_list?: string[];
    campaign_schedule?: InstantlyCampaignSchedule;
    sequences?: InstantlySequence[];
    timestamp_created?: string;
    timestamp_updated?: string;
}

export interface InstantlyCampaignSchedule {
    schedules?: Array<{
        name: string;
        timing: { from: string; to: string };
        days: Record<string, boolean>;
        timezone: string;
    }>;
    start_date?: string | null;
    end_date?: string | null;
}

export interface InstantlySequence {
    steps?: InstantlyStep[];
}

export interface InstantlyStep {
    type?: string;
    delay?: number;
    delay_unit?: 'minutes' | 'hours' | 'days';
    variants?: InstantlyVariant[];
}

export interface InstantlyVariant {
    subject: string;
    body: string;
    v_disabled?: boolean;
}

/** Per-lead status enum (string-typed in v2 responses). */
export type InstantlyLeadStatus =
    | 'Active'
    | 'Paused'
    | 'Completed'
    | 'Bounced'
    | 'Unsubscribed'
    | 'Skipped';

export interface InstantlyLead {
    id: string;
    email: string;
    first_name?: string | null;
    last_name?: string | null;
    phone?: string | null;
    company_name?: string | null;
    company_domain?: string | null;
    job_title?: string | null;
    website?: string | null;
    status?: InstantlyLeadStatus;
    lt_interest_status?: string | null;
    verification_status?: string | null;
    enrichment_status?: string | null;
    esp_code?: string | null;
    esg_code?: string | null;

    /** Per-lead step attribution — sufficient to reconstruct sequence state. */
    last_step_id?: string | null;
    last_step_from?: string | null;             // sending mailbox email
    last_step_timestamp_executed?: string | null;
    email_opened_step?: number | null;
    email_opened_variant?: number | null;
    email_replied_step?: number | null;
    email_replied_variant?: number | null;
    email_clicked_step?: number | null;
    email_clicked_variant?: number | null;

    email_open_count?: number;
    email_reply_count?: number;
    email_click_count?: number;

    timestamp_created?: string;
    timestamp_updated?: string;
    timestamp_last_contact?: string | null;
    timestamp_last_open?: string | null;
    timestamp_last_reply?: string | null;
    timestamp_last_click?: string | null;
    timestamp_last_interest_change?: string | null;
    timestamp_last_touch?: string | null;
    timestamp_added_subsequence?: string | null;

    /** Custom variables. Flat only (string|number|bool|null) per docs. */
    payload?: Record<string, string | number | boolean | null>;

    personalization?: string | null;
    pl_value_lead?: number | null;
    campaign?: string | null;       // campaign UUID
    list_id?: string | null;
    subsequence_id?: string | null;
    assigned_to?: string | null;
    uploaded_by_user?: string | null;
    upload_method?: string | null;
    organization?: string;
}

export interface InstantlyAccount {
    email: string;
    first_name?: string | null;
    last_name?: string | null;
    organization?: string;
    /**
     * Provider code:
     *   1 = Custom IMAP/SMTP
     *   2 = Google
     *   3 = Microsoft
     *   4 = AWS
     *   5 = AirMail
     * (Numeric values inferred from docs ordering — treat unknown numbers
     *  as 'unknown' rather than crashing.)
     */
    provider_code?: number;
    daily_limit?: number;
    sending_gap?: number;
    status?: number | string;
    status_message?: string | null;
    enable_slow_ramp?: boolean;
    warmup?: {
        limit?: number;
        increment?: number;
        reply_rate?: number;
        open_rate?: number;
        important_rate?: number;
        spam_save_rate?: number;
        advanced?: {
            warm_ctd?: boolean;
            read_emulation?: boolean;
            weekday_only?: boolean;
        };
    };
    warmup_status?: number | string;
    warmup_pool_id?: string | null;
    tracking_domain_name?: string | null;
    tracking_domain_status?: string | null;
    signature?: string | null;
    is_managed_account?: boolean;
    setup_pending?: boolean;
    timestamp_created?: string;
    timestamp_updated?: string;
    timestamp_last_used?: string | null;
    timestamp_warmup_start?: string | null;
}

export interface InstantlyAccountCampaignMapping {
    campaign_id: string;
    campaign_name?: string;
    timestamp_created?: string;
    status?: InstantlyCampaignStatus;
}

export interface InstantlyCustomTag {
    id: string;
    label: string;
    description?: string | null;
    organization_id?: string;
    timestamp_created?: string;
    timestamp_updated?: string;
}

export interface InstantlyLeadLabel {
    id: string;
    label: string;
    interest_status_label?: 'positive' | 'negative' | 'neutral';
    interest_status?: number | null;
    description?: string | null;
    use_with_ai?: boolean;
}

export interface InstantlyBlockListEntry {
    id: string;
    bl_value: string;            // email or domain
    is_domain?: boolean;
    organization_id?: string;
    timestamp_created?: string;
}

export interface InstantlyCampaignAnalytics {
    campaign_id?: string;
    open_count?: number;
    reply_count?: number;
    link_click_count?: number;
    emails_sent_count?: number;
    bounced_count?: number;
    unsubscribed_count?: number;
    contacted_count?: number;
    completed_count?: number;
    leads_count?: number;
    total_opportunities?: number;
    total_opportunity_value?: number;
    campaign_status?: InstantlyCampaignStatus;
    campaign_is_evergreen?: boolean;
}

interface CursorEnvelope<T> {
    items: T[];
    next_starting_after?: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal request helper — handles auth, retries, 402/401/429 typing
// ─────────────────────────────────────────────────────────────────────────────

interface RequestOptions {
    method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    body?: unknown;
    query?: Record<string, string | number | boolean | undefined>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function request<T>(apiKey: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const method = opts.method || 'GET';

    let url = `${BASE_URL}${path}`;
    if (opts.query && Object.keys(opts.query).length > 0) {
        const qs = new URLSearchParams();
        for (const [k, v] of Object.entries(opts.query)) {
            if (v === undefined || v === null) continue;
            qs.set(k, String(v));
        }
        const tail = qs.toString();
        if (tail) url += (url.includes('?') ? '&' : '?') + tail;
    }

    const headers: Record<string, string> = {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
    };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const res = await fetch(url, {
                method,
                headers,
                body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
            });

            if (res.status === 401 || res.status === 403) {
                const text = await res.text().catch(() => '');
                throw new InstantlyAuthError(`Instantly rejected the API key (${res.status}): ${text.slice(0, 200)}`);
            }
            if (res.status === 402) {
                throw new InstantlyPaymentRequiredError();
            }
            if (res.status === 429) {
                if (attempt === MAX_RETRIES) throw new InstantlyRateLimitError();
                // No documented Retry-After; back off exponentially with jitter.
                const base = 1000 * Math.pow(2, attempt - 1);
                const jitter = base * (Math.random() * 0.4 - 0.2);
                const wait = Math.round(base + jitter);
                logger.warn(`[${LOG_TAG}] 429 backoff`, { attempt, waitMs: wait, path });
                await sleep(wait);
                continue;
            }
            if (res.status >= 500) {
                if (attempt === MAX_RETRIES) {
                    const text = await res.text().catch(() => '');
                    throw new Error(`Instantly ${res.status} after ${MAX_RETRIES} retries: ${text.slice(0, 200)}`);
                }
                const wait = 1000 * Math.pow(2, attempt - 1);
                logger.warn(`[${LOG_TAG}] 5xx backoff`, { attempt, status: res.status, waitMs: wait, path });
                await sleep(wait);
                continue;
            }
            if (!res.ok) {
                const text = await res.text().catch(() => '');
                throw new Error(`Instantly ${res.status}: ${text.slice(0, 300)}`);
            }

            const ct = res.headers.get('content-type') || '';
            if (!ct.includes('application/json')) {
                // Some endpoints (CSV download) return non-JSON; the typed client
                // doesn't use them, so anything non-JSON here is unexpected.
                throw new Error(`Instantly returned non-JSON response from ${path}: ${ct}`);
            }
            return (await res.json()) as T;
        } catch (err: any) {
            // Re-throw typed errors immediately (don't retry auth or 402)
            if (err instanceof InstantlyAuthError || err instanceof InstantlyPaymentRequiredError) {
                throw err;
            }
            // Network errors get the same exponential treatment as 5xx
            lastError = err;
            if (attempt === MAX_RETRIES) throw err;
            const wait = 1000 * Math.pow(2, attempt - 1);
            logger.warn(`[${LOG_TAG}] network retry`, { attempt, waitMs: wait, path, error: err?.message });
            await sleep(wait);
        }
    }

    throw lastError || new Error('Instantly request failed after retries');
}

// ─────────────────────────────────────────────────────────────────────────────
// Generic cursor helper for GET-style cursor lists
// ─────────────────────────────────────────────────────────────────────────────

async function* paginate<T>(
    apiKey: string,
    path: string,
    extraQuery: Record<string, string | number | boolean | undefined> = {},
): AsyncGenerator<T, void, unknown> {
    let cursor: string | undefined;
    while (true) {
        const env = await request<CursorEnvelope<T>>(apiKey, path, {
            query: { ...extraQuery, limit: PAGE_SIZE, starting_after: cursor },
        });
        for (const it of env.items || []) yield it;
        if (!env.next_starting_after) return;
        cursor = env.next_starting_after;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public surface — one function per import-relevant endpoint
// ─────────────────────────────────────────────────────────────────────────────

/** Validates the API key and returns the workspace metadata. */
export async function getCurrentWorkspace(apiKey: string): Promise<InstantlyWorkspace> {
    return request<InstantlyWorkspace>(apiKey, '/workspaces/current');
}

export async function* listCampaigns(apiKey: string): AsyncGenerator<InstantlyCampaign, void, unknown> {
    yield* paginate<InstantlyCampaign>(apiKey, '/campaigns');
}

/** Full campaign with sequences + variants. */
export async function getCampaign(apiKey: string, campaignId: string): Promise<InstantlyCampaign> {
    return request<InstantlyCampaign>(apiKey, `/campaigns/${encodeURIComponent(campaignId)}`);
}

/**
 * Leads list — POST endpoint with filters + cursor in the body.
 * Yields one lead at a time; caller can short-circuit.
 */
export async function* listLeads(
    apiKey: string,
    filters: {
        campaign?: string;
        list_id?: string;
        status_filter?: string;     // e.g. 'Active', 'Bounced'
        search?: string;
    } = {},
): AsyncGenerator<InstantlyLead, void, unknown> {
    let cursor: string | undefined;
    while (true) {
        const env = await request<CursorEnvelope<InstantlyLead>>(apiKey, '/leads/list', {
            method: 'POST',
            body: {
                limit: PAGE_SIZE,
                starting_after: cursor,
                ...(filters.campaign ? { campaign: filters.campaign } : {}),
                ...(filters.list_id ? { list_id: filters.list_id } : {}),
                ...(filters.status_filter ? { filter: filters.status_filter } : {}),
                ...(filters.search ? { search: filters.search } : {}),
            },
        });
        for (const lead of env.items || []) yield lead;
        if (!env.next_starting_after) return;
        cursor = env.next_starting_after;
    }
}

/**
 * Accounts list — same cursor mechanic as the rest of the API even though
 * the cursor format is compound (`timestamp_created&email`). Opaque to us.
 */
export async function* listAccounts(apiKey: string): AsyncGenerator<InstantlyAccount, void, unknown> {
    yield* paginate<InstantlyAccount>(apiKey, '/accounts');
}

/** Per-mailbox list of campaigns it's attached to. */
export async function* listAccountCampaignMappings(
    apiKey: string,
    email: string,
): AsyncGenerator<InstantlyAccountCampaignMapping, void, unknown> {
    yield* paginate<InstantlyAccountCampaignMapping>(
        apiKey,
        `/account-campaign-mappings/${encodeURIComponent(email)}`,
    );
}

export async function* listCustomTags(apiKey: string): AsyncGenerator<InstantlyCustomTag, void, unknown> {
    yield* paginate<InstantlyCustomTag>(apiKey, '/custom-tags');
}

export async function* listLeadLabels(apiKey: string): AsyncGenerator<InstantlyLeadLabel, void, unknown> {
    yield* paginate<InstantlyLeadLabel>(apiKey, '/lead-labels');
}

export async function* listBlockListEntries(apiKey: string): AsyncGenerator<InstantlyBlockListEntry, void, unknown> {
    yield* paginate<InstantlyBlockListEntry>(apiKey, '/block-lists-entries');
}

/** Aggregate analytics for one or many campaigns. */
export async function getCampaignAnalytics(
    apiKey: string,
    opts: { id?: string; ids?: string[]; start_date?: string; end_date?: string } = {},
): Promise<InstantlyCampaignAnalytics[]> {
    const query: Record<string, string> = {};
    if (opts.id) query.id = opts.id;
    if (opts.ids?.length) query.ids = opts.ids.join(',');
    if (opts.start_date) query.start_date = opts.start_date;
    if (opts.end_date) query.end_date = opts.end_date;
    const res = await request<unknown>(apiKey, '/campaigns/analytics', { query });
    // The endpoint returns an array per docs; tolerate object responses too.
    if (Array.isArray(res)) return res as InstantlyCampaignAnalytics[];
    return [res as InstantlyCampaignAnalytics];
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers for callers (status enum mapping kept here so it stays beside the
// type definition).
// ─────────────────────────────────────────────────────────────────────────────

export function mapCampaignStatus(s: InstantlyCampaignStatus | undefined): 'draft' | 'active' | 'paused' | 'completed' | 'archived' {
    switch (s) {
        case 1: return 'active';
        case 2: return 'paused';
        case 3: return 'completed';
        case 4: return 'active';     // Running Subsequences — treat as active
        case -1:                      // Accounts Unhealthy — paused under the hood
        case -2:                      // Bounce Protect
        case -99:                     // Account Suspended
            return 'paused';
        case 0:
        default:
            return 'draft';
    }
}

export function mapLeadStatus(
    s: InstantlyLeadStatus | undefined,
): 'active' | 'paused' | 'replied' | 'bounced' | 'unsubscribed' | 'completed' {
    switch (s) {
        case 'Active':       return 'active';
        case 'Paused':       return 'paused';
        case 'Completed':    return 'completed';
        case 'Bounced':      return 'bounced';
        case 'Unsubscribed': return 'unsubscribed';
        case 'Skipped':      return 'paused';
        default:             return 'active';
    }
}

/**
 * Provider code → our internal provider tag. Unknown codes fall back to 'smtp'
 * so we don't crash on Instantly adding a new provider mid-import.
 */
export function mapProviderCode(code: number | undefined): 'google' | 'microsoft' | 'smtp' {
    switch (code) {
        case 2: return 'google';
        case 3: return 'microsoft';
        case 1:
        default: return 'smtp';
    }
}
