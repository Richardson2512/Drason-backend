/**
 * Per-Lead AI Enrichment Service
 *
 * Mirrors aiCopywritingService but operates on a single Lead instead of
 * the org's BusinessProfile. The output is a LeadProfileV1 - a subset of
 * BusinessProfileV1 focused on the recipient's *company* (not the
 * recipient personally; LinkedIn personal profiles are blocked by Jina).
 *
 * Source URL preference order:
 *   1. Lead.company_linkedin_url   - richest signal that Jina can reach
 *   2. Lead.website                - fallback if no LinkedIn company page
 *   3. (skip)                      - leave LeadProfile in 'skipped' state
 *
 * The cached profile is spliced into the email-generation prompt as
 * "RECIPIENT CONTEXT" so the same template emits per-lead-personalized
 * copy without an extra OpenAI call per send.
 */

import { prisma } from '../index';
import { logger } from './observabilityService';
import { scrapeUrl } from './aiCopywritingService';
import { safeCompletion } from './openaiClient';

// ────────────────────────────────────────────────────────────────────
// Types - LeadProfileV1: the recipient-side analog of BusinessProfileV1
// ────────────────────────────────────────────────────────────────────

export interface LeadProfileV1 {
    schema_version: 1;
    company: {
        name: string;
        url?: string;
        one_liner: string;          // "B2B sales engagement platform"
        tagline?: string;
    };
    offering: {
        category: string;           // "Sales engagement" / "Series-B fintech"
        products: string[];         // What they sell, if discoverable
        differentiators: string[];  // What they emphasize on the page
    };
    /** Pain points and signals the SENDER can speak to. Inferred from
     *  what the recipient's company emphasizes (e.g. "scaling outbound"
     *  → likely cares about deliverability). */
    inferred_pain_points: string[];
    /** Distinctive vocabulary used by the recipient's brand - handy for
     *  matching their voice when writing copy. */
    distinctive_phrases: string[];
    /** Free-form list of recent / notable signals (a launch, hiring spree,
     *  funding round) the model could detect from the page. Empty if none
     *  are mentioned. Never invented. */
    signals: string[];
}

// ────────────────────────────────────────────────────────────────────
// Config
// ────────────────────────────────────────────────────────────────────

const MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini';
/** TTL after which a successfully extracted profile becomes stale and
 *  the worker re-enriches. 60 days = company pages don't change that
 *  fast; the worker won't drown in re-scrapes. */
const LEAD_PROFILE_TTL_DAYS = parseInt(process.env.LEAD_PROFILE_TTL_DAYS || '60', 10);
/** Max chars from Jina to feed into extraction. Smaller than the org
 *  profile cap because we run this per-lead - keeping prompts short
 *  matters more here for cost. */
const LEAD_MAX_SCRAPE_CHARS = 60_000;

// OpenAI calls go through openaiClient.safeCompletion - that helper owns
// retry/backoff and the in-process concurrency semaphore for the whole
// process, so this service stays free of client plumbing.

// ────────────────────────────────────────────────────────────────────
// URL selection - pick the best source we have for a Lead
// ────────────────────────────────────────────────────────────────────

export type LeadSourceKind = 'linkedin_company' | 'website';

/** Decide which URL to enrich from. Returns null when the lead has no
 *  reachable source - caller marks the row as 'skipped'. */
export function pickEnrichmentSource(lead: {
    company_linkedin_url?: string | null;
    website?: string | null;
}): { url: string; kind: LeadSourceKind } | null {
    const li = (lead.company_linkedin_url || '').trim();
    if (li && /linkedin\.com\/company\//i.test(li)) {
        return { url: li, kind: 'linkedin_company' };
    }
    const web = (lead.website || '').trim();
    if (web) {
        return { url: web, kind: 'website' };
    }
    return null;
}

// ────────────────────────────────────────────────────────────────────
// Extraction prompt - produces LeadProfileV1
// ────────────────────────────────────────────────────────────────────

const LEAD_PROFILE_SYSTEM_PROMPT = `You are a business analyst extracting a structured profile of a SALES PROSPECT'S company from a public web page (their LinkedIn company page or homepage).

Produce a JSON object that conforms exactly to LeadProfileV1:
- schema_version: always 1
- company: { name, url?, one_liner (<= 20 words), tagline? }
- offering: { category, products[], differentiators[] }
- inferred_pain_points: 1-4 pain points THIS company likely faces, inferred from what they emphasize. e.g. "scaling outbound without burning sender reputation" for a sales-engagement vendor.
- distinctive_phrases: 3-5 brand-specific terms a competitor wouldn't use. Helps a salesperson match the prospect's voice.
- signals: array of recent / notable concrete signals (a product launch, a hiring spree, a funding round, an award) ONLY if the page explicitly mentions them. Empty array is correct when nothing stands out.

Rules:
- Prefer specificity over vagueness. "Series-A B2B fintech" > "tech company".
- NEVER invent facts. If you cannot find evidence on the page, leave the field blank or use an empty array.
- Pain points are INFERRED from the company's stated focus - flag them as the kind of problem this company would care about, not problems you assume because of their industry.
- Output MUST be valid JSON matching the schema exactly.`;

async function extractLeadProfile(
    url: string,
    markdown: string,
): Promise<{ profile: LeadProfileV1; promptTokens: number; completionTokens: number }> {
    const response = await safeCompletion({
        model: MODEL,
        messages: [
            { role: 'system', content: LEAD_PROFILE_SYSTEM_PROMPT },
            {
                role: 'user',
                content: `Source URL: ${url}\n\nScraped content:\n\n${markdown}`,
            },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.2,
    }, { tag: 'extractLeadProfile' });

    const raw = response.choices[0]?.message?.content || '{}';
    let parsed: LeadProfileV1;
    try {
        parsed = JSON.parse(raw);
    } catch (err) {
        logger.error('[LEAD_PROFILE] JSON parse failed', err as Error, { raw: raw.slice(0, 500) });
        throw new Error('AI returned invalid JSON for lead profile');
    }

    if (!parsed.schema_version) parsed.schema_version = 1;
    if (!parsed.company) parsed.company = { name: '', one_liner: '' };

    return {
        profile: parsed,
        promptTokens: response.usage?.prompt_tokens || 0,
        completionTokens: response.usage?.completion_tokens || 0,
    };
}

// ────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────

export interface EnrichmentRunResult {
    status: 'ready' | 'skipped' | 'failed';
    profile?: LeadProfileV1;
    sourceUrl?: string;
    sourceKind?: LeadSourceKind;
    error?: string;
}

/**
 * End-to-end enrichment for one lead. Caches the result on `LeadProfile`.
 *
 * - Picks the best source URL (LinkedIn company > website).
 * - Marks 'skipped' if no source exists - caller should not retry until
 *   the lead's company_linkedin_url / website is updated.
 * - On scrape / extract failure, stores 'failed' with last_error so the
 *   operator can see what went wrong from the dashboard.
 *
 * Idempotent - calling it on a 'ready' row re-runs and overwrites if
 * called explicitly. The worker uses TTL to decide when to re-run.
 */
export async function enrichLead(leadId: string): Promise<EnrichmentRunResult> {
    const lead = await prisma.lead.findUnique({
        where: { id: leadId },
        select: {
            id: true,
            organization_id: true,
            company_linkedin_url: true,
            website: true,
        },
    });
    if (!lead) {
        return { status: 'failed', error: 'Lead not found' };
    }

    const source = pickEnrichmentSource(lead);
    if (!source) {
        // Mark as skipped so the worker doesn't keep picking it up.
        await prisma.leadProfile.upsert({
            where: { lead_id: lead.id },
            create: {
                lead_id: lead.id,
                organization_id: lead.organization_id,
                source_url: '',
                source_kind: 'website',
                status: 'skipped',
                last_error: 'No company_linkedin_url or website on lead',
            },
            update: {
                status: 'skipped',
                last_error: 'No company_linkedin_url or website on lead',
            },
        });
        return { status: 'skipped', error: 'No source URL on lead' };
    }

    // Reserve the row in 'extracting' so concurrent workers don't double-fire.
    await prisma.leadProfile.upsert({
        where: { lead_id: lead.id },
        create: {
            lead_id: lead.id,
            organization_id: lead.organization_id,
            source_url: source.url,
            source_kind: source.kind,
            status: 'extracting',
        },
        update: {
            source_url: source.url,
            source_kind: source.kind,
            status: 'extracting',
            last_error: null,
        },
    });

    try {
        const scraped = await scrapeUrl(source.url);
        // Cap separately from org profile - per-lead prompts stay tight.
        const trimmed = scraped.markdown.length > LEAD_MAX_SCRAPE_CHARS
            ? scraped.markdown.slice(0, LEAD_MAX_SCRAPE_CHARS)
            : scraped.markdown;
        if (!trimmed.trim()) {
            throw new Error('Scrape returned empty content');
        }

        const { profile, promptTokens, completionTokens } = await extractLeadProfile(source.url, trimmed);

        await prisma.leadProfile.update({
            where: { lead_id: lead.id },
            data: {
                profile_json: profile as any,
                scraped_chars: trimmed.length,
                model_used: MODEL,
                prompt_tokens: promptTokens,
                completion_tokens: completionTokens,
                status: 'ready',
                last_error: null,
                extracted_at: new Date(),
            },
        });

        logger.info(`[LEAD_PROFILE] Enriched lead=${lead.id} via ${source.kind}`, {
            chars: trimmed.length, promptTokens, completionTokens,
        });
        return { status: 'ready', profile, sourceUrl: source.url, sourceKind: source.kind };
    } catch (err) {
        const message = (err as Error).message?.slice(0, 500) ?? 'Unknown enrichment error';
        await prisma.leadProfile.update({
            where: { lead_id: lead.id },
            data: {
                status: 'failed',
                last_error: message,
            },
        });
        logger.warn(`[LEAD_PROFILE] Enrichment failed for lead=${lead.id}`, { url: source.url, error: message });
        return { status: 'failed', error: message, sourceUrl: source.url, sourceKind: source.kind };
    }
}

/**
 * Returns the cached LeadProfileV1 for use in email generation.
 * Returns null if no profile exists, status is anything but 'ready',
 * or the cached row is older than the TTL (caller can choose to
 * trigger a re-enrich).
 */
export async function getCachedLeadProfile(
    leadId: string,
    opts: { allowStale?: boolean } = {},
): Promise<LeadProfileV1 | null> {
    const row = await prisma.leadProfile.findUnique({ where: { lead_id: leadId } });
    if (!row || row.status !== 'ready' || !row.profile_json) return null;

    if (!opts.allowStale && row.extracted_at) {
        const ageMs = Date.now() - row.extracted_at.getTime();
        if (ageMs > LEAD_PROFILE_TTL_DAYS * 24 * 60 * 60 * 1000) return null;
    }

    return row.profile_json as unknown as LeadProfileV1;
}
