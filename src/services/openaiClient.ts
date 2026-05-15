/**
 * OpenAI Client - single canonical wrapper around chat.completions calls.
 *
 * Two responsibilities, one entry point:
 *
 *   1. RETRY on transient failures.
 *      OpenAI's 429 / 500 / 502 / 503 / 504 are retryable; their 4xx
 *      validation errors are not. Network / timeout errors are retried
 *      because they almost always indicate a momentary upstream blip.
 *      Backoff is exponential with full jitter (2s → 4s → 8s, ±25%) so
 *      a stampede doesn't synchronize their retries.
 *
 *   2. SEMAPHORE on concurrent in-flight calls.
 *      Caps how many OpenAI requests this Node process holds open at
 *      once. Configurable via OPENAI_MAX_CONCURRENT (default 25 - chosen
 *      to stay comfortably inside Tier-2 RPM/TPM budgets at typical
 *      gpt-4o-mini token sizes; bump if you're on a higher tier).
 *      The (max+1)th call waits in-process for a slot; user latency
 *      grows but no request gets dropped.
 *
 * Every code path that calls OpenAI for chat.completions MUST go through
 * `safeCompletion`. Direct `openai.chat.completions.create(...)` calls
 * bypass both protections and will starve other callers under load.
 */

import OpenAI from 'openai';
import { logger } from './observabilityService';

// ────────────────────────────────────────────────────────────────────
// Singleton client
// ────────────────────────────────────────────────────────────────────

let _openai: OpenAI | null = null;

export function getOpenAIClient(): OpenAI {
    if (!_openai) {
        const apiKey = process.env.OPENAI_API_KEY;
        if (!apiKey) throw new Error('OPENAI_API_KEY is not configured');
        _openai = new OpenAI({ apiKey });
    }
    return _openai;
}

// ────────────────────────────────────────────────────────────────────
// Semaphore - caps concurrent in-flight OpenAI calls per Node process.
//
// FIFO queue: requests waiting for a slot are served in arrival order so
// no caller can be indefinitely starved by a steady stream of new
// requests. `acquire()` resolves when a slot is available; the returned
// release function MUST be called in a finally block to guarantee the
// slot is returned even on error paths.
// ────────────────────────────────────────────────────────────────────

const MAX_CONCURRENT = parseInt(process.env.OPENAI_MAX_CONCURRENT || '25', 10);

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
        if (inFlight < MAX_CONCURRENT) {
            grant();
        } else {
            waitQueue.push(grant);
        }
    });
}

/** Diagnostic - exposed for the /api/ai/status endpoint or future
 *  metrics. Not used by callers. */
export function getOpenAIStats() {
    return { inFlight, waiting: waitQueue.length, maxConcurrent: MAX_CONCURRENT };
}

// ────────────────────────────────────────────────────────────────────
// Retry helper - exponential backoff with full jitter.
// ────────────────────────────────────────────────────────────────────

const RETRY_DELAYS_MS = [2_000, 4_000, 8_000]; // 3 attempts after the first
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

interface OpenAIErrorLike {
    status?: number;
    code?: string;
    message?: string;
}

function isRetryable(err: unknown): boolean {
    const e = err as OpenAIErrorLike;
    if (typeof e?.status === 'number' && RETRYABLE_STATUSES.has(e.status)) return true;
    // Network errors typically lack a status. The OpenAI SDK surfaces them
    // as APIConnectionError / APIConnectionTimeoutError with no status.
    const msg = (e?.message || '').toLowerCase();
    if (msg.includes('econnreset') || msg.includes('etimedout') || msg.includes('socket hang up')) return true;
    if (msg.includes('connection error') || msg.includes('timeout')) return true;
    return false;
}

function jitter(baseMs: number): number {
    // ±25% jitter avoids synchronized stampedes on 429.
    const factor = 0.75 + Math.random() * 0.5;
    return Math.round(baseMs * factor);
}

// ────────────────────────────────────────────────────────────────────
// Public API - `safeCompletion`
//
// Drop-in replacement for `client.chat.completions.create`. Same input,
// same output, plus retry + semaphore behavior.
// ────────────────────────────────────────────────────────────────────

export async function safeCompletion(
    params: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
    opts: { tag?: string } = {},
): Promise<OpenAI.Chat.ChatCompletion> {
    const release = await acquireSlot();
    const tag = opts.tag || 'unknown';

    try {
        const client = getOpenAIClient();
        let lastError: unknown = null;

        for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
            try {
                return await client.chat.completions.create(params);
            } catch (err) {
                lastError = err;
                if (!isRetryable(err) || attempt === RETRY_DELAYS_MS.length) {
                    // Either non-retryable, or we've exhausted retries.
                    throw err;
                }
                const baseDelay = RETRY_DELAYS_MS[attempt];
                const wait = jitter(baseDelay);
                const e = err as OpenAIErrorLike;
                logger.warn('[OPENAI] Retryable failure - backing off', {
                    tag,
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

        // Unreachable - the loop either returns or throws - but TS needs
        // the explicit fall-through.
        throw lastError;
    } finally {
        release();
    }
}
