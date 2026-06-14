/**
 * Sequence service - CRUD + AI-assisted generation for reusable saved
 * sequences. Distinct from the campaign-side SequenceStep model: these
 * are templates that get CLONED into a campaign on load, never linked.
 *
 * The AI generator scrapes operator-supplied URLs (typically the
 * customer's website + competitor pages + relevant case studies), feeds
 * the markdown + custom instructions into Gemini Flash, and returns a
 * structured N-step sequence ready to persist.
 */

import { prisma } from '../index';
import { logger } from './observabilityService';
import { scrapeUrls } from './aiCopywritingService';
import { safeGeminiCompletion, isGeminiConfigured } from './geminiClient';

// ────────────────────────────────────────────────────────────────────
// Shapes
// ────────────────────────────────────────────────────────────────────

export interface SequenceStepInput {
    step_number: number;
    delay_days?: number;
    delay_hours?: number;
    subject?: string;
    preheader?: string;
    body_html?: string;
    body_text?: string | null;
    condition?: string | null;
    branch_to_step_number?: number | null;
}

export interface SequenceWriteInput {
    name: string;
    description?: string | null;
    category?: string;
    steps: SequenceStepInput[];
    ai_source_urls?: string[];
    ai_custom_instructions?: string | null;
    ai_model_used?: string | null;
}

export interface SequenceView {
    id: string;
    name: string;
    description: string | null;
    category: string;
    ai_source_urls: string[];
    ai_custom_instructions: string | null;
    ai_model_used: string | null;
    created_at: Date;
    updated_at: Date;
    step_count: number;
    steps?: Array<{
        id: string;
        step_number: number;
        delay_days: number;
        delay_hours: number;
        subject: string;
        preheader: string;
        body_html: string;
        condition: string | null;
        branch_to_step_number: number | null;
    }>;
}

// ────────────────────────────────────────────────────────────────────
// CRUD
// ────────────────────────────────────────────────────────────────────

export async function listSequences(orgId: string): Promise<SequenceView[]> {
    const rows = await prisma.sequence.findMany({
        where: { organization_id: orgId },
        orderBy: { updated_at: 'desc' },
        include: { _count: { select: { steps: true } } },
    });
    return rows.map(r => ({
        id: r.id,
        name: r.name,
        description: r.description,
        category: r.category,
        ai_source_urls: r.ai_source_urls,
        ai_custom_instructions: r.ai_custom_instructions,
        ai_model_used: r.ai_model_used,
        created_at: r.created_at,
        updated_at: r.updated_at,
        step_count: r._count.steps,
    }));
}

export async function getSequence(orgId: string, id: string): Promise<SequenceView | null> {
    const row = await prisma.sequence.findFirst({
        where: { id, organization_id: orgId },
        include: { steps: { orderBy: { step_number: 'asc' } } },
    });
    if (!row) return null;
    return {
        id: row.id,
        name: row.name,
        description: row.description,
        category: row.category,
        ai_source_urls: row.ai_source_urls,
        ai_custom_instructions: row.ai_custom_instructions,
        ai_model_used: row.ai_model_used,
        created_at: row.created_at,
        updated_at: row.updated_at,
        step_count: row.steps.length,
        steps: row.steps.map(s => ({
            id: s.id,
            step_number: s.step_number,
            delay_days: s.delay_days,
            delay_hours: s.delay_hours,
            subject: s.subject,
            preheader: s.preheader,
            body_html: s.body_html,
            condition: s.condition,
            branch_to_step_number: s.branch_to_step_number,
        })),
    };
}

function normalizeSteps(steps: SequenceStepInput[]): SequenceStepInput[] {
    // Sort by user-provided step_number, then renumber 1..N so consumers
    // can rely on a contiguous sequence regardless of what the wizard sent.
    const sorted = [...steps].sort((a, b) => a.step_number - b.step_number);
    return sorted.map((s, i) => ({ ...s, step_number: i + 1 }));
}

export async function createSequence(orgId: string, input: SequenceWriteInput): Promise<SequenceView> {
    if (!input.name?.trim()) throw new Error('Sequence name is required');
    if (!Array.isArray(input.steps) || input.steps.length === 0) {
        throw new Error('Sequence must have at least one step');
    }

    const normalized = normalizeSteps(input.steps);
    const created = await prisma.$transaction(async tx => {
        const seq = await tx.sequence.create({
            data: {
                organization_id: orgId,
                name: input.name.trim(),
                description: input.description?.trim() || null,
                category: input.category || 'general',
                ai_source_urls: input.ai_source_urls || [],
                ai_custom_instructions: input.ai_custom_instructions || null,
                ai_model_used: input.ai_model_used || null,
            },
        });
        await tx.sequenceTemplateStep.createMany({
            data: normalized.map(s => ({
                sequence_id: seq.id,
                step_number: s.step_number,
                delay_days: s.delay_days ?? 1,
                delay_hours: s.delay_hours ?? 0,
                subject: s.subject || '',
                preheader: s.preheader || '',
                body_html: s.body_html || '',
                body_text: s.body_text ?? null,
                condition: s.condition ?? null,
                branch_to_step_number: s.branch_to_step_number ?? null,
            })),
        });
        return seq;
    });

    return (await getSequence(orgId, created.id))!;
}

export async function updateSequence(orgId: string, id: string, input: Partial<SequenceWriteInput>): Promise<SequenceView | null> {
    const existing = await prisma.sequence.findFirst({
        where: { id, organization_id: orgId },
        select: { id: true },
    });
    if (!existing) return null;

    await prisma.$transaction(async tx => {
        await tx.sequence.update({
            where: { id },
            data: {
                ...(input.name !== undefined ? { name: input.name.trim() } : {}),
                ...(input.description !== undefined ? { description: input.description?.trim() || null } : {}),
                ...(input.category !== undefined ? { category: input.category } : {}),
                ...(input.ai_source_urls !== undefined ? { ai_source_urls: input.ai_source_urls } : {}),
                ...(input.ai_custom_instructions !== undefined ? { ai_custom_instructions: input.ai_custom_instructions || null } : {}),
                ...(input.ai_model_used !== undefined ? { ai_model_used: input.ai_model_used || null } : {}),
            },
        });

        if (Array.isArray(input.steps)) {
            const normalized = normalizeSteps(input.steps);
            // Replace-all on update keeps the schema simple at the cost
            // of dropping/recreating rows. Sequences are small (max ~10 steps
            // in practice) so the churn is negligible.
            await tx.sequenceTemplateStep.deleteMany({ where: { sequence_id: id } });
            if (normalized.length > 0) {
                await tx.sequenceTemplateStep.createMany({
                    data: normalized.map(s => ({
                        sequence_id: id,
                        step_number: s.step_number,
                        delay_days: s.delay_days ?? 1,
                        delay_hours: s.delay_hours ?? 0,
                        subject: s.subject || '',
                        preheader: s.preheader || '',
                        body_html: s.body_html || '',
                        body_text: s.body_text ?? null,
                        condition: s.condition ?? null,
                        branch_to_step_number: s.branch_to_step_number ?? null,
                    })),
                });
            }
        }
    });

    return getSequence(orgId, id);
}

export async function deleteSequence(orgId: string, id: string): Promise<boolean> {
    const r = await prisma.sequence.deleteMany({
        where: { id, organization_id: orgId },
    });
    return r.count > 0;
}

export async function duplicateSequence(orgId: string, id: string): Promise<SequenceView | null> {
    const source = await getSequence(orgId, id);
    if (!source) return null;
    return createSequence(orgId, {
        name: `${source.name} (copy)`,
        description: source.description ?? undefined,
        category: source.category,
        ai_source_urls: source.ai_source_urls,
        ai_custom_instructions: source.ai_custom_instructions ?? undefined,
        ai_model_used: source.ai_model_used ?? undefined,
        steps: (source.steps || []).map(s => ({
            step_number: s.step_number,
            delay_days: s.delay_days,
            delay_hours: s.delay_hours,
            subject: s.subject,
            preheader: s.preheader,
            body_html: s.body_html,
            condition: s.condition,
            branch_to_step_number: s.branch_to_step_number,
        })),
    });
}

// ────────────────────────────────────────────────────────────────────
// AI-assisted generation - Gemini Flash
// ────────────────────────────────────────────────────────────────────

export interface AiGenerateInput {
    /** URLs to scrape for context (your homepage, pricing, case studies, etc.) */
    urls: string[];
    /** Free-form operator instructions ("formal tone, focus on SOC-2 buyers") */
    customInstructions?: string;
    /** Desired number of steps. 1–10 in practice, capped to 10 server-side. */
    stepCount: number;
    /** Soft hint to the model; defaults to 'neutral'. */
    tone?: 'casual' | 'neutral' | 'professional' | 'direct';
    /** Optional ICP / audience description. */
    audience?: string;
}

export interface AiGenerateResult {
    /** Suggested name for the saved sequence. The user can rename before save. */
    name: string;
    description: string;
    steps: SequenceStepInput[];
    /** Raw URL fetch outcomes - surfaced in UI so the user knows what was read. */
    sources: Array<{ url: string; ok: boolean; error?: string }>;
    modelUsed: string;
}

const GENERATE_PROMPT_TEMPLATE = (ctx: {
    markdown: string;
    customInstructions: string;
    stepCount: number;
    tone: string;
    audience: string;
}) => `You are an expert cold-email copywriter. Generate a ${ctx.stepCount}-step cold-email sequence based on the source material below.

Tone: ${ctx.tone}
Audience: ${ctx.audience || 'B2B decision-makers in the relevant ICP'}
${ctx.customInstructions ? `Operator instructions: ${ctx.customInstructions}\n` : ''}
Source material (scraped from operator URLs):
"""
${ctx.markdown.slice(0, 12000)}
"""

Rules:
- Step 1 is the cold opener. Steps 2..N are follow-ups; each should reference the prior step lightly without resending it.
- Vary the angles across steps: value prop, social proof, specific use case, breakup.
- Personalization tokens to use literally: {{first_name}} {{last_name}} {{company}} {{title}}
- Keep each body under 130 words. Subject lines under 60 chars.
- Each step needs a preheader: a one-line inbox snippet (40–90 chars) that complements the subject.
- delay_days for step N: step 1 = 0; steps 2+ = 2-4 days apart.
- Use <p> tags for paragraphs; no <html> or <body> wrappers.
- No greetings like "Hi {{first_name}}" - write as if the greeting will be prepended by the system.

Respond with ONLY a JSON object matching this exact shape:
{
  "name": "<short 3-6 word descriptive name>",
  "description": "<one-line description of the sequence's angle>",
  "steps": [
    {
      "step_number": 1,
      "delay_days": 0,
      "delay_hours": 0,
      "subject": "<subject>",
      "preheader": "<preheader>",
      "body_html": "<p>body</p>"
    }
    /* ...up to ${ctx.stepCount} steps */
  ]
}`;

export async function generateSequenceWithAi(input: AiGenerateInput): Promise<AiGenerateResult> {
    if (!isGeminiConfigured()) {
        throw new Error('AI sequence generation is not configured on this server (GEMINI_API_KEY missing).');
    }

    const urls = (input.urls || []).map(u => u.trim()).filter(Boolean);
    if (urls.length === 0) throw new Error('At least one URL is required for AI generation');
    if (urls.length > 5) throw new Error('At most 5 URLs per generation request');

    const stepCount = Math.max(1, Math.min(10, Math.floor(input.stepCount || 3)));

    const { markdown, failures } = await scrapeUrls(urls);
    if (!markdown.trim()) {
        const detail = failures.map(f => `${f.url}: ${f.error}`).join('; ');
        throw new Error(`No source URL was reachable. ${detail}`);
    }
    if (failures.length > 0) {
        logger.warn('[SEQUENCE_AI] Partial scrape', { failed: failures.length, total: urls.length });
    }

    const prompt = GENERATE_PROMPT_TEMPLATE({
        markdown,
        customInstructions: input.customInstructions || '',
        stepCount,
        tone: input.tone || 'neutral',
        audience: input.audience || '',
    });

    const { text } = await safeGeminiCompletion({
        prompt,
        temperature: 0.6,
        maxTokens: 4_000,
        jsonMode: true,
        tag: 'sequence.generate',
    });

    if (!text || text.trim() === '{}') {
        throw new Error('AI returned an empty response - try again or refine the instructions');
    }

    let parsed: { name?: string; description?: string; steps?: SequenceStepInput[] };
    try {
        parsed = JSON.parse(text);
    } catch {
        throw new Error('AI returned unparseable JSON');
    }

    if (!Array.isArray(parsed.steps) || parsed.steps.length === 0) {
        throw new Error('AI response did not include any steps');
    }

    // Sanitize each step - trim, default delays, normalize step numbers.
    const steps: SequenceStepInput[] = parsed.steps.map((s, i) => ({
        step_number: i + 1,
        delay_days: typeof s.delay_days === 'number' ? Math.max(0, Math.min(60, s.delay_days)) : (i === 0 ? 0 : 3),
        delay_hours: typeof s.delay_hours === 'number' ? Math.max(0, Math.min(23, s.delay_hours)) : 0,
        subject: (s.subject || '').slice(0, 200),
        preheader: (s.preheader || '').slice(0, 200),
        body_html: s.body_html || '',
    }));

    return {
        name: (parsed.name || 'Untitled sequence').slice(0, 100),
        description: (parsed.description || '').slice(0, 280),
        steps,
        sources: urls.map(u => {
            const fail = failures.find(f => f.url === u);
            return fail ? { url: u, ok: false, error: fail.error } : { url: u, ok: true };
        }),
        modelUsed: process.env.GEMINI_MODEL || 'gemini-2.0-flash',
    };
}
