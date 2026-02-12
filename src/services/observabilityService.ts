/**
 * Observability Service
 * 
 * Implements Phase 7: Observability & Reliability
 * - Structured logging with correlation IDs
 * - Metrics collection
 * - Circuit breaker for external APIs
 * - Component health status
 */

import { Request, Response, NextFunction } from 'express';
import { prisma } from '../index';

// ============================================================================
// CORRELATION IDS
// ============================================================================

const correlationIdStore = new Map<string, string>();

/**
 * Generate a unique correlation ID.
 */
export function generateCorrelationId(): string {
    const crypto = require('crypto');
    return crypto.randomUUID();
}

/**
 * Correlation ID middleware - attaches ID to all requests.
 */
export function correlationMiddleware(req: Request, res: Response, next: NextFunction): void {
    // Check for existing correlation ID from upstream or generate new
    const correlationId =
        (req.headers['x-correlation-id'] as string) ||
        (req.headers['x-request-id'] as string) ||
        generateCorrelationId();

    // Attach to request for use in handlers
    req.correlationId = correlationId;

    // Return in response headers
    res.setHeader('X-Correlation-ID', correlationId);

    next();
}

// ============================================================================
// STRUCTURED LOGGING
// ============================================================================

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
    timestamp: string;
    level: LogLevel;
    message: string;
    correlationId?: string;
    context?: Record<string, any>;
    error?: {
        name: string;
        message: string;
        stack?: string;
    };
}

class StructuredLogger {
    private context: Record<string, any> = {};

    /**
     * Create a child logger with additional context.
     */
    child(context: Record<string, any>): StructuredLogger {
        const child = new StructuredLogger();
        child.context = { ...this.context, ...context };
        return child;
    }

    private log(level: LogLevel, message: string, data?: Record<string, any>, error?: Error): void {
        const entry: LogEntry = {
            timestamp: new Date().toISOString(),
            level,
            message,
            correlationId: data?.correlationId || this.context.correlationId,
            context: { ...this.context, ...data }
        };

        if (error) {
            entry.error = {
                name: error.name,
                message: error.message,
                stack: error.stack
            };
        }

        // Output as JSON for log aggregation
        console.log(JSON.stringify(entry));
    }

    debug(message: string, data?: Record<string, any>): void {
        this.log('debug', message, data);
    }

    info(message: string, data?: Record<string, any>): void {
        this.log('info', message, data);
    }

    warn(message: string, data?: Record<string, any>): void {
        this.log('warn', message, data);
    }

    error(message: string, error?: Error, data?: Record<string, any>): void {
        this.log('error', message, data, error);
    }
}

export const logger = new StructuredLogger();

// ============================================================================
// CIRCUIT BREAKER
// ============================================================================

interface CircuitState {
    failures: number;
    lastFailure: number;
    state: 'closed' | 'open' | 'half-open';
    successesInHalfOpen: number;
}

const circuitBreakers = new Map<string, CircuitState>();

const CIRCUIT_CONFIG = {
    failureThreshold: 5,       // Open after 5 failures
    resetTimeout: 30000,       // Try again after 30 seconds
    halfOpenSuccess: 2         // Close after 2 successes in half-open
};

/**
 * Check if circuit allows request.
 */
export function isCircuitOpen(service: string): boolean {
    const state = circuitBreakers.get(service);
    if (!state) return false;

    if (state.state === 'open') {
        // Check if reset timeout has passed
        if (Date.now() - state.lastFailure > CIRCUIT_CONFIG.resetTimeout) {
            state.state = 'half-open';
            state.successesInHalfOpen = 0;
            logger.info(`Circuit breaker for ${service} entering half-open state`);
            return false;
        }
        return true;
    }

    return false;
}

/**
 * Record a success for circuit breaker.
 */
export function recordCircuitSuccess(service: string): void {
    const state = circuitBreakers.get(service);
    if (!state) return;

    if (state.state === 'half-open') {
        state.successesInHalfOpen++;
        if (state.successesInHalfOpen >= CIRCUIT_CONFIG.halfOpenSuccess) {
            state.state = 'closed';
            state.failures = 0;
            logger.info(`Circuit breaker for ${service} closed`);
        }
    } else {
        state.failures = 0;
    }
}

/**
 * Record a failure for circuit breaker.
 */
export function recordCircuitFailure(service: string): void {
    let state = circuitBreakers.get(service);

    if (!state) {
        state = {
            failures: 0,
            lastFailure: 0,
            state: 'closed',
            successesInHalfOpen: 0
        };
        circuitBreakers.set(service, state);
    }

    state.failures++;
    state.lastFailure = Date.now();

    if (state.state === 'half-open') {
        state.state = 'open';
        logger.warn(`Circuit breaker for ${service} reopened after failure in half-open`);
    } else if (state.failures >= CIRCUIT_CONFIG.failureThreshold) {
        state.state = 'open';
        logger.warn(`Circuit breaker for ${service} opened after ${state.failures} failures`);
    }
}

/**
 * Get circuit breaker status for all services.
 */
export function getCircuitBreakerStatus(): Record<string, CircuitState> {
    const status: Record<string, CircuitState> = {};
    for (const [service, state] of circuitBreakers.entries()) {
        status[service] = { ...state };
    }
    return status;
}

// ============================================================================
// METRICS COLLECTION
// ============================================================================

interface Metrics {
    requests: {
        total: number;
        byEndpoint: Record<string, number>;
        byStatus: Record<number, number>;
    };
    latency: {
        avg: number;
        p95: number;
        p99: number;
        samples: number[];
    };
    errors: number;
    startTime: number;
}

const metrics: Metrics = {
    requests: {
        total: 0,
        byEndpoint: {},
        byStatus: {}
    },
    latency: {
        avg: 0,
        p95: 0,
        p99: 0,
        samples: []
    },
    errors: 0,
    startTime: Date.now()
};

const MAX_LATENCY_SAMPLES = 1000;

/**
 * Metrics collection middleware.
 */
export function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
    const start = Date.now();

    res.on('finish', () => {
        const latency = Date.now() - start;
        const endpoint = `${req.method} ${req.route?.path || req.path}`;

        // Update totals
        metrics.requests.total++;
        metrics.requests.byEndpoint[endpoint] = (metrics.requests.byEndpoint[endpoint] || 0) + 1;
        metrics.requests.byStatus[res.statusCode] = (metrics.requests.byStatus[res.statusCode] || 0) + 1;

        if (res.statusCode >= 400) {
            metrics.errors++;
        }

        // Update latency
        metrics.latency.samples.push(latency);
        if (metrics.latency.samples.length > MAX_LATENCY_SAMPLES) {
            metrics.latency.samples.shift();
        }

        // Recalculate percentiles periodically
        if (metrics.requests.total % 100 === 0) {
            calculateLatencyPercentiles();
        }
    });

    next();
}

function calculateLatencyPercentiles(): void {
    const sorted = [...metrics.latency.samples].sort((a, b) => a - b);
    const len = sorted.length;

    if (len === 0) return;

    metrics.latency.avg = sorted.reduce((a, b) => a + b, 0) / len;
    metrics.latency.p95 = sorted[Math.floor(len * 0.95)] || 0;
    metrics.latency.p99 = sorted[Math.floor(len * 0.99)] || 0;
}

/**
 * Get current metrics.
 */
export function getMetrics(): Omit<Metrics, 'latency'> & { latency: Omit<Metrics['latency'], 'samples'> } {
    calculateLatencyPercentiles();
    return {
        ...metrics,
        latency: {
            avg: Math.round(metrics.latency.avg),
            p95: metrics.latency.p95,
            p99: metrics.latency.p99
        }
    };
}

// ============================================================================
// HEALTH CHECKS
// ============================================================================

interface HealthStatus {
    status: 'healthy' | 'degraded' | 'unhealthy';
    components: {
        database: ComponentHealth;
        externalApis: ComponentHealth;
        worker: ComponentHealth;
    };
    uptime: number;
    version: string;
}

interface ComponentHealth {
    status: 'healthy' | 'degraded' | 'unhealthy';
    latency?: number;
    lastCheck: string;
    details?: string;
}

/**
 * Perform comprehensive health check.
 */
export async function getHealthStatus(): Promise<HealthStatus> {
    const components = {
        database: await checkDatabaseHealth(),
        externalApis: checkExternalApisHealth(),
        worker: await checkWorkerHealth()
    };

    // Aggregate status
    const statuses = Object.values(components).map(c => c.status);
    let overallStatus: HealthStatus['status'] = 'healthy';

    if (statuses.some(s => s === 'unhealthy')) {
        overallStatus = 'unhealthy';
    } else if (statuses.some(s => s === 'degraded')) {
        overallStatus = 'degraded';
    }

    return {
        status: overallStatus,
        components,
        uptime: Date.now() - metrics.startTime,
        version: process.env.APP_VERSION || '1.0.0'
    };
}

async function checkDatabaseHealth(): Promise<ComponentHealth> {
    const start = Date.now();
    try {
        await prisma.$queryRaw`SELECT 1`;
        return {
            status: 'healthy',
            latency: Date.now() - start,
            lastCheck: new Date().toISOString()
        };
    } catch (error) {
        return {
            status: 'unhealthy',
            lastCheck: new Date().toISOString(),
            details: error instanceof Error ? error.message : 'Database connection failed'
        };
    }
}

function checkExternalApisHealth(): ComponentHealth {
    const circuitStatus = getCircuitBreakerStatus();
    const openCircuits = Object.entries(circuitStatus)
        .filter(([_, state]) => state.state === 'open')
        .map(([service]) => service);

    if (openCircuits.length > 0) {
        return {
            status: 'degraded',
            lastCheck: new Date().toISOString(),
            details: `Open circuits: ${openCircuits.join(', ')}`
        };
    }

    return {
        status: 'healthy',
        lastCheck: new Date().toISOString()
    };
}

async function checkWorkerHealth(): Promise<ComponentHealth> {
    // Check if worker has processed recently
    try {
        const recentEvent = await prisma.rawEvent.findFirst({
            where: { processed_at: { not: null } },
            orderBy: { processed_at: 'desc' },
            select: { processed_at: true }
        });

        if (!recentEvent?.processed_at) {
            return {
                status: 'degraded',
                lastCheck: new Date().toISOString(),
                details: 'No recently processed events'
            };
        }

        const timeSinceLastProcess = Date.now() - recentEvent.processed_at.getTime();
        if (timeSinceLastProcess > 300000) { // 5 minutes
            return {
                status: 'degraded',
                lastCheck: new Date().toISOString(),
                details: `Last processed ${Math.floor(timeSinceLastProcess / 1000)}s ago`
            };
        }

        return {
            status: 'healthy',
            lastCheck: new Date().toISOString()
        };
    } catch {
        return {
            status: 'healthy', // Don't fail health on query issues
            lastCheck: new Date().toISOString()
        };
    }
}

// ============================================================================
// REQUEST LOGGING MIDDLEWARE
// ============================================================================

export function requestLoggingMiddleware(req: Request, res: Response, next: NextFunction): void {
    const start = Date.now();

    res.on('finish', () => {
        logger.info('Request completed', {
            correlationId: req.correlationId,
            method: req.method,
            path: req.path,
            status: res.statusCode,
            latency: Date.now() - start,
            userAgent: req.headers['user-agent']
        });
    });

    next();
}

// ============================================================================
// TYPE EXTENSIONS
// ============================================================================

declare global {
    namespace Express {
        interface Request {
            correlationId?: string;
        }
    }
}
