/**
 * HubSpot CrmClient implementation.
 *
 * Wraps the HubSpot v3 REST API behind the provider-blind CrmClient
 * interface. All HTTP calls go through `hubspotFetch` which:
 *   - retries once on 429 honoring `Retry-After`
 *   - refreshes the access token on 401 if a refresh callback is set
 *   - throws CrmPushError with a retryable flag so the worker can
 *     decide between immediate and delayed re-attempt
 */

import {
    CrmActivity,
    CrmActivityEventType,
    CrmClient,
    CrmContact,
    CrmContactFilter,
    CrmFieldDescriptor,
    CrmOAuthTokens,
    CrmPagedContacts,
    CrmPushError,
    CrmProvider,
} from '../types';
import {
    exchangeCodeForTokens,
    fetchAccountInfo as fetchAccountInfoCore,
    generateAuthUrl as generateAuthUrlCore,
    HUBSPOT_API,
    HUBSPOT_DEFAULT_SCOPES,
    refreshAccessToken,
} from './oauthService';
import { logger } from '../../observabilityService';

interface ClientOpts {
    accessToken: string;
    refreshToken?: string | null;
    onTokensRefreshed?: (tokens: CrmOAuthTokens) => Promise<void>;
}

export class HubSpotCrmClient implements CrmClient {
    readonly provider: CrmProvider = 'hubspot';
    private accessToken: string;
    private refreshToken: string | null;
    private onTokensRefreshed?: (tokens: CrmOAuthTokens) => Promise<void>;

    constructor(opts: ClientOpts) {
        this.accessToken = opts.accessToken;
        this.refreshToken = opts.refreshToken ?? null;
        this.onTokensRefreshed = opts.onTokensRefreshed;
    }

    // ── OAuth lifecycle (factory uses these statically - instance methods just delegate) ──

    generateAuthUrl(opts: { state: string; redirectUri: string; scopes?: string[] }): string {
        // HubSpot's redirect_uri must match what's registered on the dev app, so
        // we ignore opts.redirectUri here - the env var is the source of truth.
        return generateAuthUrlCore({ state: opts.state, scopes: opts.scopes ?? HUBSPOT_DEFAULT_SCOPES });
    }

    async exchangeCodeForTokens(opts: { code: string; redirectUri: string }): Promise<CrmOAuthTokens> {
        return exchangeCodeForTokens(opts.code);
    }

    async refreshTokens(refreshToken: string): Promise<CrmOAuthTokens> {
        return refreshAccessToken(refreshToken);
    }

    async fetchAccountInfo(accessToken: string): Promise<{
        externalAccountId: string;
        externalAccountName: string;
    }> {
        return fetchAccountInfoCore(accessToken);
    }

    // ── HTTP plumbing ──────────────────────────────────────────────

    private async hubspotFetch(path: string, init: RequestInit = {}, attempt = 0): Promise<Response> {
        const url = path.startsWith('http') ? path : `${HUBSPOT_API.base}${path}`;
        const headers = new Headers(init.headers);
        headers.set('Authorization', `Bearer ${this.accessToken}`);
        if (init.body && !headers.has('Content-Type')) {
            headers.set('Content-Type', 'application/json');
        }

        const res = await fetch(url, { ...init, headers });

        // 401 → try refresh once
        if (res.status === 401 && attempt === 0 && this.refreshToken) {
            try {
                const fresh = await refreshAccessToken(this.refreshToken);
                this.accessToken = fresh.access_token;
                if (fresh.refresh_token) this.refreshToken = fresh.refresh_token;
                if (this.onTokensRefreshed) await this.onTokensRefreshed(fresh);
                return this.hubspotFetch(path, init, 1);
            } catch (refreshErr) {
                logger.warn('[HUBSPOT] refresh failed during 401 retry', { err: String(refreshErr) });
                throw new CrmPushError('HubSpot refresh-token failure', false, 'refresh_failed');
            }
        }

        // 429 → honor Retry-After once
        if (res.status === 429 && attempt < 2) {
            const retryAfter = Number(res.headers.get('retry-after') || '5') * 1000;
            await new Promise(r => setTimeout(r, Math.min(retryAfter, 30_000)));
            return this.hubspotFetch(path, init, attempt + 1);
        }

        return res;
    }

    private async expectJson<T>(res: Response, opName: string): Promise<T> {
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            const retryable = res.status >= 500 || res.status === 429;
            throw new CrmPushError(
                `HubSpot ${opName} failed (${res.status}): ${text.slice(0, 300)}`,
                retryable,
                String(res.status),
            );
        }
        return res.json() as Promise<T>;
    }

    // ── Field discovery ────────────────────────────────────────────

    async describeContactFields(): Promise<CrmFieldDescriptor[]> {
        const res = await this.hubspotFetch('/crm/v3/properties/contacts');
        const data = await this.expectJson<{ results: any[] }>(res, 'describe contacts');
        return data.results
            .filter(p => !p.calculated)
            .map(p => ({
                name: p.name,
                label: p.label || p.name,
                type: mapHubSpotType(p.type),
                capability: p.modificationMetadata?.readOnlyValue ? 'read' : 'read_write',
            } satisfies CrmFieldDescriptor));
    }

    // ── Contact import ─────────────────────────────────────────────

    async listContacts(opts: {
        filter: CrmContactFilter;
        cursor: string | null;
        limit?: number;
    }): Promise<CrmPagedContacts> {
        const limit = Math.min(opts.limit ?? 100, 100);
        const properties = ['email', 'firstname', 'lastname', 'company', 'jobtitle', 'phone'];

        if (opts.filter.kind === 'list') {
            // V3 lists API: GET /crm/v3/lists/{id}/memberships → ids → batch read
            const url = new URL(`${HUBSPOT_API.base}/crm/v3/lists/${opts.filter.listId}/memberships`);
            url.searchParams.set('limit', String(limit));
            if (opts.cursor) url.searchParams.set('after', opts.cursor);

            const memRes = await this.hubspotFetch(url.toString());
            const mem = await this.expectJson<{
                results: Array<{ recordId: string }>;
                paging?: { next?: { after: string } };
            }>(memRes, 'list memberships');

            if (mem.results.length === 0) {
                return { contacts: [], nextCursor: null };
            }

            const batchRes = await this.hubspotFetch('/crm/v3/objects/contacts/batch/read', {
                method: 'POST',
                body: JSON.stringify({
                    properties,
                    inputs: mem.results.map(r => ({ id: r.recordId })),
                }),
            });
            const batch = await this.expectJson<{ results: any[] }>(batchRes, 'batch read contacts');

            return {
                contacts: batch.results.map(toCrmContact),
                nextCursor: mem.paging?.next?.after ?? null,
            };
        }

        // 'all' - straight contacts list
        const url = new URL(`${HUBSPOT_API.base}/crm/v3/objects/contacts`);
        url.searchParams.set('limit', String(limit));
        url.searchParams.set('properties', properties.join(','));
        if (opts.cursor) url.searchParams.set('after', opts.cursor);

        const res = await this.hubspotFetch(url.toString());
        const data = await this.expectJson<{
            results: any[];
            paging?: { next?: { after: string } };
        }>(res, 'list contacts');

        return {
            contacts: data.results.map(toCrmContact),
            nextCursor: data.paging?.next?.after ?? null,
        };
    }

    async getContact(externalId: string): Promise<CrmContact | null> {
        const url = new URL(`${HUBSPOT_API.base}/crm/v3/objects/contacts/${encodeURIComponent(externalId)}`);
        url.searchParams.set('properties', 'email,firstname,lastname,company,jobtitle,phone');

        const res = await this.hubspotFetch(url.toString());
        if (res.status === 404) return null;
        const data = await this.expectJson<any>(res, 'get contact');
        return toCrmContact(data);
    }

    async findContactIdByEmail(email: string): Promise<string | null> {
        const res = await this.hubspotFetch('/crm/v3/objects/contacts/search', {
            method: 'POST',
            body: JSON.stringify({
                filterGroups: [
                    {
                        filters: [{ propertyName: 'email', operator: 'EQ', value: email.toLowerCase() }],
                    },
                ],
                limit: 1,
                properties: ['email'],
            }),
        });

        if (!res.ok) {
            // Treat search 404/4xx as "no match" rather than throwing.
            return null;
        }

        const data = await res.json().catch(() => ({})) as any;
        const first = Array.isArray(data?.results) ? data.results[0] : null;
        return first?.id ? String(first.id) : null;
    }

    // ── Activity push (timeline event) ─────────────────────────────

    async pushActivity(opts: { contactExternalId: string; activity: CrmActivity }): Promise<void> {
        // HubSpot's "Engagements v3" Notes API is the simplest way to add
        // contact-timeline activity from a third-party app without
        // pre-creating a custom event template. For Phase 2 we use Notes
        // with a structured body; Phase 4 can graduate to the proper
        // timeline-events API once we register an event template.
        const res = await this.hubspotFetch('/crm/v3/objects/notes', {
            method: 'POST',
            body: JSON.stringify({
                properties: {
                    hs_note_body: renderActivityBody(opts.activity),
                    hs_timestamp: opts.activity.occurredAt.toISOString(),
                },
                associations: [
                    {
                        to: { id: opts.contactExternalId },
                        types: [{
                            associationCategory: 'HUBSPOT_DEFINED',
                            associationTypeId: 202, // note → contact
                        }],
                    },
                ],
            }),
        });

        if (!res.ok) {
            const text = await res.text().catch(() => '');
            const retryable = res.status >= 500 || res.status === 429 || res.status === 408;
            throw new CrmPushError(
                `HubSpot pushActivity failed (${res.status}): ${text.slice(0, 300)}`,
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
        // Communications-preferences endpoint exposes contact-level opt-outs
        // via the contact property `hs_email_optout`. We page contacts where
        // that property is true.
        const url = new URL(`${HUBSPOT_API.base}/crm/v3/objects/contacts/search`);
        const body = {
            filterGroups: [{
                filters: [
                    { propertyName: 'hs_email_optout', operator: 'EQ', value: 'true' },
                ],
            }],
            properties: ['email'],
            limit: 100,
            after: cursor || undefined,
        };
        const res = await this.hubspotFetch(url.toString(), {
            method: 'POST',
            body: JSON.stringify(body),
        });
        const data = await this.expectJson<{
            results: any[];
            paging?: { next?: { after: string } };
        }>(res, 'list suppressions');

        return {
            emails: data.results
                .map(r => r?.properties?.email)
                .filter((e): e is string => typeof e === 'string' && e.length > 0)
                .map(e => e.toLowerCase()),
            nextCursor: data.paging?.next?.after ?? null,
        };
    }
}

// ── helpers ────────────────────────────────────────────────────────

function toCrmContact(record: any): CrmContact {
    const p = record?.properties ?? {};
    return {
        externalId: String(record?.id ?? ''),
        email: String(p.email ?? '').toLowerCase(),
        firstName: p.firstname || undefined,
        lastName: p.lastname || undefined,
        fullName: [p.firstname, p.lastname].filter(Boolean).join(' ') || undefined,
        company: p.company || undefined,
        title: p.jobtitle || undefined,
        phone: p.phone || undefined,
        customFields: p,
        optedOut: p.hs_email_optout === 'true',
    };
}

function mapHubSpotType(t: string | undefined): CrmFieldDescriptor['type'] {
    switch (t) {
        case 'string': return 'string';
        case 'number': return 'number';
        case 'bool': return 'boolean';
        case 'date':
        case 'datetime': return 'date';
        case 'enumeration': return 'enum';
        default: return 'unknown';
    }
}

function renderActivityBody(a: CrmActivity): string {
    const headline = ACTIVITY_HEADLINES[a.type] ?? `Superkabe activity: ${a.type}`;
    const lines: string[] = [`<p><strong>${headline}</strong></p>`];
    if (a.subject) lines.push(`<p><em>Subject:</em> ${escapeHtml(a.subject)}</p>`);
    if (a.body) lines.push(`<blockquote>${escapeHtml(a.body).slice(0, 1000)}</blockquote>`);
    if (a.metadata) {
        const entries = Object.entries(a.metadata)
            .filter(([, v]) => v !== null && v !== undefined && v !== '')
            .slice(0, 8); // keep the timeline tidy
        if (entries.length) {
            lines.push('<ul>' + entries.map(([k, v]) => `<li>${escapeHtml(k)}: ${escapeHtml(String(v))}</li>`).join('') + '</ul>');
        }
    }
    lines.push(`<p style="font-size:11px;color:#888;">via Superkabe · ${a.occurredAt.toISOString()}</p>`);
    return lines.join('');
}

const ACTIVITY_HEADLINES: Record<CrmActivityEventType, string> = {
    'email.sent':    '📤 Superkabe sent an email',
    'email.opened':  '👀 Recipient opened a Superkabe email',
    'email.clicked': '🔗 Recipient clicked a link in a Superkabe email',
    'email.replied': '💬 Recipient replied to a Superkabe email',
    'email.bounced': '⛔ Superkabe email bounced',
};

function escapeHtml(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
