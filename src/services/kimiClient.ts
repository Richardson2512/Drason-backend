/**
 * Kimi K2.5 client - Moonshot AI's multi-agent-friendly model. Powers the
 * Super LinkedIn agent layer (supervisor, signal monitoring, enrichment,
 * reply classifier).
 *
 * Mirrors the openaiClient.ts / geminiClient.ts design so failure modes
 * are consistent across all three model providers:
 *
 *   1. RETRY on transient failures (429, 5xx, network blips) with
 *      exponential backoff + full jitter. 4xx validation errors short-circuit.
 *
 *   2. SEMAPHORE on concurrent in-flight calls. Per-process cap configurable
 *      via KIMI_MAX_CONCURRENT (default 20 - sized between Gemini's 15 and
 *      OpenAI's 25 since Moonshot's rate limits are middle-of-pack).
 *
 *   3. STUB FALLBACK when KIMI_API_KEY is unset. Returns a deterministic
 *      synthetic response so dev/staging without the key can still exercise
 *      callers' control flow.
 *
 * Moonshot exposes an OpenAI-compatible chat completions endpoint at
 * https://api.moonshot.ai/v1, so we use the openai SDK pointed at that
 * base URL instead of a vendor-specific client.
 *
 * Model: kimi-k2-0905-preview by default (latest K2.5 family snapshot at
 * the time of writing). Override via KIMI_MODEL.
 */

import { logger } from './observabilityService';

const MODEL = process.env.KIMI_MODEL || 'kimi-k2-0905-preview';
const BASE_URL = process.env.KIMI_BASE_URL || 'https://api.moonshot.ai/v1';

// ────────────────────────────────────────────────────────────────────
// Configuration check
// ────────────────────────────────────────────────────────────────────

export function isKimiConfigured(): boolean {
    return Boolean(process.env.KIMI_API_KEY);
}

// ────────────────────────────────────────────────────────────────────
// Semaphore - per-process concurrency cap, FIFO wait queue
// ────────────────────────────────────────────────────────────────────

const MAX_CONCURRENT = parseInt(process.env.KIMI_MAX_CONCURRENT || '20', 10);
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

export function getKimiStats() {
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
    if (msg.includes('rate limit') || msg.includes('resource_exhausted')) return true;
    return false;
}

function jitter(baseMs: number): number {
    const factor = 0.75 + Math.random() * 0.5;
    return Math.round(baseMs * factor);
}

// ────────────────────────────────────────────────────────────────────
// SDK loader - indirect dynamic import so the dev box doesn't need the
// openai package installed when stub mode is fine.
// ────────────────────────────────────────────────────────────────────

interface KimiResponse {
    text: string;
    /** Token usage when the API reports it - used for cost telemetry. */
    promptTokens?: number;
    completionTokens?: number;
}

async function callRealKimi(
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    opts: { temperature?: number; maxTokens?: number; jsonMode?: boolean }
): Promise<KimiResponse> {
    const dynamicImport: (m: string) => Promise<any> = (m) =>
        // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
        new Function('m', 'return import(m)')(m);
    const sdk: any = await dynamicImport('openai');

    const client = new sdk.OpenAI({
        apiKey: process.env.KIMI_API_KEY,
        baseURL: BASE_URL,
    });

    const result = await client.chat.completions.create({
        model: MODEL,
        messages,
        temperature: opts.temperature ?? 0.2,
        max_tokens: opts.maxTokens ?? 512,
        ...(opts.jsonMode ? { response_format: { type: 'json_object' } } : {}),
    });

    const text: string = result?.choices?.[0]?.message?.content ?? '';
    const usage = result?.usage;
    return {
        text,
        promptTokens: usage?.prompt_tokens,
        completionTokens: usage?.completion_tokens,
    };
}

// ────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────

export interface SafeKimiInput {
    /** Either a single user prompt OR a full message array (system + user). */
    prompt?: string;
    messages?: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
    /** 0-1; defaults to 0.2 for classification work where we want determinism. */
    temperature?: number;
    /** Max output tokens. Defaults to 512 - enough for structured agent outputs. */
    maxTokens?: number;
    /** When true, model is constrained to emit valid JSON. */
    jsonMode?: boolean;
    /** Logging tag for retry warnings. */
    tag?: string;
}

/**
 * Drop-in completion helper. Stub mode emits a deterministic placeholder
 * so callers can detect the unconfigured case without try/catching.
 */
export async function safeKimiCompletion(input: SafeKimiInput): Promise<KimiResponse> {
    if (!isKimiConfigured()) {
        logger.info('[KIMI] Stub mode - returning placeholder response', { tag: input.tag });
        return {
            text: input.jsonMode ? '{}' : '',
            promptTokens: 0,
            completionTokens: 0,
        };
    }

    const messages = input.messages
        ?? (input.prompt ? [{ role: 'user' as const, content: input.prompt }] : []);
    if (messages.length === 0) {
        throw new Error('[KIMI] Either prompt or messages must be provided');
    }

    const release = await acquireSlot();
    try {
        let lastError: unknown = null;
        for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
            try {
                return await callRealKimi(messages, {
                    temperature: input.temperature,
                    maxTokens: input.maxTokens,
                    jsonMode: input.jsonMode,
                });
            } catch (err) {
                lastError = err;
                if (!isRetryable(err) || attempt === RETRY_DELAYS_MS.length) throw err;
                const wait = jitter(RETRY_DELAYS_MS[attempt]);
                const e = err as { status?: number; code?: string; message?: string };
                logger.warn('[KIMI] Retryable failure - backing off', {
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
