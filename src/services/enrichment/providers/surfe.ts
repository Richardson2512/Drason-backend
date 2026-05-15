/**
 * Surfe enrichment provider - strict BYOK (customer supplies api_key).
 *
 * POSTs to Surfe's /v2/people/enrichments endpoint with the lead's
 * LinkedIn URL OR (full name + company). Returns email, phone, title,
 * location, company metadata, and - critically for the `find_linkedin_url`
 * sequencer step - the canonical LinkedIn profile URL even when the
 * caller didn't pass one in.
 *
 * Surfe API: https://developers.surfe.com/api-reference/
 *   POST https://api.surfe.com/v2/people/enrichments
 *   Headers: Authorization: Bearer <customer's api_key>
 *   Body: { people: [{ linkedinUrl?, firstName, lastName, companyName }] }
 *
 * Strict BYOK: customer pays Surfe directly out of their own Surfe
 * account. The platform never reads SURFE_API_KEY from process.env -
 * isConfigured() returns false (and the waterfall skips the provider)
 * whenever the customer hasn't entered an api_key on the Enrichment
 * settings page.
 *
 * Credentials shape: { api_key: string }
 */

import { logger } from '../../observabilityService';
import type {
    ProviderImpl, ProfileInput, EnrichmentAttempt, ProviderCredentials,
} from '../providerInterface';

const SURFE_BASE = 'https://api.surfe.com';
const REQUEST_TIMEOUT_MS = 12_000;

interface SurfeEnrichmentResponse {
    people?: Array<{
        emails?: Array<{ email?: string; type?: string }>;
        phones?: Array<{ phone?: string; type?: string }>;
        linkedinUrl?: string | null;
        firstName?: string | null;
        lastName?: string | null;
        jobTitle?: string | null;
        location?: string | null;
        country?: string | null;
        city?: string | null;
        companies?: Array<{
            name?: string;
            website?: string;
            industry?: string;
            employeeCount?: number;
        }>;
    }>;
}

/**
 * Surfe returns LinkedIn URLs that mostly come from the public profile
 * page. Normalize the same way the Apollo provider does so the
 * dispatcher's slug-regex always matches and Lead.linkedin_url storage
 * stays consistent across providers.
 */
function normalizeLinkedInUrl(raw: string | null | undefined): string | null {
    if (!raw) return null;
    const trimmed = String(raw).trim();
    if (!trimmed) return null;
    const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    let url: URL;
    try { url = new URL(withScheme); } catch { return null; }
    if (!/(^|\.)linkedin\.com$/i.test(url.hostname)) return null;
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

export const surfeProvider: ProviderImpl = {
    code: 'SURFE',
    label: 'Surfe',

    isConfigured(credentials: ProviderCredentials): boolean {
        return Boolean(credentials?.api_key);
    },

    async enrich(profile: ProfileInput, credentials: ProviderCredentials): Promise<EnrichmentAttempt> {
        const apiKey = credentials?.api_key;
        if (!apiKey) {
            return { result: 'EMPTY', fields: {} };
        }

        // Build the per-person query. Surfe accepts a LinkedIn URL as the
        // strongest signal; otherwise it works from name + company.
        const person: Record<string, string> = {};
        if (profile.linkedin_url) person.linkedinUrl = profile.linkedin_url;
        if (profile.full_name) {
            const [first, ...rest] = profile.full_name.trim().split(/\s+/);
            if (first) person.firstName = first;
            if (rest.length > 0) person.lastName = rest.join(' ');
        }
        if (profile.company_name) person.companyName = profile.company_name;
        if (Object.keys(person).length === 0) {
            return { result: 'EMPTY', fields: {} };
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

        try {
            const res = await fetch(`${SURFE_BASE}/v2/people/enrichments`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`,
                    'Accept': 'application/json',
                },
                body: JSON.stringify({ people: [person] }),
                signal: controller.signal,
            });

            if (res.status === 429) {
                return { result: 'RATE_LIMITED', fields: {}, error_message: 'Surfe 429' };
            }
            if (!res.ok) {
                const text = await res.text();
                return { result: 'ERROR', fields: {}, error_message: `Surfe ${res.status}: ${text.slice(0, 200)}` };
            }

            const json = (await res.json()) as SurfeEnrichmentResponse;
            const subject = json.people?.[0];
            if (!subject) {
                return { result: 'EMPTY', fields: {} };
            }

            // Pick the first work email if present; otherwise any email.
            const primaryEmail = subject.emails?.find(e => e.type === 'work')?.email
                ?? subject.emails?.[0]?.email
                ?? null;

            // Pick a mobile phone first (highest contactability), then any phone.
            const primaryPhone = subject.phones?.find(p => p.type === 'mobile')?.phone
                ?? subject.phones?.[0]?.phone
                ?? null;

            const company = subject.companies?.[0];
            const location = subject.location
                || [subject.city, subject.country].filter(Boolean).join(', ')
                || null;

            const fields = {
                email: primaryEmail,
                phone: primaryPhone,
                linkedin_url: normalizeLinkedInUrl(subject.linkedinUrl),
                title: subject.jobTitle || null,
                company_name: company?.name || null,
                company_website: company?.website || null,
                company_industry: company?.industry || null,
                company_size: bucketSize(company?.employeeCount),
                location,
            };

            const anyField = Object.values(fields).some(v => v != null);
            return {
                result: anyField ? 'HIT' : 'EMPTY',
                fields,
            };
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const isAbort = msg.includes('aborted') || msg.includes('AbortError');
            logger.warn('[SURFE] enrich failed', { err: msg.slice(0, 200), aborted: isAbort });
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
