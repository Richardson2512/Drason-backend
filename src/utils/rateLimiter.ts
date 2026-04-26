/**
 * Rate Limiter Utility
 *
 * Token-bucket rate limiter for external API calls (Postmaster Tools, SNDS,
 * MillionVerifier, etc. as those integrations come online).
 *
 * Features:
 * - Token bucket algorithm for smooth rate limiting
 * - Request queuing when limit exceeded
 * - Automatic retry with exponential backoff on 429 errors
 * - Per-organization rate limiting (multi-tenant safe)
 */

import { logger } from '../services/observabilityService';
import { trackApiCall } from '../services/apiCallTracker';

interface RateLimiterConfig {
    maxRequests: number;      // Maximum requests allowed
    windowMs: number;         // Time window in milliseconds
    queueLimit?: number;      // Maximum queued requests (default: 1000)
    platform?: string;        // Platform name for API call tracking
}

interface QueuedRequest {
    resolve: (value: any) => void;
    reject: (error: any) => void;
    fn: () => Promise<any>;
    retryCount: number;
}

export class RateLimiter {
    private tokens: number;
    private readonly maxTokens: number;
    private readonly refillRate: number; // Tokens per millisecond
    private lastRefill: number;
    private queue: QueuedRequest[] = [];
    private processing: boolean = false;
    private readonly queueLimit: number;
    private readonly platform: string;

    constructor(config: RateLimiterConfig) {
        this.maxTokens = config.maxRequests;
        this.tokens = this.maxTokens;
        this.refillRate = config.maxRequests / config.windowMs;
        this.lastRefill = Date.now();
        this.queueLimit = config.queueLimit || 1000;
        this.platform = config.platform || 'unknown';

        logger.info('[RATE_LIMITER] Initialized', {
            maxRequests: config.maxRequests,
            windowMs: config.windowMs,
            refillRatePerMs: this.refillRate.toFixed(6)
        });
    }

    /**
     * Refill tokens based on time elapsed since last refill.
     */
    private refillTokens(): void {
        const now = Date.now();
        const elapsed = now - this.lastRefill;
        const tokensToAdd = elapsed * this.refillRate;

        this.tokens = Math.min(this.maxTokens, this.tokens + tokensToAdd);
        this.lastRefill = now;
    }

    /**
     * Execute a function with rate limiting.
     * If rate limit exceeded, queues the request.
     * 429 errors are retried indefinitely with exponential backoff (capped at 30s).
     *
     * @param fn - Async function to execute
     * @returns Promise that resolves with function result
     */
    async execute<T>(
        fn: () => Promise<T>,
        trackingInfo?: { orgId: string; endpoint: string },
    ): Promise<T> {
        const startTime = Date.now();

        return new Promise<T>((resolve, reject) => {
            const wrappedFn = async () => {
                const result = await fn();
                // Track successful call
                if (trackingInfo) {
                    const duration = Date.now() - startTime;
                    const statusCode = (result as any)?.status || (result as any)?.data ? 200 : undefined;
                    trackApiCall(trackingInfo.orgId, this.platform, trackingInfo.endpoint, statusCode, duration);
                }
                return result;
            };

            const wrappedReject = (error: any) => {
                // Track failed call
                if (trackingInfo) {
                    const duration = Date.now() - startTime;
                    const statusCode = error?.response?.status;
                    trackApiCall(trackingInfo.orgId, this.platform, trackingInfo.endpoint, statusCode, duration, error?.message?.substring(0, 200));
                }
                reject(error);
            };

            const request: QueuedRequest = {
                resolve,
                reject: wrappedReject,
                fn: wrappedFn,
                retryCount: 0
            };

            // Check queue limit
            if (this.queue.length >= this.queueLimit) {
                reject(new Error(`Rate limiter queue full (${this.queueLimit} requests)`));
                return;
            }

            this.queue.push(request);
            this.processQueue();
        });
    }

    /**
     * Process queued requests respecting rate limits.
     */
    private async processQueue(): Promise<void> {
        if (this.processing || this.queue.length === 0) {
            return;
        }

        this.processing = true;

        while (this.queue.length > 0) {
            this.refillTokens();

            if (this.tokens >= 1) {
                // Consume token and process request
                this.tokens -= 1;
                const request = this.queue.shift()!;

                try {
                    const result = await request.fn();
                    request.resolve(result);
                } catch (error: any) {
                    const status = error.response?.status;
                    const message = error.message?.toLowerCase() || '';

                    // Check if it's a retryable error:
                    // - 429: rate limited (always retry, indefinitely)
                    // - 500/502/503: transient server error (retry up to 5 times)
                    // - ECONNRESET/ETIMEDOUT/CircuitOpenError: transient network/breaker (retry up to 5 times)
                    const is429 = status === 429 ||
                        message.includes('rate limit') ||
                        message.includes('too many requests');

                    const isTransient = status === 500 || status === 502 || status === 503 ||
                        message.includes('econnreset') ||
                        message.includes('etimedout') ||
                        message.includes('socket hang up') ||
                        message.includes('circuit breaker open');

                    const MAX_TRANSIENT_RETRIES = 5;

                    if (is429) {
                        // 429 means "slow down" — always retry with exponential backoff,
                        // capped at 30s. Never give up on a rate limit; the data must land.
                        request.retryCount++;
                        const delayMs = Math.min(
                            Math.pow(2, request.retryCount) * 1000, // 2s, 4s, 8s, 16s, ...
                            30_000                                   // cap at 30s
                        );

                        logger.warn('[RATE_LIMITER] 429 error, retrying after delay', {
                            retryCount: request.retryCount,
                            delayMs
                        });

                        await this.delay(delayMs);
                        this.queue.unshift(request);
                    } else if (isTransient && request.retryCount < MAX_TRANSIENT_RETRIES) {
                        // Transient server/network error — retry with backoff, up to limit
                        request.retryCount++;
                        const delayMs = Math.min(
                            Math.pow(2, request.retryCount) * 1000,
                            15_000
                        );

                        logger.warn('[RATE_LIMITER] Transient error, retrying after delay', {
                            retryCount: request.retryCount,
                            maxRetries: MAX_TRANSIENT_RETRIES,
                            delayMs,
                            status,
                            error: error.message?.slice(0, 200),
                        });

                        await this.delay(delayMs);
                        this.queue.unshift(request);
                    } else {
                        // Non-retryable error or max retries exceeded — reject
                        request.reject(error);
                    }
                }
            } else {
                // No tokens available - wait for refill
                const waitTime = Math.ceil((1 - this.tokens) / this.refillRate);
                await this.delay(Math.min(waitTime, 100)); // Max 100ms wait per iteration
            }
        }

        this.processing = false;
    }

    /**
     * Wait for specified milliseconds.
     */
    private delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Get current rate limiter stats (for monitoring).
     */
    getStats(): {
        tokens: number;
        queueLength: number;
        processing: boolean;
    } {
        return {
            tokens: Math.floor(this.tokens * 100) / 100,
            queueLength: this.queue.length,
            processing: this.processing
        };
    }
}

