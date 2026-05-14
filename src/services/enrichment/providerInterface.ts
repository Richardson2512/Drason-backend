/**
 * Enrichment provider interface — every plug-in implements this shape.
 *
 * The waterfall service (waterfallService.ts) reads EnrichmentProvider
 * rows in order_index sequence, picks the matching impl from PROVIDERS,
 * and tries each one until every required field is filled or the list
 * is exhausted. Per-attempt outcomes write EnrichmentAttempt rows for
 * audit + cost reconciliation.
 */

export type ProviderCode = 'APOLLO' | 'CLAY' | 'SURFE' | 'LUSHA' | 'HUNTER' | 'ZOOMINFO';

export type EnrichmentResult = 'HIT' | 'EMPTY' | 'ERROR' | 'RATE_LIMITED' | 'SKIPPED_HAS_FIELD';

export interface ProfileInput {
    /** LinkedIn URL is the most-portable identifier across providers. */
    linkedin_url?: string;
    /** Full name + company name as fallback inputs. */
    full_name?: string;
    company_name?: string;
    /** When known, the lead's existing partial email — providers may use
     *  the domain to refine the search. */
    email_hint?: string;
}

export interface EnrichedFields {
    email?: string | null;
    phone?: string | null;
    /** LinkedIn profile URL — populated by providers that can resolve it
     *  from name + company (Apollo, Clay, Surfe, Lusha) and consumed by
     *  the `find_linkedin_url` sequencer step type. */
    linkedin_url?: string | null;
    company_name?: string | null;
    company_size?: string | null;
    company_industry?: string | null;
    company_website?: string | null;
    title?: string | null;
    location?: string | null;
}

export interface EnrichmentAttempt {
    result: EnrichmentResult;
    /** Fields that the provider actually returned (non-null). */
    fields: EnrichedFields;
    error_message?: string;
}

/**
 * Customer-supplied credentials passed in from the waterfall service.
 * The shape is per-provider:
 *
 *   APOLLO   — { api_key }
 *   CLAY     — { webhook_url, api_key }
 *   SURFE    — { api_key }
 *   LUSHA    — { api_key }
 *   HUNTER   — { api_key }
 *   ZOOMINFO — { api_key }
 *
 * Each provider implementation knows which keys it needs and reads them
 * from this record. We deliberately keep the shape loose (rather than a
 * tagged union) so adding a new provider doesn't ripple through the
 * waterfall — it only needs its own credentials shape.
 *
 * Strict BYOK: the platform reads NOTHING from process.env for these.
 * If a customer hasn't entered a key on the Enrichment settings page,
 * isConfigured() returns false and the provider is skipped.
 */
export type ProviderCredentials = Record<string, string | undefined>;

export interface ProviderImpl {
    code: ProviderCode;
    label: string;
    /** Whether the credentials supplied by the customer are sufficient
     *  to call the provider. The waterfall short-circuits when this
     *  returns false rather than burning an audit row for a no-op call. */
    isConfigured(credentials: ProviderCredentials): boolean;
    /** Perform the lookup using the customer's credentials. Always
     *  resolves — errors are returned in the result, not thrown.
     *
     *  We deliberately do NOT track per-call cost here. The platform is
     *  pure BYOK for enrichment — the customer pays the vendor directly
     *  out of their own account, and we have no reliable read on their
     *  actual rate (volume discounts, plan tier, etc.). The
     *  EnrichmentAttempt audit row records HIT / EMPTY / RATE_LIMITED;
     *  cost reconciliation belongs in the vendor's own dashboard. */
    enrich(profile: ProfileInput, credentials: ProviderCredentials): Promise<EnrichmentAttempt>;
}
