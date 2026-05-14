/**
 * Clay enrichment provider — strict BYOK (customer supplies webhook + key).
 *
 * Clay exposes per-row enrichment via a webhook-driven flow rather than a
 * sync REST endpoint. The integration here is async (we POST a row to the
 * customer's pre-configured Clay table; Clay POSTs back via webhook with
 * the enriched fields). Because the handshake requires the customer to
 * set up their own Clay table and provide its webhook + API key, v1
 * reports EMPTY when those aren't supplied and the waterfall moves on.
 *
 * Credentials shape: { webhook_url: string, api_key: string }
 */

import type { ProviderImpl, ProfileInput, EnrichmentAttempt, ProviderCredentials } from '../providerInterface';

export const clayProvider: ProviderImpl = {
    code: 'CLAY',
    label: 'Clay',

    isConfigured(credentials: ProviderCredentials): boolean {
        return Boolean(credentials?.webhook_url && credentials?.api_key);
    },

    async enrich(_profile: ProfileInput, credentials: ProviderCredentials): Promise<EnrichmentAttempt> {
        if (!credentials?.webhook_url || !credentials?.api_key) {
            return { result: 'EMPTY', fields: {} };
        }
        // TODO Phase 4.1: POST to credentials.webhook_url with the row;
        // store a Clay-side correlation id so the inbound webhook can
        // patch the lead when Clay calls us back.
        return { result: 'EMPTY', fields: {} };
    },
};
