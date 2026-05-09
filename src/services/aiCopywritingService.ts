/**
 * AI Copywriting Service
 *
 * Scrapes an organization's website and extracts a structured business profile
 * (BusinessProfileV1) via OpenAI. The profile is the cached context every
 * email-generation call will receive, so the same scrape + extract is done
 * once per org and reused across templates and campaign sequence steps.
 *
 * Pipeline:
 *   URL → Jina Reader (r.jina.ai) → clean markdown
 *       → OpenAI JSON-mode → BusinessProfileV1
 *       → Postgres cache (BusinessProfile row, unique per org)
 *
 * Model: read from OPENAI_MODEL env (default gpt-5.4-nano). The same model
 * drives extraction AND generation — we split into two models only if a
 * bakeoff later proves generation needs more capability.
 */

import OpenAI from 'openai';
import { prisma } from '../index';
import { logger } from './observabilityService';
import { safeCompletion } from './openaiClient';

// ────────────────────────────────────────────────────────────────────
// Types — BusinessProfileV1 contract between extraction and generation
// ────────────────────────────────────────────────────────────────────

export interface BusinessProfileV1 {
    schema_version: 1;
    company: {
        name: string;
        url: string;
        one_liner: string;          // "AI-powered cold email with deliverability protection"
        tagline?: string;
    };
    offering: {
        category: string;           // "B2B SaaS — email deliverability"
        products: string[];         // ["AI sequencer", "Deliverability protection"]
        differentiators: string[];  // ["Auto-heals paused mailboxes", "ESP-aware routing"]
        pricing_model?: string;
    };
    icp: {
        roles: string[];            // ["RevOps engineer", "Technical founder"]
        company_sizes: string[];    // ["Seed to Series B", "<200 employees"]
        industries: string[];       // ["B2B SaaS", "Growth agencies"]
        pain_points: string[];      // ["Burned domains", "Bounce spikes"]
    };
    value_prop: {
        primary: string;            // "Stop burning domains — protection layer auto-pauses risky mailboxes"
        proof_points: string[];     // ["91% inbox placement", "0 domains burned in 6 months"]
    };
    voice: {
        tone: 'casual' | 'neutral' | 'professional' | 'direct';
        formality: 'low' | 'medium' | 'high';
        distinctive_phrases: string[]; // ["AI sequencer", "burned domains", "deliverability protection"]
    };
    sample_openers: string[];       // 2-3 natural first lines scraped/inferred from the site's voice
}

// ────────────────────────────────────────────────────────────────────
// Config
// ────────────────────────────────────────────────────────────────────

const MODEL = process.env.OPENAI_MODEL || 'gpt-5.4-nano';
const JINA_READER_BASE = 'https://r.jina.ai/';
const MAX_SCRAPE_CHARS = 200_000; // ~50k tokens — well under 400k context, leaves room for output + caching
const CACHE_TTL_DAYS = parseInt(process.env.AI_PROFILE_CACHE_TTL_DAYS || '30', 10);

let _openai: OpenAI | null = null;
function getClient(): OpenAI {
    if (!_openai) {
        const apiKey = process.env.OPENAI_API_KEY;
        if (!apiKey) throw new Error('OPENAI_API_KEY is not configured');
        _openai = new OpenAI({ apiKey });
    }
    return _openai;
}

// ────────────────────────────────────────────────────────────────────
// Step 1 — scrape via Jina Reader
// ────────────────────────────────────────────────────────────────────

/**
 * Fetches clean markdown for a URL via Jina Reader (r.jina.ai).
 * Free tier is fine for low volume; no API key required.
 * Returns the raw markdown, truncated to MAX_SCRAPE_CHARS.
 */
export async function scrapeUrl(url: string): Promise<{ markdown: string; chars: number }> {
    // Normalize — Jina accepts the full URL appended after the base
    const normalized = url.trim().replace(/^https?:\/\//i, 'https://');
    const jinaUrl = `${JINA_READER_BASE}${normalized}`;

    const res = await fetch(jinaUrl, {
        method: 'GET',
        headers: {
            'Accept': 'text/plain',
            'X-Return-Format': 'markdown',
        },
        // Jina can be slow on first hit — give it a wide timeout
        signal: AbortSignal.timeout(45_000),
    });

    if (!res.ok) {
        throw new Error(`Jina Reader failed: ${res.status} ${res.statusText}`);
    }

    let markdown = await res.text();
    if (markdown.length > MAX_SCRAPE_CHARS) {
        markdown = markdown.slice(0, MAX_SCRAPE_CHARS);
    }
    return { markdown, chars: markdown.length };
}

/**
 * Scrape multiple URLs in parallel and concatenate them with `## Source: <url>`
 * headers so the extractor can attribute facts. Per-URL failures are caught and
 * recorded — we don't fail the whole batch on one bad page.
 *
 * Total markdown is capped at MAX_SCRAPE_CHARS across all sources so prompt
 * cost stays bounded regardless of how many URLs the operator pasted.
 */
export async function scrapeUrls(urls: string[]): Promise<{
    markdown: string;
    chars: number;
    failures: Array<{ url: string; error: string }>;
}> {
    if (urls.length === 0) {
        return { markdown: '', chars: 0, failures: [] };
    }

    const perUrl = await Promise.all(
        urls.map(async (url) => {
            try {
                const r = await scrapeUrl(url);
                return { url, ok: true as const, markdown: r.markdown, chars: r.chars };
            } catch (err) {
                return { url, ok: false as const, error: (err as Error).message };
            }
        }),
    );

    const failures = perUrl.filter(r => !r.ok).map(r => ({ url: r.url, error: (r as any).error }));
    const successes = perUrl.filter(r => r.ok) as Array<{ url: string; ok: true; markdown: string; chars: number }>;

    if (successes.length === 0) {
        return { markdown: '', chars: 0, failures };
    }

    // Per-source chunk so the model can cite which URL a fact came from.
    // Truncate each source proportionally if total would exceed the cap.
    const totalChars = successes.reduce((n, s) => n + s.chars, 0);
    const sources = totalChars > MAX_SCRAPE_CHARS
        ? successes.map(s => ({
            ...s,
            markdown: s.markdown.slice(0, Math.floor(s.chars * MAX_SCRAPE_CHARS / totalChars)),
        }))
        : successes;

    const combined = sources
        .map(s => `## Source: ${s.url}\n\n${s.markdown}`)
        .join('\n\n---\n\n');

    return { markdown: combined, chars: combined.length, failures };
}

// ────────────────────────────────────────────────────────────────────
// Step 2 — extract structured profile via OpenAI JSON mode
// ────────────────────────────────────────────────────────────────────

const PROFILE_SYSTEM_PROMPT = `You are a business analyst extracting a structured profile from a company's website.

Read the markdown content and produce a JSON object that conforms exactly to BusinessProfileV1:
- schema_version: always 1
- company: { name, url, one_liner (<= 20 words), tagline? }
- offering: { category, products[], differentiators[], pricing_model? }
- icp: { roles[], company_sizes[], industries[], pain_points[] }
- value_prop: { primary (<= 30 words), proof_points[] }
- voice: { tone, formality, distinctive_phrases[] }
- sample_openers: 2-3 natural first lines that would sound authentic to this company's voice

Rules:
- Prefer specificity over vagueness. "Series A B2B SaaS" > "businesses".
- Only include proof points you can verify from the content (stats, customer names, quantified outcomes). Never fabricate.
- distinctive_phrases: 3-5 terms this brand uses that a competitor wouldn't.
- If information is missing, use an empty array — never invent.
- When multiple sources are provided (separated by "## Source: <url>" headers), synthesize across them:
    * Prefer the homepage / root URL for company.name, value_prop, voice.
    * Prefer pricing pages for offering.pricing_model.
    * Prefer case-study / customer pages for proof_points.
    * Deduplicate facts; if sources conflict, trust the most recent / most specific.
- Output MUST be valid JSON matching the schema exactly.`;

export async function extractProfile(
    urlOrUrls: string | string[],
    markdown: string
): Promise<{ profile: BusinessProfileV1; promptTokens: number; completionTokens: number }> {
    const urls = Array.isArray(urlOrUrls) ? urlOrUrls : [urlOrUrls];
    const urlListing = urls.length === 1
        ? `Website URL: ${urls[0]}`
        : `Source URLs (${urls.length}):\n${urls.map((u, i) => `${i + 1}. ${u}`).join('\n')}`;

    const response = await safeCompletion({
        model: MODEL,
        messages: [
            { role: 'system', content: PROFILE_SYSTEM_PROMPT },
            {
                role: 'user',
                content: `${urlListing}\n\nScraped content:\n\n${markdown}`,
            },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.2, // deterministic extraction
    }, { tag: 'extractProfile' });

    const raw = response.choices[0]?.message?.content || '{}';
    let parsed: BusinessProfileV1;
    try {
        parsed = JSON.parse(raw);
    } catch (err) {
        logger.error('[AI_COPY] Profile JSON parse failed', err as Error, { raw: raw.slice(0, 500) });
        throw new Error('AI returned invalid JSON for business profile');
    }

    // Best-effort shape fixup — the model occasionally returns legacy keys.
    // When multiple URLs were passed, the first one is the canonical "primary".
    if (!parsed.schema_version) parsed.schema_version = 1;
    if (!parsed.company?.url) {
        const primaryUrl = urls[0];
        parsed.company = { ...(parsed.company || { name: '', one_liner: '' }), url: primaryUrl };
    }

    return {
        profile: parsed,
        promptTokens: response.usage?.prompt_tokens || 0,
        completionTokens: response.usage?.completion_tokens || 0,
    };
}

// ────────────────────────────────────────────────────────────────────
// Step 3 — end-to-end orchestration with cache
// ────────────────────────────────────────────────────────────────────

/**
 * Full pipeline: scrape (one or many URLs) + extract + upsert into
 * BusinessProfile cache. Returns the freshly extracted profile.
 *
 * When multiple URLs are passed, content is concatenated with per-source
 * headers and the extractor synthesizes across them. The first URL wins
 * the source_url column (treated as the canonical "primary" URL).
 *
 * Throws if every URL fails to scrape — partial failures are kept and
 * surfaced via the returned `failures` shape on the variant below.
 */
export async function extractAndCacheProfile(orgId: string, urlOrUrls: string | string[]): Promise<BusinessProfileV1> {
    const urls = (Array.isArray(urlOrUrls) ? urlOrUrls : [urlOrUrls]).map(u => u.trim()).filter(Boolean);
    if (urls.length === 0) throw new Error('At least one URL is required');

    logger.info(`[AI_COPY] Extracting profile for org=${orgId} urls=${urls.length}`, { urls });

    const { markdown, chars, failures } = await scrapeUrls(urls);
    if (!markdown.trim()) {
        const detail = failures.map(f => `${f.url}: ${f.error}`).join('; ');
        throw new Error(`No source URL was reachable. ${detail}`);
    }
    if (failures.length > 0) {
        logger.warn(`[AI_COPY] ${failures.length}/${urls.length} sources failed to scrape`, { failures });
    }

    const { profile, promptTokens, completionTokens } = await extractProfile(urls, markdown);

    // First URL wins the canonical column. The full set of URLs survives
    // through the user-provided value being passed back into a re-run via
    // /api/ai/profile/refresh — the operator can re-paste them then.
    const primary = urls[0];

    await prisma.businessProfile.upsert({
        where: { organization_id: orgId },
        create: {
            organization_id: orgId,
            source_url: primary,
            profile_json: profile as any,
            scraped_chars: chars,
            model_used: MODEL,
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
        },
        update: {
            source_url: primary,
            profile_json: profile as any,
            scraped_chars: chars,
            model_used: MODEL,
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            extracted_at: new Date(),
        },
    });

    logger.info(`[AI_COPY] Profile cached for org=${orgId} (${chars} chars in, ${promptTokens}+${completionTokens} tokens, ${urls.length} sources)`);
    return profile;
}

/**
 * Returns the cached profile for an org, or null if none exists / stale.
 */
export async function getCachedProfile(orgId: string, opts: { allowStale?: boolean } = {}): Promise<BusinessProfileV1 | null> {
    const row = await prisma.businessProfile.findUnique({ where: { organization_id: orgId } });
    if (!row) return null;

    const ageMs = Date.now() - new Date(row.extracted_at).getTime();
    const ttlMs = CACHE_TTL_DAYS * 24 * 60 * 60 * 1000;
    if (!opts.allowStale && ageMs > ttlMs) return null;

    return row.profile_json as unknown as BusinessProfileV1;
}

export function getConfiguredModel(): string {
    return MODEL;
}

// ════════════════════════════════════════════════════════════════════
// GENERATION
// ════════════════════════════════════════════════════════════════════

export type StepIntent =
    | 'intro'          // First touch — introduce company + light hook
    | 'follow_up'      // Polite re-ping on prior email
    | 'value_add'      // Share a specific insight / resource
    | 'social_proof'   // Customer story / metric reference
    | 'breakup'        // Final "closing the loop" message
    | 'custom';        // Use custom_instructions verbatim

export interface GenerateStepInput {
    step_intent: StepIntent;
    step_number?: number;            // 1-indexed position in the sequence
    total_steps?: number;            // Total steps in the sequence (for context)
    tone?: 'casual' | 'neutral' | 'professional' | 'direct';
    word_budget?: number;            // Rough target (default 80-120 words)
    custom_instructions?: string;    // Extra guidance from the user
    variant_of?: { subject: string; body_html: string }; // Generate a B variant off an existing A
    /** Optional per-recipient enrichment (LeadProfileV1 shape from
     *  leadProfileService). When supplied, the model gets a "RECIPIENT
     *  CONTEXT" block alongside the sender's profile and is instructed to
     *  ground specifics in it. Strictly additive — generation works without it. */
    lead_profile?: Record<string, unknown> | null;
}

export interface GeneratedEmail {
    subject: string;
    body_html: string;
    body_text: string;
    intent: StepIntent;
    reasoning?: string;              // Short model note on why this structure
}

// ────────────────────────────────────────────────────────────────────
// Prompt construction — cache-friendly: stable prefix first, variable last
// ────────────────────────────────────────────────────────────────────

const GENERATION_SYSTEM_PROMPT = `You write short, specific, high-signal cold outreach emails for B2B outbound campaigns.

Rules you follow without exception:
1. Sound like a human, not marketing copy. No "I hope this email finds you well" style openers.
2. Reference the SENDER's company by its distinctive terms (from the business profile) — never generic.
3. Use recipient variables where natural: {{first_name}}, {{last_name}}, {{company}}, {{persona}}. Do not invent other variables.
4. Keep total body under the word_budget. Short is better than comprehensive.
5. One soft CTA at the end. No double CTAs, no "let me know if you want to chat OR I can send more info".
6. Never use em-dashes in the subject line. Never use exclamation marks.
7. body_html must be a valid HTML snippet using only <p>, <br>, <strong>, <em>, <a>. No inline styles, no <div>, no wrapper tags.
8. body_text must be the HTML stripped to plain text, preserving paragraph breaks as double newlines.

Output a JSON object matching this schema exactly:
{
  "subject": string,
  "body_html": string,
  "body_text": string,
  "intent": string,
  "reasoning": string  // One sentence explaining the structural choice you made
}`;

function describeIntent(intent: StepIntent, step_number?: number, total_steps?: number): string {
    const pos = step_number && total_steps ? ` (step ${step_number} of ${total_steps})` : '';
    const descriptions: Record<StepIntent, string> = {
        intro: `The FIRST touch${pos}. Introduce the sender's company in 1 sentence, hook with a specific observation about the recipient's company or role, then a low-friction CTA (question or quick ask, not a meeting request).`,
        follow_up: `A POLITE follow-up${pos}. Assume prior email was unread, not rejected. Bring a fresh angle — new insight, question, or micro-value. Do NOT say "just following up" or "bumping this".`,
        value_add: `A VALUE-FIRST message${pos}. Lead with something useful to the recipient (a specific insight, teardown, relevant resource). CTA is optional — the message stands alone if ignored.`,
        social_proof: `A SOCIAL-PROOF message${pos}. Reference a concrete customer outcome or quantified result from the business profile's proof_points. Tie it directly to the recipient's likely pain. One sentence of proof, one sentence of relevance, CTA.`,
        breakup: `The FINAL message${pos}. Acknowledge the recipient hasn't responded, state the sender will stop reaching out, leave the door open. No pressure, no guilt. 3-4 short lines max.`,
        custom: `Follow the custom_instructions exactly.`,
    };
    return descriptions[intent];
}

// ────────────────────────────────────────────────────────────────────
// Generate ONE email step
// ────────────────────────────────────────────────────────────────────

export async function generateEmailStep(
    profile: BusinessProfileV1,
    input: GenerateStepInput
): Promise<{ email: GeneratedEmail; promptTokens: number; completionTokens: number }> {
    const tone = input.tone || profile.voice?.tone || 'direct';
    const wordBudget = input.word_budget || 100;

    // Stable prefix (cached across generations): system + profile + constant framing.
    // Variable suffix: the specific step request.
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
        { role: 'system', content: GENERATION_SYSTEM_PROMPT },
        {
            role: 'system',
            content: `SENDER BUSINESS PROFILE (stable context — same across every generation for this org):\n\n${JSON.stringify(profile, null, 2)}`,
        },
    ];

    // RECIPIENT CONTEXT — only included when the caller supplies a lead
    // profile (per-recipient enrichment from leadProfileService). Splicing
    // a separate system message keeps prompt-cache hits high: the
    // sender-profile prefix above stays identical across all generations
    // for the org, only this block varies per lead.
    if (input.lead_profile && Object.keys(input.lead_profile).length > 0) {
        messages.push({
            role: 'system',
            content: [
                'RECIPIENT CONTEXT (per-lead enrichment from public sources — use to ground specifics, do not invent beyond it):',
                '',
                JSON.stringify(input.lead_profile, null, 2),
                '',
                'When using this context:',
                '- Reference the recipient\'s company by their distinctive_phrases or one_liner — never generic.',
                '- Tie the hook to a recipient pain_point or industry signal that overlaps with the sender\'s value_prop.',
                '- If a fact is not in this context or the sender profile, do not state it as fact.',
            ].join('\n'),
        });
    }

    messages.push({
        role: 'user',
        content: [
            `Generate one email.`,
            `Intent: ${describeIntent(input.step_intent, input.step_number, input.total_steps)}`,
            `Tone: ${tone}`,
            `Word budget: ${wordBudget}`,
            input.custom_instructions ? `Extra instructions from user: ${input.custom_instructions}` : '',
            input.variant_of
                ? `This is a B variant. Write a meaningfully different angle from the A version below. Different hook, different opener, different CTA wording.\n\nA version subject: ${input.variant_of.subject}\nA version body: ${input.variant_of.body_html}`
                : '',
        ]
            .filter(Boolean)
            .join('\n\n'),
    });

    const response = await safeCompletion({
        model: MODEL,
        messages,
        response_format: { type: 'json_object' },
        temperature: 0.7,
        max_tokens: 800,
    }, { tag: 'generateEmailStep' });

    const raw = response.choices[0]?.message?.content || '{}';
    let parsed: any;
    try {
        parsed = JSON.parse(raw);
    } catch (err) {
        logger.error('[AI_COPY] Email JSON parse failed', err as Error, { raw: raw.slice(0, 500) });
        throw new Error('AI returned invalid JSON for email');
    }

    // Defensive: ensure required fields exist
    const email: GeneratedEmail = {
        subject: String(parsed.subject || '').trim(),
        body_html: String(parsed.body_html || '').trim(),
        body_text: String(parsed.body_text || stripHtml(parsed.body_html || '')).trim(),
        intent: input.step_intent,
        reasoning: parsed.reasoning ? String(parsed.reasoning) : undefined,
    };

    if (!email.subject || !email.body_html) {
        throw new Error('AI returned an incomplete email (missing subject or body)');
    }

    return {
        email,
        promptTokens: response.usage?.prompt_tokens || 0,
        completionTokens: response.usage?.completion_tokens || 0,
    };
}

// ────────────────────────────────────────────────────────────────────
// Generate a FULL SEQUENCE (N steps at once)
// ────────────────────────────────────────────────────────────────────

export interface GenerateSequenceInput {
    total_steps: number;             // 2-7 reasonable range
    intents?: StepIntent[];          // If omitted, uses a sensible default pattern
    tone?: 'casual' | 'neutral' | 'professional' | 'direct';
    word_budget?: number;
    custom_instructions?: string;
}

const DEFAULT_INTENT_PATTERN: StepIntent[] = [
    'intro',
    'follow_up',
    'value_add',
    'social_proof',
    'breakup',
];

export async function generateFullSequence(
    profile: BusinessProfileV1,
    input: GenerateSequenceInput
): Promise<{ emails: GeneratedEmail[]; promptTokens: number; completionTokens: number }> {
    const n = Math.max(1, Math.min(7, input.total_steps || 3));
    const intents = input.intents && input.intents.length === n
        ? input.intents
        : Array.from({ length: n }, (_, i) => {
            if (i === 0) return 'intro' as StepIntent;
            if (i === n - 1 && n >= 3) return 'breakup' as StepIntent;
            return DEFAULT_INTENT_PATTERN[Math.min(i, DEFAULT_INTENT_PATTERN.length - 2)];
        });

    // Generate in parallel — faster + each call uses the same cached prefix.
    // This is where the nano model's cache pricing shines: the profile+system prompt
    // is cached after the first call, subsequent calls in this batch read it ~10x cheaper.
    const results = await Promise.all(
        intents.map((intent, i) =>
            generateEmailStep(profile, {
                step_intent: intent,
                step_number: i + 1,
                total_steps: n,
                tone: input.tone,
                word_budget: input.word_budget,
                custom_instructions: input.custom_instructions,
            })
        )
    );

    return {
        emails: results.map(r => r.email),
        promptTokens: results.reduce((sum, r) => sum + r.promptTokens, 0),
        completionTokens: results.reduce((sum, r) => sum + r.completionTokens, 0),
    };
}

function stripHtml(html: string): string {
    return html
        .replace(/<\/p>/gi, '\n\n')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

// ────────────────────────────────────────────────────────────────────
// Manual profile edit — deep-merge a partial BusinessProfileV1 into
// the cached row. Used by PATCH /api/ai/profile so operators can
// refine fields the AI got wrong (e.g., add a proof point the
// homepage didn't mention, fix the company one-liner) without
// re-scraping.
//
// Validation philosophy: accept any subset of valid keys; reject
// unknown top-level sections. Field-level types are best-effort —
// the caller is the operator, not arbitrary user input.
// ────────────────────────────────────────────────────────────────────

const ALLOWED_PROFILE_SECTIONS = new Set([
    'schema_version', 'company', 'offering', 'icp', 'value_prop', 'voice', 'sample_openers',
]);

export class ProfilePatchError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ProfilePatchError';
    }
}

/**
 * Apply a partial patch to the cached BusinessProfileV1 and return the
 * merged result. Throws ProfilePatchError on validation failure.
 *
 * Merge rules:
 * - Top-level sections (company / offering / icp / value_prop / voice):
 *   shallow-merge — patched fields overwrite, untouched fields keep their
 *   value. This lets the operator update a single subfield (e.g. one_liner)
 *   without re-supplying the whole object.
 * - Arrays (products, proof_points, distinctive_phrases, sample_openers):
 *   replaced wholesale. Use the GET → edit → PATCH cycle to add an item.
 * - schema_version: ignored on patch — pinned to the cached row's value.
 */
export async function patchCachedProfile(
    orgId: string,
    patch: Partial<BusinessProfileV1>,
): Promise<BusinessProfileV1> {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        throw new ProfilePatchError('Patch body must be a non-array object');
    }

    for (const key of Object.keys(patch)) {
        if (!ALLOWED_PROFILE_SECTIONS.has(key)) {
            throw new ProfilePatchError(`Unknown profile section: ${key}`);
        }
    }

    const current = await getCachedProfile(orgId, { allowStale: true });
    if (!current) {
        throw new ProfilePatchError('No business profile to patch yet — extract one first via POST /api/ai/profile');
    }

    const merged: BusinessProfileV1 = {
        ...current,
        ...(patch.company   ? { company:   { ...current.company,   ...patch.company   } } : {}),
        ...(patch.offering  ? { offering:  { ...current.offering,  ...patch.offering  } } : {}),
        ...(patch.icp       ? { icp:       { ...current.icp,       ...patch.icp       } } : {}),
        ...(patch.value_prop ? { value_prop: { ...current.value_prop, ...patch.value_prop } } : {}),
        ...(patch.voice     ? { voice:     { ...current.voice,     ...patch.voice     } } : {}),
        ...(Array.isArray(patch.sample_openers) ? { sample_openers: patch.sample_openers } : {}),
        // schema_version stays pinned to whatever's cached
        schema_version: current.schema_version,
    };

    await prisma.businessProfile.update({
        where: { organization_id: orgId },
        data: {
            profile_json: merged as any,
            // updated_at flips automatically; extracted_at stays at the
            // last AI run so the UI can distinguish "manually edited" from
            // "freshly extracted"
        },
    });

    logger.info(`[AI_COPY] Profile patched for org=${orgId}`, { sections: Object.keys(patch) });
    return merged;
}
