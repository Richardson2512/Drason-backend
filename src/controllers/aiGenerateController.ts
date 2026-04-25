/**
 * AI Generation Controller
 *
 * POST /api/ai/generate-step        — one email (used by templates + individual step editor)
 * POST /api/ai/generate-sequence    — N emails in one call (used by "generate whole sequence")
 *
 * Both require a cached BusinessProfile. If missing, return 409 with a hint
 * for the UI to prompt the user to set their company URL first.
 */

import { Request, Response } from 'express';
import { logger } from '../services/observabilityService';
import { getOrgId } from '../middleware/orgContext';
import {
    generateEmailStep,
    generateFullSequence,
    getCachedProfile,
    StepIntent,
    type GenerateStepInput,
    type GenerateSequenceInput,
} from '../services/aiCopywritingService';

// ────────────────────────────────────────────────────────────────────
// In-memory per-org rate limiter — prevents runaway costs.
// Hard cap: 15 generations/minute per org.
// ────────────────────────────────────────────────────────────────────

const GEN_LIMIT_PER_MINUTE = 15;
const windowState = new Map<string, { windowStart: number; count: number }>();

function checkRateLimit(orgId: string): { ok: boolean; retryAfterSec?: number } {
    const now = Date.now();
    const slot = windowState.get(orgId);
    if (!slot || now - slot.windowStart > 60_000) {
        windowState.set(orgId, { windowStart: now, count: 1 });
        return { ok: true };
    }
    if (slot.count >= GEN_LIMIT_PER_MINUTE) {
        return { ok: false, retryAfterSec: Math.ceil((60_000 - (now - slot.windowStart)) / 1000) };
    }
    slot.count += 1;
    return { ok: true };
}

// ────────────────────────────────────────────────────────────────────
// Input validation
// ────────────────────────────────────────────────────────────────────

const VALID_INTENTS: StepIntent[] = ['intro', 'follow_up', 'value_add', 'social_proof', 'breakup', 'custom'];
const VALID_TONES = ['casual', 'neutral', 'professional', 'direct'];

function coerceStepInput(body: any): GenerateStepInput | { error: string } {
    const intent = body?.step_intent;
    if (!VALID_INTENTS.includes(intent)) {
        return { error: `step_intent must be one of ${VALID_INTENTS.join(', ')}` };
    }
    const tone = body?.tone;
    if (tone !== undefined && !VALID_TONES.includes(tone)) {
        return { error: `tone must be one of ${VALID_TONES.join(', ')}` };
    }
    const stepNumber = body?.step_number;
    const totalSteps = body?.total_steps;
    if (stepNumber !== undefined && (typeof stepNumber !== 'number' || stepNumber < 1)) {
        return { error: 'step_number must be a positive integer' };
    }
    if (totalSteps !== undefined && (typeof totalSteps !== 'number' || totalSteps < 1 || totalSteps > 7)) {
        return { error: 'total_steps must be between 1 and 7' };
    }
    const wordBudget = body?.word_budget;
    if (wordBudget !== undefined && (typeof wordBudget !== 'number' || wordBudget < 20 || wordBudget > 500)) {
        return { error: 'word_budget must be between 20 and 500' };
    }
    const variantOf = body?.variant_of;
    if (variantOf !== undefined) {
        if (!variantOf.subject || !variantOf.body_html) {
            return { error: 'variant_of must include subject and body_html' };
        }
    }
    const customInstructions = body?.custom_instructions;
    if (customInstructions !== undefined && (typeof customInstructions !== 'string' || customInstructions.length > 2000)) {
        return { error: 'custom_instructions must be a string under 2000 chars' };
    }

    return {
        step_intent: intent,
        step_number: stepNumber,
        total_steps: totalSteps,
        tone,
        word_budget: wordBudget,
        custom_instructions: customInstructions,
        variant_of: variantOf,
    };
}

// ────────────────────────────────────────────────────────────────────
// POST /api/ai/generate-step
// ────────────────────────────────────────────────────────────────────

export const generateStep = async (req: Request, res: Response): Promise<Response> => {
    const orgId = getOrgId(req);

    const rate = checkRateLimit(orgId);
    if (!rate.ok) {
        res.setHeader('Retry-After', String(rate.retryAfterSec || 60));
        return res.status(429).json({ success: false, error: `AI generation rate limit exceeded. Retry in ${rate.retryAfterSec}s.` });
    }

    const input = coerceStepInput(req.body);
    if ('error' in input) {
        return res.status(400).json({ success: false, error: input.error });
    }

    const profile = await getCachedProfile(orgId);
    if (!profile) {
        return res.status(409).json({
            success: false,
            error: 'No business profile configured. Add your company URL first.',
            code: 'PROFILE_REQUIRED',
        });
    }

    try {
        const { email, promptTokens, completionTokens } = await generateEmailStep(profile, input);
        return res.json({
            success: true,
            data: {
                email,
                usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens },
            },
        });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error('[AI_GEN] generateStep failed', err instanceof Error ? err : new Error(msg), { orgId });
        const userFacing =
            msg.includes('OPENAI_API_KEY') ? 'AI is not configured on this server.' :
            msg.includes('rate_limit') || msg.includes('429') ? 'OpenAI is throttling requests — try again shortly.' :
            msg.includes('incomplete email') ? 'AI returned an incomplete email. Try again.' :
            'Generation failed. Try again.';
        return res.status(502).json({ success: false, error: userFacing });
    }
};

// ────────────────────────────────────────────────────────────────────
// POST /api/ai/generate-sequence
// ────────────────────────────────────────────────────────────────────

function coerceSequenceInput(body: any): GenerateSequenceInput | { error: string } {
    const totalSteps = body?.total_steps;
    if (typeof totalSteps !== 'number' || totalSteps < 1 || totalSteps > 7) {
        return { error: 'total_steps must be between 1 and 7' };
    }
    const intents = body?.intents;
    if (intents !== undefined) {
        if (!Array.isArray(intents)) return { error: 'intents must be an array' };
        if (intents.length !== totalSteps) return { error: 'intents length must equal total_steps' };
        for (const i of intents) {
            if (!VALID_INTENTS.includes(i)) return { error: `invalid intent: ${i}` };
        }
    }
    const tone = body?.tone;
    if (tone !== undefined && !VALID_TONES.includes(tone)) {
        return { error: `tone must be one of ${VALID_TONES.join(', ')}` };
    }
    return {
        total_steps: totalSteps,
        intents,
        tone,
        word_budget: body?.word_budget,
        custom_instructions: body?.custom_instructions,
    };
}

export const generateSequence = async (req: Request, res: Response): Promise<Response> => {
    const orgId = getOrgId(req);

    // Budget-check: generating a sequence counts as N calls against the per-minute cap.
    const requested = Number(req.body?.total_steps || 0);
    for (let i = 0; i < requested; i++) {
        const rate = checkRateLimit(orgId);
        if (!rate.ok) {
            res.setHeader('Retry-After', String(rate.retryAfterSec || 60));
            return res.status(429).json({ success: false, error: `AI generation rate limit exceeded. Retry in ${rate.retryAfterSec}s.` });
        }
    }

    const input = coerceSequenceInput(req.body);
    if ('error' in input) {
        return res.status(400).json({ success: false, error: input.error });
    }

    const profile = await getCachedProfile(orgId);
    if (!profile) {
        return res.status(409).json({
            success: false,
            error: 'No business profile configured. Add your company URL first.',
            code: 'PROFILE_REQUIRED',
        });
    }

    try {
        const { emails, promptTokens, completionTokens } = await generateFullSequence(profile, input);
        return res.json({
            success: true,
            data: {
                emails,
                usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens },
            },
        });
    } catch (err) {
        logger.error('[AI_GEN] generateSequence failed', err instanceof Error ? err : new Error(String(err)), { orgId });
        return res.status(502).json({ success: false, error: 'Sequence generation failed. Try again.' });
    }
};
