/**
 * Enrichment waterfall service - runs the org's configured providers in
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
import { encrypt, decrypt } from '../../utils/encryption';
import { apolloProvider } from './providers/apollo';
import { clayProvider } from './providers/clay';
import { surfeProvider } from './providers/surfe';
import { makeStubProvider } from './providers/generic';
import type {
    ProviderCode, ProviderImpl, ProfileInput, EnrichedFields, EnrichmentResult,
    ProviderCredentials,
} from './providerInterface';

// Provider registry - keyed by the same code used in EnrichmentProvider.provider.
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
            logger.warn('[ENRICHMENT] Unknown provider - skipping', { provider: cfg.provider });
            continue;
        }

        // BYOK: pull the customer-supplied credentials. Reads the
        // AES-256-GCM encrypted column (credentials_encrypted) when
        // present - the canonical at-rest shape that matches every other
        // integration (Slack/CRM/Outreach/JustCall) - and falls back to
        // the legacy plaintext `config.credentials` only for rows
        // predating the encryption migration. Shape is per-provider:
        // Apollo expects { api_key }, Clay expects { webhook_url,
        // api_key }, etc. Each provider's isConfigured() checks for the
        // keys it needs and the waterfall skips when they're missing.
        const credentials = readProviderCredentials(cfg);

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

        // Strict BYOK - no cost tracking. The vendor's own dashboard is
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
 * Read the BYOK credentials for an EnrichmentProvider row. Encrypted at
 * rest (AES-256-GCM via utils/encryption) - same helper every other
 * integration uses (SlackIntegration.bot_token_encrypted,
 * CrmConnection.access_token, JustCallConnection.api_key, etc.). The
 * waterfall NEVER reads process.env for these; the platform doesn't ship
 * shared keys for any of the enrichment vendors.
 *
 * Resolution order (first wins):
 *   1. `credentials_encrypted` - canonical encrypted blob. Decrypted to
 *      { api_key, webhook_url, ... } per the provider's expected shape.
 *   2. `config.credentials` - LEGACY plaintext shape. Only used for rows
 *      that predate the encryption migration; logged as a warning so
 *      operators can run the offline backfill.
 *   3. flat `config` - even older legacy where credentials lived at the
 *      top level of `config`. Same warning treatment.
 *
 * Returns `{}` (which every provider treats as "not configured") when
 * none of the above resolves to usable string values.
 */
function readProviderCredentials(row: {
    credentials_encrypted: string | null;
    config: unknown;
    provider: string;
}): ProviderCredentials {
    if (row.credentials_encrypted) {
        try {
            const parsed = JSON.parse(decrypt(row.credentials_encrypted));
            if (parsed && typeof parsed === 'object') {
                return Object.fromEntries(
                    Object.entries(parsed as Record<string, unknown>)
                        .filter(([, v]) => typeof v === 'string')
                ) as ProviderCredentials;
            }
        } catch (err) {
            logger.error('[ENRICHMENT] Failed to decrypt provider credentials', err instanceof Error ? err : new Error(String(err)), { provider: row.provider });
            // Fall through to legacy shapes rather than fail-closed - the
            // operator may have left a legacy config in place for a row
            // whose encrypted blob got corrupted.
        }
    }
    if (!row.config || typeof row.config !== 'object') return {};
    const obj = row.config as Record<string, unknown>;
    const inner = obj.credentials;
    if (inner && typeof inner === 'object') {
        logger.warn('[ENRICHMENT] Provider using LEGACY plaintext credentials in config.credentials - run the encryption backfill', { provider: row.provider });
        return Object.fromEntries(
            Object.entries(inner as Record<string, unknown>)
                .filter(([, v]) => typeof v === 'string')
        ) as ProviderCredentials;
    }
    // Flat legacy: credentials at the top level of config. Only ever
    // existed on the very earliest enrichment rows; same warning.
    const flat = Object.fromEntries(
        Object.entries(obj).filter(([, v]) => typeof v === 'string')
    ) as ProviderCredentials;
    if (Object.keys(flat).length > 0) {
        logger.warn('[ENRICHMENT] Provider using FLAT legacy credentials at config root - run the encryption backfill', { provider: row.provider });
    }
    return flat;
}

/**
 * Write encrypted credentials to an EnrichmentProvider row. ONE place
 * every future write controller calls so the encryption story can never
 * diverge from the read path. Also enforces the per-provider config
 * shape (F6) by deferring validation to the provider implementation's
 * isConfigured() - rejects empty / wrong-shape configs at write time so
 * the user gets a clear error instead of a silent waterfall skip.
 */
export async function setEnrichmentProviderCredentials(opts: {
    organizationId: string;
    provider: ProviderCode;
    credentials: ProviderCredentials;
    enabled?: boolean;
    orderIndex?: number;
    /** Non-credential config overrides (rate limits, search filters). */
    config?: Record<string, unknown>;
}): Promise<{ id: string }> {
    const impl = PROVIDERS[opts.provider];
    if (!impl) {
        throw new Error(`Unknown enrichment provider: ${opts.provider}`);
    }
    // F6: per-provider shape validation at write time. isConfigured()
    // already encodes "which keys this provider needs"; reuse it as the
    // single source of truth so config validation can't drift from the
    // runtime behaviour.
    if (!impl.isConfigured(opts.credentials)) {
        throw new Error(
            `${impl.label} requires credentials this config does not supply. See providerInterface.ts for the per-provider shape.`,
        );
    }

    const encrypted = encrypt(JSON.stringify(opts.credentials));
    const nonCredentialConfig = opts.config ?? {};

    const row = await prisma.enrichmentProvider.upsert({
        where: {
            organization_id_provider: {
                organization_id: opts.organizationId,
                provider: opts.provider,
            },
        },
        create: {
            organization_id: opts.organizationId,
            provider: opts.provider,
            credentials_encrypted: encrypted,
            config: nonCredentialConfig as unknown as object,
            enabled: opts.enabled ?? true,
            order_index: opts.orderIndex ?? 0,
        },
        update: {
            credentials_encrypted: encrypted,
            // Strip any legacy plaintext credentials that may still be
            // sitting in `config` on this row - we own the canonical
            // location now.
            config: stripLegacyCredentials(nonCredentialConfig) as unknown as object,
            enabled: opts.enabled ?? true,
            order_index: opts.orderIndex ?? 0,
        },
        select: { id: true },
    });

    logger.info('[ENRICHMENT] Provider credentials written (encrypted)', {
        orgId: opts.organizationId,
        provider: opts.provider,
        connectionId: row.id,
    });

    return row;
}

/** Removes any historical `credentials` / `api_key` / `webhook_url` keys
 *  from a `config` payload so legacy plaintext never lingers after a
 *  write through the new path. */
function stripLegacyCredentials(config: Record<string, unknown>): Record<string, unknown> {
    const { credentials: _ignored, api_key: _a, webhook_url: _w, api_secret: _s, ...rest } = config;
    return rest;
}

/**
 * Erase the credentials column for every EnrichmentProvider in this org.
 * Called from piiErasureService.eraseOrganization as the defense-in-depth
 * wipe (cascade still removes the rows; this nulls the encrypted blob
 * first so even a future cascade regression cannot leak credentials).
 */
export async function wipeAllEnrichmentProviderCredentials(organizationId: string): Promise<number> {
    const r = await prisma.enrichmentProvider.updateMany({
        where: { organization_id: organizationId },
        data: { credentials_encrypted: null, config: {} as unknown as object },
    });
    return r.count;
}

