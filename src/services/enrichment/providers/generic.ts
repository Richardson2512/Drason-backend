/**
 * Generic stub provider - used as the impl for SURFE / LUSHA / HUNTER /
 * ZOOMINFO until each gets its own dedicated module. Always reports EMPTY
 * so the waterfall moves through the configured order without burning
 * cost on no-op calls.
 *
 * Each real provider should replace these with a dedicated file under
 * services/enrichment/providers/ that implements ProviderImpl. Like the
 * real providers, all stubs are strict BYOK - they check the customer-
 * supplied credentials, never read process.env.
 *
 * When implementing a real version, make sure `enrich()` populates the
 * `linkedin_url` field on EnrichedFields when the provider returns one -
 * the `find_linkedin_url` sequencer step depends on it. SURFE / LUSHA /
 * ZOOMINFO all expose LinkedIn URLs in their /person responses; HUNTER
 * is email-only and should leave linkedin_url null.
 */

import type { ProviderImpl, ProviderCode, ProfileInput, EnrichmentAttempt, ProviderCredentials } from '../providerInterface';

export function makeStubProvider(code: Exclude<ProviderCode, 'APOLLO' | 'CLAY'>): ProviderImpl {
    return {
        code,
        label: code.charAt(0) + code.slice(1).toLowerCase(),
        isConfigured(credentials: ProviderCredentials): boolean {
            return Boolean(credentials?.api_key);
        },
        async enrich(_profile: ProfileInput, _credentials: ProviderCredentials): Promise<EnrichmentAttempt> {
            return { result: 'EMPTY', fields: {} };
        },
    };
}
