/**
 * Apollo enrichment provider - strict BYOK (customer supplies api_key).
 *
 * POSTs to Apollo's /v1/people/match endpoint with the lead's LinkedIn URL +
 * name + company. The response carries email, phone numbers, company size,
 * industry, title, location, AND the canonical LinkedIn URL - Apollo
 * resolves a profile URL from name + company even when the caller didn't
 * pass one in. This is the path the `find_linkedin_url` sequencer step
 * uses to discover URLs for contacts that were imported without one.
 *
 * Apollo API:
 *   POST https://api.apollo.io/v1/people/match
 *   Headers: X-Api-Key: <customer's api_key, stored per-org>
 *   Body: { linkedin_url, first_name, last_name, organization_name }
 *
 * Strict BYOK: customer pays Apollo directly out of their own Apollo
 * account. We don't track or surface per-hit cost - the customer's
 * Apollo dashboard is the source of truth for spend.
 *
 * Credentials shape: { api_key: string }
 *
 * The provider reports EMPTY (and the waterfall skips it without
 * burning an audit row) whenever the customer hasn't entered an Apollo
 * api_key on the Enrichment settings page.
 */

import { logger } from '../../observabilityService';
import type { ProviderImpl, ProfileInput, EnrichmentAttempt, ProviderCredentials } from '../providerInterface';

const APOLLO_BASE = 'https://api.apollo.io';
const REQUEST_TIMEOUT_MS = 10_000;

interface ApolloMatchResponse {
    person?: {
        email?: string | null;
        phone_numbers?: Array<{ raw_number?: string }>;
        title?: string | null;
        city?: string | null;
        state?: string | null;
        country?: string | null;
        /** Canonical LinkedIn profile URL. Apollo populates this when it
         *  resolves a person from name + company even if the request
         *  didn't include a URL - that's what makes Apollo useful as the
         *  source for the `find_linkedin_url` sequencer step. */
        linkedin_url?: string | null;
        organization?: {
            name?: string | null;
            website_url?: string | null;
            industry?: string | null;
            estimated_num_employees?: number | null;
        };
    };
}

/**
 * Apollo returns `linkedin_url` in a variety of shapes depending on how
 * the profile was scraped. Normalize to the public `https://www.linkedin.com/in/<slug>`
 * form so the dispatcher's slug-regex always finds a hit and so we don't
 * store mixed shapes (e.g. `linkedin.com/in/slug`, `http://`, trailing `/`).
 * Returns null when the input doesn't look like a profile URL at all.
 */
export function normalizeLinkedInUrl(raw: string | null | undefined): string | null {
    if (!raw) return null;
    const trimmed = String(raw).trim();
    if (!trimmed) return null;
    // Accept bare paths like "linkedin.com/in/slug" by prepending the scheme.
    const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    let url: URL;
    try { url = new URL(withScheme); } catch { return null; }
    if (!/linkedin\.com$/i.test(url.hostname) && !/^([a-z]+\.)?linkedin\.com$/i.test(url.hostname)) return null;
    const m = url.pathname.match(/\/in\/([^\/?#]+)/);
    if (!m) return null;
    return `https://www.linkedin.com/in/${m[1].replace(/\/+$/, '')}`;
}

function bucketSize(emp: number | null | undefined): string | null {
    if (emp == null) return null;
    if (emp <= 10) return '1-10';
    if (emp <= 50) return '11-50';
    if (emp <= 200) return '51-200';
    if (emp <= 500) return '201-500';
    if (emp <= 1000) return '501-1000';
    if (emp <= 5000) return '1001-5000';
    return '5000+';
}

export const apolloProvider: ProviderImpl = {
    code: 'APOLLO',
    label: 'Apollo',

    isConfigured(credentials: ProviderCredentials): boolean {
        return Boolean(credentials?.api_key);
    },

    async enrich(profile: ProfileInput, credentials: ProviderCredentials): Promise<EnrichmentAttempt> {
        const apiKey = credentials?.api_key;
        if (!apiKey) {
            return { result: 'EMPTY', fields: {} };
        }

        const body: Record<string, string> = {};
        if (profile.linkedin_url) body.linkedin_url = profile.linkedin_url;
        if (profile.full_name) {
            const [first, ...rest] = profile.full_name.split(' ');
            body.first_name = first;
            if (rest.length > 0) body.last_name = rest.join(' ');
        }
        if (profile.company_name) body.organization_name = profile.company_name;
        if (Object.keys(body).length === 0) {
            return { result: 'EMPTY', fields: {} };
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

        try {
            const res = await fetch(`${APOLLO_BASE}/v1/people/match`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Api-Key': apiKey,
                    'Accept': 'application/json',
                },
                body: JSON.stringify(body),
                signal: controller.signal,
            });

            if (res.status === 429) {
                return { result: 'RATE_LIMITED', fields: {}, error_message: 'Apollo 429' };
            }
            if (!res.ok) {
                const text = await res.text();
                return { result: 'ERROR', fields: {}, error_message: `Apollo ${res.status}: ${text.slice(0, 200)}` };
            }

            const json = (await res.json()) as ApolloMatchResponse;
            const person = json.person;
            if (!person) {
                return { result: 'EMPTY', fields: {} };
            }

            const fields = {
                email: person.email || null,
                phone: person.phone_numbers?.[0]?.raw_number || null,
                linkedin_url: normalizeLinkedInUrl(person.linkedin_url),
                title: person.title || null,
                company_name: person.organization?.name || null,
                company_website: person.organization?.website_url || null,
                company_industry: person.organization?.industry || null,
                company_size: bucketSize(person.organization?.estimated_num_employees),
                location: [person.city, person.state, person.country].filter(Boolean).join(', ') || null,
            };

            const anyField = Object.values(fields).some(v => v != null);
            return {
                result: anyField ? 'HIT' : 'EMPTY',
                fields,
            };
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const isAbort = msg.includes('aborted') || msg.includes('AbortError');
            logger.warn('[APOLLO] enrich failed', { err: msg.slice(0, 200), aborted: isAbort });
            return {
                result: 'ERROR',
                fields: {},
                error_message: isAbort ? 'request_timeout' : msg.slice(0, 300),
            };
        } finally {
            clearTimeout(timer);
        }
    },
};
