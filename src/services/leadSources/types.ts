/**
 * Lead-source integration types - Phase 5.
 *
 * Provider-blind interfaces shared across Apollo (Phase 5) and ZoomInfo
 * (Phase 6+). Lead sources are read-only - we pull contacts; we don't
 * write activity back. That's the structural difference from CrmClient.
 */

export type LeadSourceProvider = 'apollo' | 'zoominfo';

export type LeadSourceConnectionStatus = 'active' | 'error' | 'expired' | 'disconnected';

/** Source descriptor - what the user pasted/picked. Drives the import path. */
export type LeadSourceFilter =
    | { kind: 'people_search'; params: Record<string, unknown> }
    | { kind: 'saved_list'; listId: string }
    | { kind: 'saved_search'; searchId: string };

/** A contact normalized to Superkabe's lead vocabulary. */
export interface LeadSourceContact {
    /** Provider-side ID (Apollo person id, ZoomInfo person id). Required. */
    externalId: string;
    email: string;
    firstName?: string;
    lastName?: string;
    fullName?: string;
    company?: string;
    title?: string;
    phone?: string;
    linkedinUrl?: string;
    /** Recipient's company LinkedIn page (linkedin.com/company/<slug>).
     *  Used as the preferred source for per-recipient AI enrichment. */
    companyLinkedinUrl?: string;
    /** Anything not folded into the canonical fields above. */
    customFields?: Record<string, unknown>;
}

/** Paginated contact result from a list/search call. */
export interface LeadSourcePagedContacts {
    contacts: LeadSourceContact[];
    /** Opaque cursor - page number for Apollo, token for ZoomInfo. */
    nextCursor: string | null;
    /** Best-effort total - used for the import preview's "estimated" count. */
    totalCount?: number | null;
}

/** Account-info for the dashboard - workspace name, credit balance. */
export interface LeadSourceAccountInfo {
    externalAccountId: string;
    externalAccountName: string;
    creditsRemaining?: number | null;
    creditsLimit?: number | null;
}

/** Throwable error class so workers can decide retry vs fail. */
export class LeadSourceError extends Error {
    constructor(
        message: string,
        public readonly retryable: boolean,
        public readonly providerCode?: string,
    ) {
        super(message);
        this.name = 'LeadSourceError';
    }
}

/** The provider-blind interface. */
export interface LeadSourceClient {
    readonly provider: LeadSourceProvider;

    /** Validate the API key + return account info. Used at connect time. */
    validateConnection(): Promise<LeadSourceAccountInfo>;

    /**
     * Page through a search/list. Cursor is opaque to the caller.
     * limit defaults to provider's max-per-page.
     */
    listContacts(opts: {
        filter: LeadSourceFilter;
        cursor: string | null;
        limit?: number;
        revealPersonalEmails?: boolean;
    }): Promise<LeadSourcePagedContacts>;

    /**
     * Estimate total result count for an import preview. Many providers
     * include this in the first listContacts() call; this method exists
     * so callers can preview without fetching contacts.
     */
    estimateContactCount(filter: LeadSourceFilter): Promise<number | null>;
}

/** Provider factory - each provider exports one of these. */
export interface LeadSourceClientFactory {
    readonly provider: LeadSourceProvider;
    create(opts: { apiKey: string }): LeadSourceClient;
    /**
     * Parse a provider-specific URL the user pasted into a structured
     * LeadSourceFilter. Returns null if the URL doesn't match any
     * recognized pattern. Provider-specific so each module can own its
     * URL grammar.
     */
    parseUrl(url: string): LeadSourceFilter | null;
}
