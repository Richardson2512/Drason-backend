/**
 * Enrichment waterfall service — runs the org's configured providers in
 * order_index sequence until every required field is filled, or the list
 * is exhausted. First-non-null wins per field.
 *
 * Wired through the EnrichmentAgent (see services/agents/enrichmentAgent.ts).
 * Writes EnrichmentAttempt rows for every attempt (HIT / EMPTY / ERROR)
 * so cost reconciliation has a paper trail.
 *
 * Locked design decision (project memory): waterfall order is user-
 * approved in Settings → Enrichment. The service NEVER re-sorts.
 */

import { prisma } from '../../prisma';
import { logger } from '../observabilityService';
import { apolloProvider } from './providers/apollo';
import { clayProvider } from './providers/clay';
import { surfeProvider } from './providers/surfe';
import { makeStubProvider } from './providers/generic';
import type {
    ProviderCode, ProviderImpl, ProfileInput, EnrichedFields, EnrichmentResult,
    ProviderCredentials,
} from './providerInterface';

// Provider registry — keyed by the same code used in EnrichmentProvider.provider.
const PROVIDERS: Record<ProviderCode, ProviderImpl> = {
    APOLLO: apolloProvider,
    CLAY: clayProvider,
    SURFE: surfeProvider,
    LUSHA: makeStubProvider('LUSHA'),
    HUNTER: makeStubProvider('HUNTER'),
    ZOOMINFO: makeStubProvider('ZOOMINFO'),
};

const DEFAULT_REQUIRED_FIELDS: (keyof EnrichedFields)[] = ['email'];
const OPTIONAL_FIELDS: (keyof EnrichedFields)[] = ['phone', 'linkedin_url', 'company_name', 'company_size', 'company_industry', 'company_website', 'title', 'location'];
const ALL_FIELDS: (keyof EnrichedFields)[] = [...DEFAULT_REQUIRED_FIELDS, ...OPTIONAL_FIELDS];

export interface WaterfallResult {
    final_fields: EnrichedFields;
    provider_attempts: Array<{ provider: ProviderCode; result: EnrichmentResult; fields_filled: string[] }>;
    /** True when zero EnrichmentProvider rows exist OR every configured
     *  provider was unconfigured (missing credentials). Lets the
     *  sequencer step distinguish "operator hasn't wired any provider"
     *  from "providers ran but none of them found a hit". */
    no_provider_available: boolean;
}

/**
 * Run the waterfall for one profile.
 *
 * organization_id: required so we can scope the configured providers.
 * lead_id: required so each EnrichmentAttempt row joins back cleanly.
 * required_fields: which fields trigger the early-exit. Defaults to ['email'].
 *   `find_linkedin_url` step passes ['linkedin_url'] so the waterfall exits as
 *   soon as a provider returns a URL rather than burning the remaining
 *   providers to fill incidental fields.
 */
export async function runWaterfall(
    organization_id: string,
    lead_id: string,
    profile: ProfileInput,
    required_fields: (keyof EnrichedFields)[] = DEFAULT_REQUIRED_FIELDS,
): Promise<WaterfallResult> {
    const configured = await prisma.enrichmentProvider.findMany({
        where: { organization_id, enabled: true },
        orderBy: { order_index: 'asc' },
    });

    const merged: EnrichedFields = {};
    const attempts: WaterfallResult['provider_attempts'] = [];
    let anyProviderRan = false;

    for (const cfg of configured) {
        const impl = PROVIDERS[cfg.provider as ProviderCode];
        if (!impl) {
            logger.warn('[ENRICHMENT] Unknown provider — skipping', { provider: cfg.provider });
            continue;
        }

        // BYOK: pull the customer-supplied credentials out of the
        // EnrichmentProvider.config JSON. Shape is per-provider — Apollo
        // expects { api_key }, Clay expects { webhook_url, api_key }, etc.
        // We never read process.env here; the platform doesn't ship
        // shared keys for these vendors. Each provider's isConfigured()
        // checks for the keys it needs and the waterfall skips when
        // they're missing.
        const credentials = extractCredentials(cfg.config);

        if (!impl.isConfigured(credentials)) {
            await prisma.enrichmentAttempt.create({
                data: {
                    organization_id, lead_id, provider: cfg.provider,
                    result: 'EMPTY', fields_filled: [],
                    error_message: 'provider_not_configured',
                },
            });
            attempts.push({ provider: cfg.provider as ProviderCode, result: 'EMPTY', fields_filled: [] });
            continue;
        }

        // Skip providers that wouldn't fill anything new.
        const stillNeeded = ALL_FIELDS.filter(k => merged[k] == null);
        if (stillNeeded.length === 0) break;

        anyProviderRan = true;
        let attempt: Awaited<ReturnType<ProviderImpl['enrich']>>;
        try {
            attempt = await impl.enrich(profile, credentials);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            attempt = { result: 'ERROR', fields: {}, error_message: msg.slice(0, 500) };
        }

        const filled: string[] = [];
        for (const k of ALL_FIELDS) {
            if (merged[k] == null && attempt.fields[k] != null) {
                merged[k] = attempt.fields[k] as string;
                filled.push(k);
            }
        }

        // Strict BYOK — no cost tracking. The vendor's own dashboard is
        // the source of truth for spend; we only audit what the
        // waterfall did (HIT / EMPTY / RATE_LIMITED / ERROR).
        await prisma.enrichmentAttempt.create({
            data: {
                organization_id, lead_id, provider: cfg.provider,
                result: attempt.result,
                fields_filled: filled,
                error_message: attempt.error_message,
            },
        });

        attempts.push({ provider: cfg.provider as ProviderCode, result: attempt.result, fields_filled: filled });

        // Early exit once every required field for THIS run is filled.
        if (required_fields.every(k => merged[k] != null)) break;
    }

    return {
        final_fields: merged,
        provider_attempts: attempts,
        no_provider_available: !anyProviderRan,
    };
}

/**
 * Pull the customer-supplied credentials out of EnrichmentProvider.config.
 * Accepts two shapes for forward compatibility:
 *
 *   { credentials: { api_key: '...', webhook_url: '...' } }   ← canonical
 *   { api_key: '...', webhook_url: '...' }                    ← flat (legacy)
 *
 * Returns `{}` (which every provider treats as "not configured") when
 * config is null / not an object / has neither shape.
 *
 * Encrypting these values at rest is a follow-up — for now we trust the
 * Postgres row-level encryption + the org-scoped foreign key. When the
 * secrets-store integration lands, this helper switches to dereferencing
 * EnrichmentProvider.credentials_ref instead of reading config.
 */
function extractCredentials(config: unknown): ProviderCredentials {
    if (!config || typeof config !== 'object') return {};
    const obj = config as Record<string, unknown>;
    const inner = obj.credentials;
    if (inner && typeof inner === 'object') {
        return Object.fromEntries(
            Object.entries(inner as Record<string, unknown>)
                .filter(([, v]) => typeof v === 'string')
        ) as ProviderCredentials;
    }
    return Object.fromEntries(
        Object.entries(obj).filter(([, v]) => typeof v === 'string')
    ) as ProviderCredentials;
}

