/**
 * Circuit Breaker
 * 
 * Prevents cascading failures when external services (Smartlead API) go down.
 * Zero dependencies — uses in-memory state.
 * 
 * States:
 *   CLOSED → Normal operation. Failures counted.
 *   OPEN → Service down. All calls rejected immediately (no network request).
 *   HALF_OPEN → Testing. Allows limited calls to check if service recovered.
 * 
 * State Transitions:
 *   CLOSED → OPEN: After `failureThreshold` consecutive failures
 *   OPEN → HALF_OPEN: After `resetTimeout` ms
 *   HALF_OPEN → CLOSED: After `halfOpenSuccessThreshold` successful test calls
 *   HALF_OPEN → OPEN: On any failure during testing
 */

import { logger } from '../services/observabilityService';

// ============================================================================
// TYPES
// ============================================================================

export enum CircuitState {
    CLOSED = 'CLOSED',
    OPEN = 'OPEN',
    HALF_OPEN = 'HALF_OPEN',
}

export class CircuitOpenError extends Error {
    constructor(
        public readonly serviceName: string,
        public readonly openedAt: Date,
        public readonly nextAttemptAt: Date
    ) {
        super(`Circuit breaker OPEN for ${serviceName}. Next attempt at ${nextAttemptAt.toISOString()}`);
        this.name = 'CircuitOpenError';
    }
}

interface CircuitBreakerOptions {
    /** Name for logging/monitoring */
    name: string;
    /** Number of consecutive failures before opening circuit */
    failureThreshold: number;
    /** Time in ms to wait before attempting recovery (OPEN → HALF_OPEN) */
    resetTimeout: number;
    /** Number of successful calls in HALF_OPEN before closing circuit */
    halfOpenSuccessThreshold: number;
    /** Optional: function to determine if an error should count as a failure */
    isFailure?: (error: Error) => boolean;
}

interface CircuitBreakerStatus {
    name: string;
    state: CircuitState;
    consecutiveFailures: number;
    totalFailures: number;
    totalSuccesses: number;
    lastFailureAt: Date | null;
    lastSuccessAt: Date | null;
    openedAt: Date | null;
    nextAttemptAt: Date | null;
}

// ============================================================================
// CIRCUIT BREAKER CLASS
// ============================================================================

export class CircuitBreaker {
    private state: CircuitState = CircuitState.CLOSED;
    private consecutiveFailures: number = 0;
    private halfOpenSuccesses: number = 0;
    private totalFailures: number = 0;
    private totalSuccesses: number = 0;
    private lastFailureAt: Date | null = null;
    private lastSuccessAt: Date | null = null;
    private openedAt: Date | null = null;

    constructor(private readonly options: CircuitBreakerOptions) { }

    /**
     * Execute a function through the circuit breaker.
     * 
     * If CLOSED: executes normally, tracks failures
     * If OPEN: rejects immediately with CircuitOpenError (no network request)
     * If HALF_OPEN: executes with extra monitoring
     */
    async call<T>(fn: () => Promise<T>): Promise<T> {
        // Check if we should transition from OPEN → HALF_OPEN
        if (this.state === CircuitState.OPEN) {
            const now = Date.now();
            const openedTime = this.openedAt?.getTime() || 0;

            if (now - openedTime >= this.options.resetTimeout) {
                // Timeout expired — try half-open
                this.transitionTo(CircuitState.HALF_OPEN);
            } else {
                // Still in cooldown — reject immediately
                const nextAttempt = new Date(openedTime + this.options.resetTimeout);
                throw new CircuitOpenError(
                    this.options.name,
                    this.openedAt!,
                    nextAttempt
                );
            }
        }

        try {
            const result = await fn();
            this.onSuccess();
            return result;
        } catch (error) {
            const err = error as Error;

            // Check if this error should count as a circuit failure
            // (e.g., 404s might not mean the service is down)
            if (this.options.isFailure && !this.options.isFailure(err)) {
                throw err; // Not a circuit failure — just rethrow
            }

            this.onFailure(err);
            throw err;
        }
    }

    /**
     * Record a successful call.
     */
    private onSuccess(): void {
        this.consecutiveFailures = 0;
        this.totalSuccesses++;
        this.lastSuccessAt = new Date();

        if (this.state === CircuitState.HALF_OPEN) {
            this.halfOpenSuccesses++;
            if (this.halfOpenSuccesses >= this.options.halfOpenSuccessThreshold) {
                // Enough successful test calls — service recovered
                this.transitionTo(CircuitState.CLOSED);
            }
        }
    }

    /**
     * Record a failed call.
     */
    private onFailure(error: Error): void {
        this.consecutiveFailures++;
        this.totalFailures++;
        this.lastFailureAt = new Date();

        if (this.state === CircuitState.HALF_OPEN) {
            // Any failure in HALF_OPEN → back to OPEN
            logger.warn(`[CIRCUIT] ${this.options.name}: HALF_OPEN test failed, reopening`, {
                error: error.message,
            });
            this.transitionTo(CircuitState.OPEN);
        } else if (
            this.state === CircuitState.CLOSED &&
            this.consecutiveFailures >= this.options.failureThreshold
        ) {
            // Too many failures — open the circuit
            logger.error(`[CIRCUIT] ${this.options.name}: Failure threshold reached, opening circuit`, error, {
                consecutiveFailures: this.consecutiveFailures,
                threshold: this.options.failureThreshold,
            });
            this.transitionTo(CircuitState.OPEN);
        }
    }

    /**
     * Transition to a new state.
     */
    private transitionTo(newState: CircuitState): void {
        const oldState = this.state;
        this.state = newState;

        logger.info(`[CIRCUIT] ${this.options.name}: ${oldState} → ${newState}`);

        switch (newState) {
            case CircuitState.OPEN:
                this.openedAt = new Date();
                this.halfOpenSuccesses = 0;
                break;
            case CircuitState.HALF_OPEN:
                this.halfOpenSuccesses = 0;
                break;
            case CircuitState.CLOSED:
                this.consecutiveFailures = 0;
                this.halfOpenSuccesses = 0;
                this.openedAt = null;
                break;
        }
    }

    /**
     * Get current status for monitoring/health checks.
     */
    getStatus(): CircuitBreakerStatus {
        let nextAttemptAt: Date | null = null;
        if (this.state === CircuitState.OPEN && this.openedAt) {
            nextAttemptAt = new Date(this.openedAt.getTime() + this.options.resetTimeout);
        }

        return {
            name: this.options.name,
            state: this.state,
            consecutiveFailures: this.consecutiveFailures,
            totalFailures: this.totalFailures,
            totalSuccesses: this.totalSuccesses,
            lastFailureAt: this.lastFailureAt,
            lastSuccessAt: this.lastSuccessAt,
            openedAt: this.openedAt,
            nextAttemptAt,
        };
    }

    /**
     * Reset the circuit breaker to CLOSED state.
     * Use for manual recovery or testing.
     */
    reset(): void {
        this.transitionTo(CircuitState.CLOSED);
        this.totalFailures = 0;
        this.totalSuccesses = 0;
        this.lastFailureAt = null;
        this.lastSuccessAt = null;
        logger.info(`[CIRCUIT] ${this.options.name}: Manually reset`);
    }
}

// ============================================================================
// PRE-CONFIGURED CIRCUIT BREAKERS
// ============================================================================

/**
 * Circuit breaker for Smartlead API calls.
 * - Opens after 5 consecutive failures
 * - Resets after 60 seconds
 * - Requires 2 successful test calls to close
 * - Ignores 404s (not a service failure — just missing resource)
 */
export const smartleadBreaker = new CircuitBreaker({
    name: 'Smartlead API',
    failureThreshold: 5,
    resetTimeout: 60_000,      // 60 seconds
    halfOpenSuccessThreshold: 2,
    isFailure: (error: Error) => {
        // 404 = resource not found, not a service failure
        // 400 = bad request, not a service failure
        const message = error.message.toLowerCase();
        if (message.includes('404') || message.includes('400')) {
            return false;
        }
        return true;
    },
});
