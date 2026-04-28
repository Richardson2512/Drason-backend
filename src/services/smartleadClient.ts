/**
 * Smartlead API Client
 *
 * Read-only HTTP wrapper for Smartlead's v1 REST API. Used exclusively by the
 * one-time import flow to fetch campaigns, sequences, leads, mailboxes and
 * warmup stats from a customer's existing Smartlead workspace.
 *
 * Endpoint inventory and field names verified against api.smartlead.ai —
 * see docs/middleware-removal/17-smartlead-import-api-reference.md for the
 * full mapping and known gaps. Every type below mirrors a documented field;
 * we never invent shapes.
 *
 * Rate limits (per docs/guides/rate-limits):
 *   Standard tier — 60 req/min, 1000 req/hour, 10 req/sec burst
 *   We respect Retry-After unconditionally and exponentially back off on
 *   5xx (1s, 2s, 4s, 8s, 16s with ±20% jitter).
 *
 * The plaintext API key never leaves this module's call sites — callers pass
 * it in via `apiKey` and we drop it into the query string for each request.
 */

import { logger } from './observabilityService';

const BASE_URL = 'https://server.smartlead.ai/api/v1';
const MAX_RETRIES = 5;
const PAGE_SIZE = 100;             // Default + max for most list endpoints
const STATS_PAGE_SIZE = 1000;      // Statistics endpoint allows up to 1000

// ─────────────────────────────────────────────────────────────────────────────
// Typed responses (one block per endpoint family)
// ─────────────────────────────────────────────────────────────────────────────

export interface SmartleadCampaign {
    id: number;
    user_id: number;
    name: string;
    status: 'ACTIVE' | 'PAUSED' | 'STOPPED' | 'ARCHIVED' | 'DRAFTED';
    created_at: string;
    updated_at: string;
    track_settings: Array<'DONT_EMAIL_OPEN' | 'DONT_LINK_CLICK'>;
    scheduler_cron_value: {
        tz: string;
        days: number[];
        startHour: string;     // "HH:MM"
        endHour: string;
    };
    min_time_btwn_emails: number;  // minutes
    max_leads_per_day: number;
    stop_lead_settings: 'REPLY_TO_AN_EMAIL' | 'OPENED_EMAIL' | 'CLICKED_LINK' | 'NEVER';
    schedule_start_time: string | null;
    enable_ai_esp_matching: boolean;
    send_as_plain_text: boolean;
    follow_up_percentage: number;
    unsubscribe_text: string;
    parent_campaign_id: number | null;
    client_id: number | null;
}

export interface SmartleadCampaignDetail extends SmartleadCampaign {
    sending_limit: number;
    total_leads: number;
    leads_contacted: number;
    leads_replied: number;
}

export interface SmartleadSequenceStep {
    id: number;
    created_at: string;
    updated_at: string;
    email_campaign_id: number;
    seq_number: number;
    subject: string;
    email_body: string;
    seq_delay_details: { delayInDays: number };
    sequence_variants: SmartleadSequenceVariant[];
}

export interface SmartleadSequenceVariant {
    id: number;
    variant_name: string;
    subject: string;
    email_body: string;
}

export interface SmartleadCampaignMailbox {
    id: number;
    from_email: string;
    from_name: string;
    type: 'GMAIL' | 'OUTLOOK' | 'SMTP';
    warmup_enabled?: boolean;
    warmup_reputation?: number;
}

export interface SmartleadLead {
    id: number;
    email: string;
    first_name: string | null;
    last_name: string | null;
    company_name: string | null;
    status: 'STARTED' | 'INPROGRESS' | 'COMPLETED' | 'PAUSED' | 'STOPPED';
    category_id: number | null;
    category_name: string | null;
    created_at: string;
    last_sent_time: string | null;
    email_stats: {
        opened?: boolean;
        clicked?: boolean;
        replied?: boolean;
        bounced?: boolean;
    };
    custom_fields: Record<string, unknown>;
}

export interface SmartleadEmailAccount {
    // Identity
    id: number;
    from_name: string;
    from_email: string;
    username: string;
    type: 'GMAIL' | 'OUTLOOK' | 'SMTP';
    client_id: number | null;
    campaign_count: number;
    created_at: string;
    updated_at: string;

    // Sending config
    message_per_day: number;
    daily_sent_count: number;
    signature: string | null;
    custom_tracking_domain: string | null;
    bcc_email: string | null;
    different_reply_to_address: string | null;
    minTimeToWaitInMins: number | null;

    // SMTP/IMAP transport (we ignore credentials; only success flags matter for diagnostics)
    is_smtp_success: boolean;
    is_imap_success: boolean;
    smtp_failure_error: string | null;
    imap_failure_error: string | null;

    // Inline warmup snapshot
    status?: 'ACTIVE' | 'INACTIVE' | 'PAUSED';
    total_sent_count?: number;
    total_spam_count?: number;
    warmup_reputation?: number;
    warmup_key_id?: number;
    warmup_created_at?: string;
    reply_rate?: number;
    blocked_reason?: string | null;
}

export interface SmartleadWarmupStats {
    total_sent: number;
    spam_count: number;
    reputation_score: number;       // 0-100
    daily_stats: Array<{
        date: string;                // YYYY-MM-DD
        sent: number;
        spam: number;
        delivered: number;
        opened: number;
        replied: number;
    }>;
}

export interface SmartleadCampaignStatistics {
    campaign_id: number;
    total_leads: number;
    contacted: number;
    opened: number;
    clicked: number;
    replied: number;
    bounced: number;
    unsubscribed: number;
    open_rate: number;
    click_rate: number;
    reply_rate: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP transport with retry/backoff
// ─────────────────────────────────────────────────────────────────────────────

class SmartleadHttpError extends Error {
    constructor(
        public readonly status: number,
        public readonly path: string,
        public readonly body: string,
    ) {
        super(`Smartlead ${status} on ${path}: ${body.slice(0, 200)}`);
        this.name = 'SmartleadHttpError';
    }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const jitteredBackoff = (attempt: number): number => {
    const base = Math.min(16000, 1000 * Math.pow(2, attempt));   // 1s, 2s, 4s, 8s, 16s
    const jitter = base * 0.2 * (Math.random() - 0.5) * 2;       // ±20%
    return Math.max(250, Math.floor(base + jitter));
};

interface RequestArgs {
    method?: 'GET' | 'POST' | 'PATCH';
    path: string;                     // e.g. '/campaigns/'
    apiKey: string;
    query?: Record<string, string | number | boolean | undefined>;
    body?: unknown;
}

const buildUrl = (path: string, apiKey: string, query?: RequestArgs['query']): string => {
    const url = new URL(BASE_URL + path);
    url.searchParams.set('api_key', apiKey);
    if (query) {
        for (const [k, v] of Object.entries(query)) {
            if (v === undefined) continue;
            url.searchParams.set(k, String(v));
        }
    }
    return url.toString();
};

const redactKey = (url: string): string =>
    url.replace(/api_key=[^&]+/, 'api_key=REDACTED');

/**
 * Core request function. Handles 429 (Retry-After) + 5xx (exponential backoff).
 * Throws SmartleadHttpError on terminal failures (4xx that aren't 429, or
 * exhausted retries on 5xx).
 */
async function request<T>(args: RequestArgs): Promise<T> {
    const url = buildUrl(args.path, args.apiKey, args.query);
    const init: RequestInit = {
        method: args.method || 'GET',
        headers: { 'Content-Type': 'application/json' },
    };
    if (args.body !== undefined) init.body = JSON.stringify(args.body);

    let attempt = 0;
    while (true) {
        let response: Response;
        try {
            response = await fetch(url, init);
        } catch (networkErr: any) {
            if (attempt >= MAX_RETRIES) {
                throw new Error(`Smartlead network failure on ${args.path}: ${networkErr.message}`);
            }
            await sleep(jitteredBackoff(attempt++));
            continue;
        }

        if (response.ok) {
            return await response.json() as T;
        }

        const text = await response.text().catch(() => '');

        // 429 — honor Retry-After.
        if (response.status === 429) {
            if (attempt >= MAX_RETRIES) {
                throw new SmartleadHttpError(429, args.path, text);
            }
            const retryAfterHeader = response.headers.get('Retry-After');
            const retryAfterSec = retryAfterHeader ? parseInt(retryAfterHeader, 10) : 30;
            const waitMs = Number.isFinite(retryAfterSec) ? retryAfterSec * 1000 : 30000;
            logger.warn(`[SMARTLEAD] 429 on ${redactKey(url)} — waiting ${waitMs}ms`);
            await sleep(waitMs);
            attempt++;
            continue;
        }

        // 5xx — exponential backoff.
        if (response.status >= 500 && response.status < 600) {
            if (attempt >= MAX_RETRIES) {
                throw new SmartleadHttpError(response.status, args.path, text);
            }
            await sleep(jitteredBackoff(attempt++));
            continue;
        }

        // 4xx terminal — surface to caller.
        throw new SmartleadHttpError(response.status, args.path, text);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Pagination helper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Drain a paginated endpoint by walking offset until a short page returns.
 * `fetchPage` is called with `(offset, limit)` and must return the page array.
 * Hard cap at 200 pages (20k records at PAGE_SIZE=100) to bound runaway loops;
 * if you hit it, log a warning and stop. The import wizard surfaces this.
 */
export async function fetchAllPages<T>(
    fetchPage: (offset: number, limit: number) => Promise<T[]>,
    pageSize: number = PAGE_SIZE,
    maxPages: number = 200,
): Promise<T[]> {
    const all: T[] = [];
    for (let page = 0; page < maxPages; page++) {
        const offset = page * pageSize;
        const items = await fetchPage(offset, pageSize);
        all.push(...items);
        if (items.length < pageSize) return all;
    }
    logger.warn(`[SMARTLEAD] fetchAllPages hit hard cap of ${maxPages} pages; truncated`);
    return all;
}

// ─────────────────────────────────────────────────────────────────────────────
// Endpoint wrappers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate an API key with a single cheap call. Returns true on 200, false on
 * 401. Any other failure throws — we want the wizard to distinguish "bad key"
 * from "Smartlead is down."
 */
export async function validateKey(apiKey: string): Promise<boolean> {
    try {
        await request<SmartleadCampaign[]>({
            path: '/campaigns/',
            apiKey,
            query: { limit: 1 },
        });
        return true;
    } catch (err) {
        if (err instanceof SmartleadHttpError && err.status === 401) return false;
        throw err;
    }
}

/** GET /campaigns/ — returns ALL pages of the campaign list. */
export async function listCampaigns(apiKey: string): Promise<SmartleadCampaign[]> {
    // The list endpoint returns a direct array, not a wrapped object, and the
    // docs don't formally state pagination params for it — but in practice it
    // accepts offset/limit. We still drain in case of large workspaces.
    return fetchAllPages<SmartleadCampaign>(async (offset, limit) => {
        const data = await request<SmartleadCampaign[]>({
            path: '/campaigns/',
            apiKey,
            query: { offset, limit },
        });
        return Array.isArray(data) ? data : [];
    });
}

/** GET /campaigns/{id} — full detail including totals. */
export async function getCampaign(apiKey: string, campaignId: number): Promise<SmartleadCampaignDetail> {
    const res = await request<{ success: boolean; data: SmartleadCampaignDetail }>({
        path: `/campaigns/${campaignId}`,
        apiKey,
    });
    return res.data;
}

/** GET /campaigns/{id}/sequences — sequence steps + A/B variants. */
export async function getCampaignSequences(
    apiKey: string,
    campaignId: number,
): Promise<SmartleadSequenceStep[]> {
    const res = await request<{ success: boolean; data: SmartleadSequenceStep[] }>({
        path: `/campaigns/${campaignId}/sequences`,
        apiKey,
    });
    return res.data || [];
}

/** GET /campaigns/{id}/email-accounts — mailbox pool for a campaign. */
export async function getCampaignMailboxes(
    apiKey: string,
    campaignId: number,
): Promise<SmartleadCampaignMailbox[]> {
    const data = await request<SmartleadCampaignMailbox[] | { data: SmartleadCampaignMailbox[] }>({
        path: `/campaigns/${campaignId}/email-accounts`,
        apiKey,
    });
    return Array.isArray(data) ? data : (data?.data || []);
}

/** GET /campaigns/{id}/leads — drain all pages. */
export async function listCampaignLeads(
    apiKey: string,
    campaignId: number,
): Promise<SmartleadLead[]> {
    return fetchAllPages<SmartleadLead>(async (offset, limit) => {
        const data = await request<{ data?: SmartleadLead[] } | SmartleadLead[]>({
            path: `/campaigns/${campaignId}/leads`,
            apiKey,
            query: { offset, limit },
        });
        if (Array.isArray(data)) return data;
        return data?.data || [];
    });
}

/** GET /campaigns/{id}/statistics — aggregate counters (used for import_baseline). */
export async function getCampaignStatistics(
    apiKey: string,
    campaignId: number,
): Promise<SmartleadCampaignStatistics> {
    const res = await request<{ success: boolean; data: SmartleadCampaignStatistics & { campaign_id?: number } }>({
        path: `/campaigns/${campaignId}/statistics`,
        apiKey,
        query: { limit: STATS_PAGE_SIZE, offset: 0 },
    });
    return res.data;
}

/** GET /email-accounts/ — drain all pages of the org-wide mailbox list. */
export async function listEmailAccounts(apiKey: string): Promise<SmartleadEmailAccount[]> {
    return fetchAllPages<SmartleadEmailAccount>(async (offset, limit) => {
        const data = await request<SmartleadEmailAccount[] | { data: SmartleadEmailAccount[] }>({
            path: '/email-accounts/',
            apiKey,
            query: { offset, limit },
        });
        return Array.isArray(data) ? data : (data?.data || []);
    });
}

/** GET /email-accounts/{id}/warmup-stats — last 7 days only per docs. */
export async function getWarmupStats(
    apiKey: string,
    emailAccountId: number,
): Promise<SmartleadWarmupStats | null> {
    try {
        return await request<SmartleadWarmupStats>({
            path: `/email-accounts/${emailAccountId}/warmup-stats`,
            apiKey,
        });
    } catch (err) {
        // Not every account has warmup enabled — surface as null instead of error.
        if (err instanceof SmartleadHttpError && (err.status === 404 || err.status === 422)) {
            return null;
        }
        throw err;
    }
}

/**
 * Pause a Smartlead campaign. Doc Gap C: docs page says POST, llms.txt index
 * says PATCH. Try POST first, fall back to PATCH on 404/405. Both forms accept
 * `{ status: 'PAUSED' }`. STOPPED is irreversible — we never use it here.
 */
export async function pauseCampaign(apiKey: string, campaignId: number): Promise<void> {
    const path = `/campaigns/${campaignId}/status`;
    const body = { status: 'PAUSED' };

    try {
        await request<unknown>({ method: 'POST', path, apiKey, body });
        return;
    } catch (err) {
        if (err instanceof SmartleadHttpError && (err.status === 404 || err.status === 405)) {
            logger.warn(`[SMARTLEAD] POST /status returned ${err.status}, falling back to PATCH`);
            await request<unknown>({ method: 'PATCH', path, apiKey, body });
            return;
        }
        throw err;
    }
}

/** Re-export the error class so the orchestrator can do typed catches. */
export { SmartleadHttpError };
