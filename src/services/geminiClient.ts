/**
 * Gemini Flash client - single canonical wrapper for Google's Generative AI.
 *
 * Mirrors the openaiClient.ts design so failure modes are consistent:
 *
 *   1. RETRY on transient failures (429, 5xx, network blips) with
 *      exponential backoff + full jitter. 4xx validation errors short-circuit.
 *
 *   2. SEMAPHORE on concurrent in-flight calls. Per-process cap configurable
 *      via GEMINI_MAX_CONCURRENT (default 15 - sized smaller than OpenAI's
 *      25 because Gemini Flash's free + paid quotas are tighter than
 *      OpenAI's at small payload sizes).
 *
 *   3. STUB FALLBACK when GEMINI_API_KEY is unset. Returns a deterministic
 *      synthetic response so dev/staging without the key can still exercise
 *      callers' control flow. The shape matches the live SDK so swapping
 *      the env var in flips real calls on with no code change.
 *
 * Every code path that hits Gemini chat completions MUST go through
 * `safeGeminiCompletion`. Direct SDK calls bypass both protections.
 *
 * Model: gemini-2.0-flash by default. Override via GEMINI_MODEL.
 */

import { logger } from './observabilityService';

const MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';

// ────────────────────────────────────────────────────────────────────
// Configuration check
// ────────────────────────────────────────────────────────────────────

export function isGeminiConfigured(): boolean {
    return Boolean(process.env.GEMINI_API_KEY);
}

// ────────────────────────────────────────────────────────────────────
// Semaphore - per-process concurrency cap, FIFO wait queue
// ────────────────────────────────────────────────────────────────────

const MAX_CONCURRENT = parseInt(process.env.GEMINI_MAX_CONCURRENT || '15', 10);
let inFlight = 0;
const waitQueue: Array<() => void> = [];

function acquireSlot(): Promise<() => void> {
    return new Promise(resolve => {
        const grant = () => {
            inFlight += 1;
            const release = () => {
                inFlight -= 1;
                const next = waitQueue.shift();
                if (next) next();
            };
            resolve(release);
        };
        if (inFlight < MAX_CONCURRENT) grant();
        else waitQueue.push(grant);
    });
}

export function getGeminiStats() {
    return { inFlight, waiting: waitQueue.length, maxConcurrent: MAX_CONCURRENT };
}

// ────────────────────────────────────────────────────────────────────
// Retry helper
// ────────────────────────────────────────────────────────────────────

const RETRY_DELAYS_MS = [1_500, 3_000, 6_000];
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

function isRetryable(err: unknown): boolean {
    const e = err as { status?: number; code?: string; message?: string };
    if (typeof e?.status === 'number' && RETRYABLE_STATUSES.has(e.status)) return true;
    const msg = (e?.message || '').toLowerCase();
    if (msg.includes('econnreset') || msg.includes('etimedout') || msg.includes('socket hang up')) return true;
    if (msg.includes('connection error') || msg.includes('timeout')) return true;
    // Gemini SDK surfaces some retryable errors as `RESOURCE_EXHAUSTED` text.
    if (msg.includes('resource_exhausted') || msg.includes('rate limit')) return true;
    return false;
}

function jitter(baseMs: number): number {
    const factor = 0.75 + Math.random() * 0.5;
    return Math.round(baseMs * factor);
}

// ────────────────────────────────────────────────────────────────────
// SDK loader - same indirect dynamic-import trick as SES, so the dev
// box doesn't need @google/generative-ai installed when stub mode is fine.
// ────────────────────────────────────────────────────────────────────

interface GeminiResponse {
    text: string;
    /** Approximate token usage if the SDK reports it. Used for cost telemetry. */
    promptTokens?: number;
    completionTokens?: number;
}

async function callRealGemini(prompt: string, opts: { temperature?: number; maxTokens?: number; jsonMode?: boolean }): Promise<GeminiResponse> {
    const dynamicImport: (m: string) => Promise<any> = (m) =>
        // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
        new Function('m', 'return import(m)')(m);
    const sdk: any = await dynamicImport('@google/generative-ai');

    const client = new sdk.GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = client.getGenerativeModel({
        model: MODEL,
        generationConfig: {
            temperature: opts.temperature ?? 0.2,
            maxOutputTokens: opts.maxTokens ?? 256,
            // Force JSON-only output when the caller is parsing structured
            // responses - Gemini honors responseMimeType for strict modes.
            ...(opts.jsonMode ? { responseMimeType: 'application/json' } : {}),
        },
    });

    const result = await model.generateContent(prompt);
    const text: string = result?.response?.text?.() ?? '';
    const usage = result?.response?.usageMetadata;
    return {
        text,
        promptTokens: usage?.promptTokenCount,
        completionTokens: usage?.candidatesTokenCount,
    };
}

// ────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────

export interface SafeGeminiInput {
    prompt: string;
    /** 0–1; defaults to 0.2 for classification work where we want determinism. */
    temperature?: number;
    /** Max output tokens. Defaults to 256 - enough for a single-line label
     *  + short reasoning, which is what every caller here needs. */
    maxTokens?: number;
    /** When true, Gemini is constrained to emit valid JSON. */
    jsonMode?: boolean;
    /** Logging tag for retry warnings. */
    tag?: string;
}

/**
 * Drop-in completion helper. Stub mode emits a deterministic placeholder
 * so callers can detect the unconfigured case without try/catching.
 */
export async function safeGeminiCompletion(input: SafeGeminiInput): Promise<GeminiResponse> {
    if (!isGeminiConfigured()) {
        logger.info('[GEMINI] Stub mode - returning placeholder response', { tag: input.tag });
        // jsonMode callers expect parseable JSON. Empty object is a
        // safe sentinel - downstream sees "no AI verdict" and proceeds
        // with the rule-based label.
        return {
            text: input.jsonMode ? '{}' : '',
            promptTokens: 0,
            completionTokens: 0,
        };
    }

    const release = await acquireSlot();
    try {
        let lastError: unknown = null;
        for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
            try {
                return await callRealGemini(input.prompt, {
                    temperature: input.temperature,
                    maxTokens: input.maxTokens,
                    jsonMode: input.jsonMode,
                });
            } catch (err) {
                lastError = err;
                if (!isRetryable(err) || attempt === RETRY_DELAYS_MS.length) throw err;
                const wait = jitter(RETRY_DELAYS_MS[attempt]);
                const e = err as { status?: number; code?: string; message?: string };
                logger.warn('[GEMINI] Retryable failure - backing off', {
                    tag: input.tag,
                    attempt: attempt + 1,
                    of: RETRY_DELAYS_MS.length + 1,
                    waitMs: wait,
                    status: e?.status,
                    code: e?.code,
                    msg: (e?.message || '').slice(0, 200),
                });
                await new Promise(resolve => setTimeout(resolve, wait));
            }
        }
        throw lastError;
    } finally {
        release();
    }
}
