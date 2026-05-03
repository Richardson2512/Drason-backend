/**
 * Outreach.io integration types.
 *
 * Outreach uses JSON:API v1 — every payload is shaped as
 *   { data: { type, attributes, relationships, ... } }
 * and lists are
 *   { data: [...], links: { next? }, meta: { count } }
 * We hide that shape in client.ts and surface plain objects here.
 */

export interface OutreachOAuthTokens {
    access_token: string;
    refresh_token: string;
    expires_at: Date;
    scopes?: string[] | null;
}

export interface OutreachAccountInfo {
    /** Outreach user id (whoever authorized the OAuth grant). */
    userId: string;
    /** That user's email — surfaced in the dashboard. */
    userEmail: string;
    /** Outreach org name when discoverable; null otherwise. */
    orgName: string | null;
}

export interface OutreachSequenceSummary {
    id: string;
    name: string;
    enabled: boolean;
    /** Total active prospects in this sequence — useful for the picker. */
    sequenceStateActiveCount: number | null;
    shareType: string | null; // 'private' | 'read_only' | 'shared'
}

export interface OutreachMailboxSummary {
    id: string;
    email: string;
    userId: string | null;
}

export interface OutreachProspectInput {
    email: string;
    firstName?: string | null;
    lastName?: string | null;
    title?: string | null;
    company?: string | null;
    phone?: string | null;
    linkedinUrl?: string | null;
    /** Tags to apply on create — useful for filtering "Source: Superkabe". */
    tags?: string[];
}

export interface OutreachProspectResult {
    id: string;
    /** Whether we created a fresh row or matched an existing one by email. */
    created: boolean;
}

export class OutreachError extends Error {
    constructor(
        message: string,
        public readonly retryable: boolean,
        public readonly providerCode?: string,
        public readonly status?: number,
    ) {
        super(message);
        this.name = 'OutreachError';
    }
}
