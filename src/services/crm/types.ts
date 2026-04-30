/**
 * CRM integration foundation types — Phase 1.
 *
 * Provider-agnostic interface that HubSpot and Salesforce clients
 * implement in Phase 2 / Phase 3. Connection lifecycle, contact import,
 * activity push, and field discovery all flow through these shapes so
 * the controllers, the dashboard, and the activity-push worker stay
 * provider-blind.
 */

/** All supported CRM providers. Keep narrow on purpose. */
export type CrmProvider = 'hubspot' | 'salesforce';

/** Connection status — mirrors what the dashboard renders. */
export type CrmConnectionStatus = 'active' | 'error' | 'expired' | 'disconnected';

/** Outbound event types we push to CRMs. Subset of webhook-bus events. */
export type CrmActivityEventType =
    | 'email.sent'
    | 'email.opened'
    | 'email.clicked'
    | 'email.replied'
    | 'email.bounced';

/** OAuth-token blob returned by code exchange + refresh. */
export interface CrmOAuthTokens {
    access_token: string;
    refresh_token?: string | null;
    expires_at?: Date | null;
    scopes?: string[];
    /** Provider-specific extras: Salesforce instance_url, HubSpot portal_id, etc. */
    extra?: Record<string, unknown>;
}

/** A CRM contact normalized to Superkabe's lead vocabulary. */
export interface CrmContact {
    /** Provider-side ID (e.g. HubSpot `vid`, Salesforce `Id`). Required. */
    externalId: string;
    email: string;
    firstName?: string;
    lastName?: string;
    fullName?: string;
    company?: string;
    title?: string;
    phone?: string;
    /** Anything we couldn't fold into the canonical fields above. */
    customFields?: Record<string, unknown>;
    /** True if the CRM marks this contact as opted-out / DNC. */
    optedOut?: boolean;
}

/** A pushable activity — written to the CRM contact's timeline / Task. */
export interface CrmActivity {
    type: CrmActivityEventType;
    occurredAt: Date;
    subject?: string;
    body?: string;
    /** Free-form provider context, e.g. campaign_id, message_id, link URL. */
    metadata?: Record<string, unknown>;
}

/** A field exposed by the CRM, surfaced in the field-mapping UI. */
export interface CrmFieldDescriptor {
    /** API-side identifier (HubSpot internal name, Salesforce field API name). */
    name: string;
    /** Human label for the dashboard. */
    label: string;
    type: 'string' | 'number' | 'boolean' | 'date' | 'enum' | 'unknown';
    /** Read/write hint used to enable/disable mapping directions. */
    capability: 'read' | 'write' | 'read_write';
}

/** Filter applied to a contact-import sync job. */
export type CrmContactFilter =
    | { kind: 'list'; listId: string }
    | { kind: 'view'; viewId: string }
    | { kind: 'soql'; query: string }   // Salesforce-only
    | { kind: 'all' };

/** Paginated result from listContacts. Cursor is opaque per provider. */
export interface CrmPagedContacts {
    contacts: CrmContact[];
    nextCursor: string | null;
    /** Best-effort total — may be null for providers that don't report it. */
    totalCount?: number | null;
}

/** Reason a single push failed; surfaced on CrmActivityPushItem.last_error. */
export class CrmPushError extends Error {
    constructor(
        message: string,
        public readonly retryable: boolean,
        public readonly providerCode?: string,
    ) {
        super(message);
        this.name = 'CrmPushError';
    }
}

/**
 * The provider-blind interface every CRM client implements.
 *
 * Constructor-time concerns (per-org auth, base URLs, instance_url) are
 * captured by the implementation; this interface is what consumers call.
 */
export interface CrmClient {
    readonly provider: CrmProvider;

    // ── OAuth lifecycle ──────────────────────────────────────────────
    /** Build the consent URL for a fresh connect flow. */
    generateAuthUrl(opts: { state: string; redirectUri: string; scopes?: string[] }): string;

    /** Exchange an authorization code for tokens at the end of the OAuth flow. */
    exchangeCodeForTokens(opts: { code: string; redirectUri: string }): Promise<CrmOAuthTokens>;

    /** Refresh an expired access token. Throws if refresh fails — caller marks connection expired. */
    refreshTokens(refreshToken: string): Promise<CrmOAuthTokens>;

    /** Look up the CRM-side org identity (portal_id / organization_id) for display. */
    fetchAccountInfo(accessToken: string, extra?: Record<string, unknown>): Promise<{
        externalAccountId: string;
        externalAccountName: string;
    }>;

    // ── Field discovery (drives the field-mapping UI) ────────────────
    describeContactFields(): Promise<CrmFieldDescriptor[]>;

    // ── Contact import ───────────────────────────────────────────────
    listContacts(opts: {
        filter: CrmContactFilter;
        cursor: string | null;
        limit?: number;
    }): Promise<CrmPagedContacts>;

    getContact(externalId: string): Promise<CrmContact | null>;

    // ── Activity push ────────────────────────────────────────────────
    /** Resolve a CRM contact ID by email (used when no link exists yet). */
    findContactIdByEmail(email: string): Promise<string | null>;

    /** Write an activity to the CRM contact's timeline / Task. Throws CrmPushError on failure. */
    pushActivity(opts: { contactExternalId: string; activity: CrmActivity }): Promise<void>;

    // ── Suppression sync ─────────────────────────────────────────────
    listSuppressions(cursor: string | null): Promise<{
        emails: string[];
        nextCursor: string | null;
    }>;
}

/**
 * Factory function shape — each provider exports one of these. Phase 1
 * has no implementations yet; Phase 2 (HubSpot) and Phase 3 (Salesforce)
 * will register their factories with the connection service.
 */
export interface CrmClientFactory {
    readonly provider: CrmProvider;
    create(opts: {
        accessToken: string;
        refreshToken?: string | null;
        instanceUrl?: string | null;
        /** Called when the factory's caller refreshes tokens — connection service persists them. */
        onTokensRefreshed?: (tokens: CrmOAuthTokens) => Promise<void>;
    }): CrmClient;
}
