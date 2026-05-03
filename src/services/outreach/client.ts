/**
 * Outreach.io REST client.
 *
 * Auth: Bearer access token. On 401, refresh once via the rotated refresh
 * token and bubble the new tokens up to the caller via onTokensRefreshed.
 *
 * Rate limits: Outreach returns 429 with `Retry-After` (seconds). We honor
 * it once per call.
 *
 * JSON:API quirks:
 *   - Every body is wrapped in { data: { type, attributes, relationships } }.
 *   - Every list response is { data: [...], links: { next? }, meta: {...} }.
 *   - Filters use `filter[<field>]=...` query params.
 */

import {
    OUTREACH_API_BASE,
    refreshAccessToken,
} from './oauthService';
import type {
    OutreachAccountInfo,
    OutreachMailboxSummary,
    OutreachOAuthTokens,
    OutreachProspectInput,
    OutreachProspectResult,
    OutreachSequenceSummary,
} from './types';
import { OutreachError } from './types';
import { logger } from '../observabilityService';

interface OutreachClientOpts {
    accessToken: string;
    refreshToken: string;
    onTokensRefreshed?: (tokens: OutreachOAuthTokens) => Promise<void>;
}

export class OutreachClient {
    private accessToken: string;
    private refreshToken: string;
    private onTokensRefreshed?: (tokens: OutreachOAuthTokens) => Promise<void>;

    constructor(opts: OutreachClientOpts) {
        this.accessToken = opts.accessToken;
        this.refreshToken = opts.refreshToken;
        this.onTokensRefreshed = opts.onTokensRefreshed;
    }

    // ── HTTP plumbing ────────────────────────────────────────────────

    private async fetch(
        path: string,
        init: RequestInit = {},
        attempt = 0,
    ): Promise<Response> {
        const url = path.startsWith('http') ? path : `${OUTREACH_API_BASE}${path}`;
        const headers = new Headers(init.headers);
        headers.set('Accept', 'application/vnd.api+json');
        if (init.body && !headers.has('Content-Type')) {
            headers.set('Content-Type', 'application/vnd.api+json');
        }
        headers.set('Authorization', `Bearer ${this.accessToken}`);

        const res = await fetch(url, { ...init, headers });

        // 401 → refresh once
        if (res.status === 401 && attempt === 0) {
            try {
                const fresh = await refreshAccessToken(this.refreshToken);
                this.accessToken = fresh.access_token;
                this.refreshToken = fresh.refresh_token;
                if (this.onTokensRefreshed) await this.onTokensRefreshed(fresh);
            } catch (err) {
                throw new OutreachError(
                    `Outreach token refresh failed: ${(err as Error).message}`,
                    false,
                    'unauthorized',
                    401,
                );
            }
            return this.fetch(path, init, attempt + 1);
        }

        // 429 → honor Retry-After once
        if (res.status === 429 && attempt === 0) {
            const retryAfter = Number(res.headers.get('Retry-After') ?? 5);
            const delayMs = Math.min(Math.max(retryAfter, 1), 30) * 1000;
            logger.warn('[OUTREACH] 429 rate-limit — backing off', { delayMs, path });
            await new Promise(resolve => setTimeout(resolve, delayMs));
            return this.fetch(path, init, attempt + 1);
        }

        return res;
    }

    private async expectJson<T>(res: Response, opName: string): Promise<T> {
        const json = await res.json().catch(() => null);
        if (!res.ok) {
            const detail = (json as any)?.errors?.[0]?.detail
                || (json as any)?.errors?.[0]?.title
                || res.statusText;
            const code = (json as any)?.errors?.[0]?.code;
            const retryable = res.status >= 500 || res.status === 408;
            throw new OutreachError(
                `Outreach ${opName} failed (${res.status}): ${detail}`,
                retryable,
                code,
                res.status,
            );
        }
        return json as T;
    }

    // ── /me — account info ───────────────────────────────────────────

    async whoami(): Promise<OutreachAccountInfo> {
        // Outreach exposes the current user via filter on /users.
        // The access token's owner is the only user matching the
        // `currentUser` filter.
        const res = await this.fetch('/users?filter[currentUser]=true');
        const json = await this.expectJson<any>(res, 'whoami');
        const u = json.data?.[0];
        if (!u) throw new OutreachError('Outreach /users currentUser empty', false, 'no_user');
        return {
            userId: String(u.id),
            userEmail: u.attributes?.email ?? '',
            orgName: u.attributes?.username ?? null,
        };
    }

    // ── Sequences ────────────────────────────────────────────────────

    /**
     * List enabled sequences the current user can add prospects to.
     * Outreach supports filter[shareType]=read_only,shared — but we just
     * return all enabled ones and let the picker show share status.
     */
    async listSequences(opts: {
        cursor?: string | null;
        pageSize?: number;
    } = {}): Promise<{ items: OutreachSequenceSummary[]; nextCursor: string | null }> {
        const url = opts.cursor
            ? opts.cursor
            : `/sequences?filter[enabled]=true&page[size]=${opts.pageSize ?? 100}&sort=-updatedAt`;
        const res = await this.fetch(url);
        const json = await this.expectJson<any>(res, 'listSequences');

        const items: OutreachSequenceSummary[] = (json.data ?? []).map((s: any) => ({
            id: String(s.id),
            name: s.attributes?.name ?? `Sequence ${s.id}`,
            enabled: !!s.attributes?.enabled,
            sequenceStateActiveCount: typeof s.attributes?.sequenceStateActiveCount === 'number'
                ? s.attributes.sequenceStateActiveCount
                : null,
            shareType: s.attributes?.shareType ?? null,
        }));
        const nextCursor = json.links?.next ?? null;
        return { items, nextCursor };
    }

    /**
     * Create a brand-new (empty) sequence. The user fills steps in Outreach.
     */
    async createSequence(opts: {
        name: string;
        shareType?: 'private' | 'read_only' | 'shared';
    }): Promise<OutreachSequenceSummary> {
        const body = {
            data: {
                type: 'sequence',
                attributes: {
                    name: opts.name,
                    shareType: opts.shareType ?? 'shared',
                    sequenceType: 'date', // calendar-based; user can flip to interval in UI
                    enabled: true,
                },
            },
        };
        const res = await this.fetch('/sequences', {
            method: 'POST',
            body: JSON.stringify(body),
        });
        const json = await this.expectJson<any>(res, 'createSequence');
        const s = json.data;
        return {
            id: String(s.id),
            name: s.attributes?.name ?? opts.name,
            enabled: !!s.attributes?.enabled,
            sequenceStateActiveCount: 0,
            shareType: s.attributes?.shareType ?? opts.shareType ?? 'shared',
        };
    }

    // ── Mailboxes ────────────────────────────────────────────────────

    /**
     * Mailboxes the current user can send through. SequenceState requires
     * a mailbox so the picker UX needs to show this list.
     */
    async listOwnedMailboxes(): Promise<OutreachMailboxSummary[]> {
        const res = await this.fetch('/mailboxes?filter[currentUser]=true&page[size]=50');
        const json = await this.expectJson<any>(res, 'listMailboxes');
        return (json.data ?? []).map((m: any) => ({
            id: String(m.id),
            email: m.attributes?.email ?? '',
            userId: m.relationships?.user?.data?.id ? String(m.relationships.user.data.id) : null,
        }));
    }

    // ── Prospects ────────────────────────────────────────────────────

    /**
     * Find a prospect by email. Outreach normalizes emails server-side, so
     * a single filter call returns the canonical match if any.
     */
    async findProspectByEmail(email: string): Promise<{ id: string } | null> {
        const url = `/prospects?filter[emails]=${encodeURIComponent(email)}&page[size]=1`;
        const res = await this.fetch(url);
        const json = await this.expectJson<any>(res, 'findProspect');
        const first = json.data?.[0];
        return first ? { id: String(first.id) } : null;
    }

    /**
     * Upsert a prospect by email. If found, update the fields we have;
     * otherwise create new with our identity tag.
     */
    async upsertProspect(input: OutreachProspectInput): Promise<OutreachProspectResult> {
        const email = input.email.trim().toLowerCase();
        if (!email) throw new OutreachError('Prospect email required', false, 'invalid_email');

        const existing = await this.findProspectByEmail(email);

        const attributes: Record<string, unknown> = {};
        if (input.firstName) attributes.firstName = input.firstName;
        if (input.lastName) attributes.lastName = input.lastName;
        if (input.title) attributes.title = input.title;
        if (input.company) attributes.company = input.company;
        if (input.linkedinUrl) attributes.linkedInUrl = input.linkedinUrl;
        if (input.tags?.length) attributes.tags = input.tags;

        if (!existing) {
            // Outreach requires emails on create as a *typed* array.
            attributes.emails = [email];
            // Phones must use phone-number sub-objects on Prospect.
            // Add only if present, on an existing-prospect path the
            // /prospects/:id/relationships/phoneNumbers endpoint is the
            // proper home — keeping create-only is the simpler v1.
            if (input.phone) {
                attributes.workPhones = [input.phone];
            }
        }

        const body = {
            data: {
                type: 'prospect',
                ...(existing ? { id: existing.id } : {}),
                attributes,
            },
        };

        const path = existing ? `/prospects/${existing.id}` : '/prospects';
        const method = existing ? 'PATCH' : 'POST';
        const res = await this.fetch(path, { method, body: JSON.stringify(body) });
        const json = await this.expectJson<any>(res, existing ? 'updateProspect' : 'createProspect');
        return {
            id: String(json.data?.id ?? existing?.id ?? ''),
            created: !existing,
        };
    }

    // ── SequenceStates — add prospect to sequence ────────────────────

    /**
     * Add a prospect to a sequence under a specific mailbox. Outreach
     * dedupes by (prospect, sequence, mailbox) — re-adding the same
     * prospect to the same sequence + mailbox returns 422 with
     * `code: not_unique`. We treat that as success-already-in.
     */
    async addProspectToSequence(opts: {
        prospectId: string;
        sequenceId: string;
        mailboxId: string;
    }): Promise<{ added: boolean; alreadyIn: boolean }> {
        const body = {
            data: {
                type: 'sequenceState',
                relationships: {
                    prospect: { data: { type: 'prospect', id: opts.prospectId } },
                    sequence: { data: { type: 'sequence', id: opts.sequenceId } },
                    mailbox: { data: { type: 'mailbox', id: opts.mailboxId } },
                },
            },
        };
        const res = await this.fetch('/sequenceStates', {
            method: 'POST',
            body: JSON.stringify(body),
        });
        if (res.status === 422) {
            const json = await res.json().catch(() => ({})) as any;
            const code = json?.errors?.[0]?.code;
            const detail = String(json?.errors?.[0]?.detail || '').toLowerCase();
            if (code === 'not_unique' || detail.includes('already')) {
                return { added: false, alreadyIn: true };
            }
            throw new OutreachError(
                `Outreach addProspectToSequence rejected: ${json?.errors?.[0]?.detail || res.statusText}`,
                false,
                code,
                422,
            );
        }
        await this.expectJson<any>(res, 'addProspectToSequence');
        return { added: true, alreadyIn: false };
    }
}
