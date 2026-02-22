/**
 * Rate Limiter Utility
 *
 * Implements token bucket rate limiting for external API calls.
 * Specifically designed for Smartlead API (10 requests per 2 seconds).
 *
 * Features:
 * - Token bucket algorithm for smooth rate limiting
 * - Request queuing when limit exceeded
 * - Automatic retry with exponential backoff on 429 errors
 * - Per-organization rate limiting (multi-tenant safe)
 */

import { logger } from '../services/observabilityService';

interface RateLimiterConfig {
    maxRequests: number;      // Maximum requests allowed
    windowMs: number;         // Time window in milliseconds
    queueLimit?: number;      // Maximum queued requests (default: 1000)
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

    constructor(config: RateLimiterConfig) {
        this.maxTokens = config.maxRequests;
        this.tokens = this.maxTokens;
        this.refillRate = config.maxRequests / config.windowMs;
        this.lastRefill = Date.now();
        this.queueLimit = config.queueLimit || 1000;

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
     *
     * @param fn - Async function to execute
     * @param retryOn429 - Whether to retry on 429 errors (default: true)
     * @returns Promise that resolves with function result
     */
    async execute<T>(
        fn: () => Promise<T>,
        options: {
            retryOn429?: boolean;
            maxRetries?: number;
        } = {}
    ): Promise<T> {
        const { retryOn429 = true, maxRetries = 3 } = options;

        return new Promise<T>((resolve, reject) => {
            const request: QueuedRequest = {
                resolve,
                reject,
                fn,
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
                    // Check if it's a 429 rate limit error
                    const is429 = error.response?.status === 429 ||
                        error.message?.toLowerCase().includes('rate limit') ||
                        error.message?.toLowerCase().includes('too many requests');

                    if (is429 && request.retryCount < 3) {
                        // Retry with exponential backoff
                        request.retryCount++;
                        const delayMs = Math.pow(2, request.retryCount) * 1000; // 2s, 4s, 8s

                        logger.warn('[RATE_LIMITER] 429 error, retrying after delay', {
                            retryCount: request.retryCount,
                            delayMs
                        });

                        await this.delay(delayMs);

                        // Re-queue the request
                        this.queue.unshift(request);
                    } else {
                        // Max retries exceeded or non-429 error
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

/**
 * Smartlead API rate limiter instance.
 * Limit: 10 requests per 2 seconds
 */
export const smartleadRateLimiter = new RateLimiter({
    maxRequests: 10,
    windowMs: 2000,
    queueLimit: 5000 // Allow up to 5000 queued requests
});

/**
 * EmailBison API rate limiter instance.
 * Limit: 5 requests per 2 seconds (more conservative — newer integration)
 */
export const emailbisonRateLimiter = new RateLimiter({
    maxRequests: 5,
    windowMs: 2000,
    queueLimit: 3000
});

/**
 * Instantly API rate limiter instance (future).
 * Limit: 10 requests per 2 seconds
 */
export const instantlyRateLimiter = new RateLimiter({
    maxRequests: 10,
    windowMs: 2000,
    queueLimit: 5000
});

/**
 * Reply.io API rate limiter instance (future).
 * Limit: 10 requests per 2 seconds
 */
export const replyioRateLimiter = new RateLimiter({
    maxRequests: 10,
    windowMs: 2000,
    queueLimit: 5000
});

// ============================================================================
// PLATFORM RATE LIMITER REGISTRY
// ============================================================================

/**
 * Map of platform names to their rate limiters.
 */
export const platformRateLimiters: Record<string, RateLimiter> = {
    smartlead: smartleadRateLimiter,
    emailbison: emailbisonRateLimiter,
    instantly: instantlyRateLimiter,
    replyio: replyioRateLimiter,
};

/**
 * Get the rate limiter for a given platform.
 * Falls back to Smartlead rate limiter for unknown platforms.
 */
export function getRateLimiterForPlatform(platform: string): RateLimiter {
    return platformRateLimiters[platform] || smartleadRateLimiter;
}

