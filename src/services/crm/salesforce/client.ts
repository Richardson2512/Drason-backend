/**
 * Salesforce CrmClient implementation.
 *
 * Talks to the org's per-instance REST API at `${instanceUrl}/services/data/{version}/...`.
 * Activity push writes to the standard Task object so timeline display
 * works without an AppExchange listing or custom event template.
 *
 * Uses Bulk API 2.0 indirectly via SOQL pagination — for v1 we rely on
 * SOQL paging through REST (`nextRecordsUrl`); Bulk API graduation lands
 * in Phase 4 if list sizes warrant.
 */

import type {
    CrmActivity,
    CrmActivityEventType,
    CrmClient,
    CrmContact,
    CrmContactFilter,
    CrmFieldDescriptor,
    CrmOAuthTokens,
    CrmPagedContacts,
    CrmProvider,
} from '../types';
import { CrmPushError } from '../types';
import {
    detectEnvFromInstanceUrl,
    exchangeCodeForTokens as exchangeCodeForTokensCore,
    fetchAccountInfo as fetchAccountInfoCore,
    generateAuthUrl as generateAuthUrlCore,
    refreshAccessToken,
    SalesforceLoginEnv,
} from './oauthService';
import { logger } from '../../observabilityService';

const API_VERSION = 'v60.0';

interface ClientOpts {
    accessToken: string;
    refreshToken?: string | null;
    instanceUrl?: string | null;
    env?: SalesforceLoginEnv;
    onTokensRefreshed?: (tokens: CrmOAuthTokens) => Promise<void>;
}

export class SalesforceCrmClient implements CrmClient {
    readonly provider: CrmProvider = 'salesforce';
    private accessToken: string;
    private refreshToken: string | null;
    private instanceUrl: string;
    private env: SalesforceLoginEnv;
    private onTokensRefreshed?: (tokens: CrmOAuthTokens) => Promise<void>;

    constructor(opts: ClientOpts) {
        this.accessToken = opts.accessToken;
        this.refreshToken = opts.refreshToken ?? null;
        if (!opts.instanceUrl) {
            throw new Error('SalesforceCrmClient requires instanceUrl');
        }
        this.instanceUrl = opts.instanceUrl.replace(/\/$/, '');
        this.env = opts.env ?? detectEnvFromInstanceUrl(this.instanceUrl);
        this.onTokensRefreshed = opts.onTokensRefreshed;
    }

    // ── OAuth lifecycle ────────────────────────────────────────────

    generateAuthUrl(opts: { state: string; redirectUri: string; scopes?: string[] }): string {
        return generateAuthUrlCore({
            state: opts.state,
            env: this.env,
            scopes: opts.scopes,
        });
    }

    async exchangeCodeForTokens(opts: { code: string; redirectUri: string }): Promise<CrmOAuthTokens> {
        return exchangeCodeForTokensCore({ code: opts.code, env: this.env });
    }

    async refreshTokens(refreshToken: string): Promise<CrmOAuthTokens> {
        const tokens = await refreshAccessToken({ refreshToken, env: this.env });
        if (tokens.instance_url) this.instanceUrl = tokens.instance_url;
        return tokens;
    }

    async fetchAccountInfo(accessToken: string): Promise<{
        externalAccountId: string;
        externalAccountName: string;
    }> {
        return fetchAccountInfoCore({ accessToken, instanceUrl: this.instanceUrl });
    }

    // ── HTTP plumbing ──────────────────────────────────────────────

    private async sfFetch(path: string, init: RequestInit = {}, attempt = 0): Promise<Response> {
        const url = path.startsWith('http')
            ? path
            : `${this.instanceUrl}/services/data/${API_VERSION}${path}`;
        const headers = new Headers(init.headers);
        headers.set('Authorization', `Bearer ${this.accessToken}`);
        if (init.body && !headers.has('Content-Type')) {
            headers.set('Content-Type', 'application/json');
        }
        const res = await fetch(url, { ...init, headers });

        if (res.status === 401 && attempt === 0 && this.refreshToken) {
            try {
                const fresh = await refreshAccessToken({ refreshToken: this.refreshToken, env: this.env });
                this.accessToken = fresh.access_token;
                if (fresh.refresh_token) this.refreshToken = fresh.refresh_token;
                if (fresh.instance_url) this.instanceUrl = fresh.instance_url;
                if (this.onTokensRefreshed) await this.onTokensRefreshed(fresh);
                return this.sfFetch(path, init, 1);
            } catch (err) {
                logger.warn('[SALESFORCE] refresh failed during 401', { err: String(err) });
                throw new CrmPushError('Salesforce refresh-token failure', false, 'refresh_failed');
            }
        }

        // Salesforce returns 503 + Retry-After when API limits hit.
        if (res.status === 503 && attempt < 2) {
            const ra = Number(res.headers.get('retry-after') || '5') * 1000;
            await new Promise(r => setTimeout(r, Math.min(ra, 30_000)));
            return this.sfFetch(path, init, attempt + 1);
        }

        return res;
    }

    private async expectJson<T>(res: Response, opName: string): Promise<T> {
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            const retryable = res.status >= 500 || res.status === 429;
            throw new CrmPushError(
                `Salesforce ${opName} failed (${res.status}): ${text.slice(0, 300)}`,
                retryable,
                String(res.status),
            );
        }
        return res.json() as Promise<T>;
    }

    // ── Field discovery ────────────────────────────────────────────

    async describeContactFields(): Promise<CrmFieldDescriptor[]> {
        const res = await this.sfFetch('/sobjects/Contact/describe');
        const data = await this.expectJson<{ fields: any[] }>(res, 'describe Contact');
        return data.fields
            .filter(f => f.createable || f.updateable || f.permissionable)
            .map(f => ({
                name: f.name,
                label: f.label,
                type: mapSalesforceType(f.type),
                capability: f.updateable ? 'read_write' : 'read',
            } satisfies CrmFieldDescriptor));
    }

    // ── Contact import (SOQL) ──────────────────────────────────────

    async listContacts(opts: {
        filter: CrmContactFilter;
        cursor: string | null;
        limit?: number;
    }): Promise<CrmPagedContacts> {
        // If a continuation cursor is present, use Salesforce's nextRecordsUrl directly.
        if (opts.cursor) {
            const res = await this.sfFetch(opts.cursor.startsWith('/services/data/')
                ? this.instanceUrl + opts.cursor
                : opts.cursor);
            const data = await this.expectJson<SoqlPage>(res, 'paginate contacts');
            return soqlPageToPaged(data);
        }

        const limit = Math.min(opts.limit ?? 200, 200);
        let soql: string;

        if (opts.filter.kind === 'soql') {
            soql = opts.filter.query;
        } else if (opts.filter.kind === 'view') {
            // Salesforce list views: /sobjects/Contact/listviews/{id}/results
            const viewRes = await this.sfFetch(`/sobjects/Contact/listviews/${opts.filter.viewId}/results?limit=${limit}`);
            const data = await this.expectJson<{
                records: any[];
                done: boolean;
                nextRecordsUrl?: string;
            }>(viewRes, 'list view results');
            return {
                contacts: data.records.map(toCrmContactFromListView),
                nextCursor: data.done ? null : (data.nextRecordsUrl ?? null),
            };
        } else {
            // 'all' or 'list' (HubSpot kind, ignore for SF) — generic SOQL
            soql = `SELECT Id, Email, FirstName, LastName, AccountId, Account.Name, Title, Phone, HasOptedOutOfEmail FROM Contact WHERE Email != NULL ORDER BY CreatedDate DESC LIMIT ${limit}`;
        }

        const params = new URLSearchParams({ q: soql });
        const queryRes = await this.sfFetch(`/query?${params.toString()}`);
        const data = await this.expectJson<SoqlPage>(queryRes, 'query contacts');
        return soqlPageToPaged(data);
    }

    async getContact(externalId: string): Promise<CrmContact | null> {
        const res = await this.sfFetch(`/sobjects/Contact/${encodeURIComponent(externalId)}`);
        if (res.status === 404) return null;
        const data = await this.expectJson<any>(res, 'get Contact');
        return toCrmContactFromRow(data);
    }

    async findContactIdByEmail(email: string): Promise<string | null> {
        const safe = email.replace(/'/g, "\\'");
        const soql = `SELECT Id FROM Contact WHERE Email = '${safe}' LIMIT 1`;
        const res = await this.sfFetch(`/query?q=${encodeURIComponent(soql)}`);
        if (!res.ok) return null;
        const data = await res.json().catch(() => ({})) as any;
        return data?.records?.[0]?.Id ?? null;
    }

    // ── Activity push (Task object) ────────────────────────────────

    async pushActivity(opts: { contactExternalId: string; activity: CrmActivity }): Promise<void> {
        const subject = renderTaskSubject(opts.activity);
        const description = renderTaskDescription(opts.activity);

        const res = await this.sfFetch('/sobjects/Task', {
            method: 'POST',
            body: JSON.stringify({
                Subject: subject.slice(0, 255),
                Description: description.slice(0, 32000),
                Status: 'Completed',
                Priority: 'Normal',
                ActivityDate: opts.activity.occurredAt.toISOString().slice(0, 10),
                WhoId: opts.contactExternalId,
                TaskSubtype: 'Email',
            }),
        });

        if (!res.ok) {
            const text = await res.text().catch(() => '');
            const retryable = res.status >= 500 || res.status === 429;
            throw new CrmPushError(
                `Salesforce pushActivity failed (${res.status}): ${text.slice(0, 300)}`,
                retryable,
                String(res.status),
            );
        }
    }

    // ── Suppression sync ───────────────────────────────────────────

    async listSuppressions(cursor: string | null): Promise<{
        emails: string[];
        nextCursor: string | null;
    }> {
        if (cursor) {
            const res = await this.sfFetch(cursor.startsWith('/services/data/')
                ? this.instanceUrl + cursor
                : cursor);
            const data = await this.expectJson<SoqlPage>(res, 'paginate suppressions');
            return {
                emails: (data.records ?? [])
                    .map(r => r.Email)
                    .filter((e: any): e is string => typeof e === 'string' && e.length > 0)
                    .map((e: string) => e.toLowerCase()),
                nextCursor: data.done ? null : (data.nextRecordsUrl ?? null),
            };
        }
        const soql = `SELECT Email FROM Contact WHERE HasOptedOutOfEmail = true AND Email != NULL ORDER BY CreatedDate DESC LIMIT 200`;
        const res = await this.sfFetch(`/query?q=${encodeURIComponent(soql)}`);
        const data = await this.expectJson<SoqlPage>(res, 'list suppressions');
        return {
            emails: (data.records ?? [])
                .map(r => r.Email)
                .filter((e: any): e is string => typeof e === 'string' && e.length > 0)
                .map((e: string) => e.toLowerCase()),
            nextCursor: data.done ? null : (data.nextRecordsUrl ?? null),
        };
    }
}

// ── helpers ────────────────────────────────────────────────────────

interface SoqlPage {
    records: any[];
    done: boolean;
    nextRecordsUrl?: string;
    totalSize?: number;
}

function soqlPageToPaged(data: SoqlPage): CrmPagedContacts {
    return {
        contacts: (data.records ?? []).map(toCrmContactFromRow),
        nextCursor: data.done ? null : (data.nextRecordsUrl ?? null),
        totalCount: typeof data.totalSize === 'number' ? data.totalSize : null,
    };
}

function toCrmContactFromRow(r: any): CrmContact {
    return {
        externalId: String(r?.Id ?? ''),
        email: String(r?.Email ?? '').toLowerCase(),
        firstName: r?.FirstName || undefined,
        lastName: r?.LastName || undefined,
        fullName: r?.Name || [r?.FirstName, r?.LastName].filter(Boolean).join(' ') || undefined,
        company: r?.Account?.Name || r?.AccountName || undefined,
        title: r?.Title || undefined,
        phone: r?.Phone || undefined,
        customFields: r,
        optedOut: r?.HasOptedOutOfEmail === true,
    };
}

function toCrmContactFromListView(r: any): CrmContact {
    // List-view rows come back as { Id, columns: [{ fieldNameOrPath, value }] }
    const cols = Array.isArray(r?.columns) ? r.columns : [];
    const get = (path: string) => cols.find((c: any) => c.fieldNameOrPath === path)?.value ?? null;
    return {
        externalId: String(r?.Id ?? get('Id') ?? ''),
        email: String(get('Email') ?? '').toLowerCase(),
        firstName: get('FirstName') || undefined,
        lastName: get('LastName') || undefined,
        fullName: get('Name') || [get('FirstName'), get('LastName')].filter(Boolean).join(' ') || undefined,
        company: get('Account.Name') || get('AccountName') || undefined,
        title: get('Title') || undefined,
        phone: get('Phone') || undefined,
        customFields: Object.fromEntries(cols.map((c: any) => [c.fieldNameOrPath, c.value])),
        optedOut: get('HasOptedOutOfEmail') === true,
    };
}

function mapSalesforceType(t: string | undefined): CrmFieldDescriptor['type'] {
    switch (t) {
        case 'string':
        case 'textarea':
        case 'phone':
        case 'email':
        case 'url':
        case 'reference':
        case 'id': return 'string';
        case 'int':
        case 'double':
        case 'currency':
        case 'percent': return 'number';
        case 'boolean': return 'boolean';
        case 'date':
        case 'datetime': return 'date';
        case 'picklist':
        case 'multipicklist': return 'enum';
        default: return 'unknown';
    }
}

const SUBJECT: Record<CrmActivityEventType, string> = {
    'email.sent':    'Superkabe — Email sent',
    'email.opened':  'Superkabe — Email opened',
    'email.clicked': 'Superkabe — Link clicked',
    'email.replied': 'Superkabe — Reply received',
    'email.bounced': 'Superkabe — Email bounced',
};

function renderTaskSubject(a: CrmActivity): string {
    const base = SUBJECT[a.type] ?? `Superkabe activity: ${a.type}`;
    return a.subject ? `${base}: ${a.subject}` : base;
}

function renderTaskDescription(a: CrmActivity): string {
    const lines: string[] = [];
    if (a.subject) lines.push(`Subject: ${a.subject}`);
    if (a.body) lines.push('', a.body);
    if (a.metadata) {
        const entries = Object.entries(a.metadata)
            .filter(([, v]) => v !== null && v !== undefined && v !== '')
            .slice(0, 12);
        if (entries.length) {
            lines.push('', '— Context —');
            for (const [k, v] of entries) lines.push(`${k}: ${String(v)}`);
        }
    }
    lines.push('', `via Superkabe at ${a.occurredAt.toISOString()}`);
    return lines.join('\n');
}
