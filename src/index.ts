import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';

dotenv.config();

// ============================================================================
// STARTUP VALIDATION
// ============================================================================

function validateEnvironment(): void {
    const required: string[] = ['DATABASE_URL', 'ENCRYPTION_KEY'];

    if (process.env.NODE_ENV === 'production') {
        required.push('JWT_SECRET', 'BACKEND_URL', 'POLAR_WEBHOOK_SECRET', 'POLAR_ACCESS_TOKEN');
    }

    const missing = required.filter(key => !process.env[key]);
    if (missing.length > 0) {
        throw new Error(
            `FATAL: Missing required environment variables: ${missing.join(', ')}. ` +
            `Server cannot start without these.`
        );
    }
}

validateEnvironment();

const app = express();
const PORT = process.env.PORT || 3001;

// Initialize Prisma with query timeout and connection pool limits
export const prisma = new PrismaClient({
    datasourceUrl: appendStatementTimeout(process.env.DATABASE_URL || ''),
});

/**
 * Append statement_timeout to the PostgreSQL connection string.
 * Prevents any single query from running longer than 30 seconds.
 */
function appendStatementTimeout(url: string): string {
    if (!url) return url;
    const separator = url.includes('?') ? '&' : '?';
    return `${url}${separator}statement_timeout=30000&connect_timeout=10`;
}

// Import middleware
import { extractOrgContext } from './middleware/orgContext';
import { rateLimit, securityHeaders, initRateLimiters } from './middleware/security';
import { asyncHandler } from './middleware/asyncHandler';

// Import Redis
import { initRedis, checkRedisHealth, disconnectRedis } from './utils/redis';

// Import routes
import leadRoutes from './routes/leads';
import dashboardRoutes from './routes/dashboard';
import settingsRoutes from './routes/settings';
import syncRoutes from './routes/sync';
import authRoutes from './routes/auth';
import assessmentRoutes from './routes/assessment';
import healingRoutes from './routes/healing';
import billingRoutes from './routes/billing';
import userRoutes from './routes/user';
import smartleadWebhookRoutes from './routes/smartleadWebhook';
import emailbisonWebhookRoutes from './routes/emailbisonWebhook';
import instantlyWebhookRoutes from './routes/instantlyWebhook';
import findingsRoutes from './routes/findings';
import analyticsRoutes from './routes/analytics';
import syncProgressRoutes from './routes/syncProgress';
import validationRoutes from './routes/validation';
import infrastructureRoutes from './routes/infrastructure';
import slackRoutes from './routes/slack';
import apiSlackRoutes from './routes/apiSlack';
import adminRoutes from './routes/admin';

import { checkLeadCapacity, checkSubscriptionStatus } from './middleware/featureGate';

// Import controllers
import * as monitoringController from './controllers/monitoringController';
import * as ingestionController from './controllers/ingestionController';

// Import services for wiring
import { logger, correlationMiddleware, metricsMiddleware, getMetrics } from './services/observabilityService';
import { startWorker as startMetricsWorker, getWorkerStatus as getMetricsWorkerStatus } from './services/metricsWorker';
import { startRetentionJob, getRetentionJobStatus } from './services/complianceService';
import { initEventQueue, getQueueStatus, shutdownEventQueue } from './services/eventQueue';
import { startLeadHealthWorker, getLeadHealthWorkerStatus } from './services/leadHealthWorker';
import { startLeadScoringWorker, stopLeadScoringWorker } from './services/leadScoringWorker';
import { startTrialWorker, stopTrialWorker } from './services/trialWorker';
import { startPlatformSyncWorker, stopPlatformSyncWorker, getPlatformSyncWorkerStatus } from './services/platformSyncWorker';
import { scheduleWarmupTracking } from './workers/warmupTrackingWorker';
import * as infrastructureAssessmentService from './services/infrastructureAssessmentService';

// Lead Processor — background job that pushes held leads through the execution gate
import './processor';

import cookieParser from 'cookie-parser';
import compression from 'compression';

// Middleware
app.use(compression());
app.use(cors({
    origin: (origin, callback) => {
        // Allow requests with no origin (like mobile apps, Postman, etc.)
        if (!origin) return callback(null, true);

        // In development, allow localhost
        if (process.env.NODE_ENV !== 'production') {
            return callback(null, true);
        }

        // In production, allow verified domains
        const allowedOrigins = [
            process.env.FRONTEND_URL,
            process.env.FRONTEND_URL?.replace('https://', 'https://www.'),
            process.env.FRONTEND_URL?.replace('https://www.', 'https://'),
            'https://superkabe.com',
            'https://www.superkabe.com',
            'https://app.superkabe.com'
        ].filter(Boolean);

        if (allowedOrigins.includes(origin)) {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Organization-ID'],
}));
app.use(cookieParser());

// Capture raw body for Slack signature verification 
const verifyRawBody = (req: any, res: any, buf: Buffer) => {
    if (req.url && req.originalUrl && req.originalUrl.startsWith('/slack')) {
        req.rawBody = buf;
    }
};

app.use(express.json({ limit: '1mb', verify: verifyRawBody }));
app.use(express.urlencoded({ extended: true, limit: '1mb', verify: verifyRawBody }));

// Security headers on all responses
app.use(securityHeaders);

// Correlation ID and metrics middleware
app.use(correlationMiddleware);
app.use(metricsMiddleware);

// Rate limiting on API routes
app.use('/api', rateLimit);

// ============================================================================
// HEALTH CHECK — Verifies all dependencies
// ============================================================================

app.get('/health', asyncHandler(async (req: express.Request, res: express.Response) => {
    // Database check
    let dbStatus: { status: string; latencyMs?: number } = { status: 'unhealthy' };
    try {
        const dbStart = Date.now();
        await prisma.$queryRaw`SELECT 1`;
        dbStatus = { status: 'healthy', latencyMs: Date.now() - dbStart };
    } catch {
        dbStatus = { status: 'unhealthy' };
    }

    // Redis check
    const redisStatus = await checkRedisHealth();

    // Worker checks
    const metricsWorker = getMetricsWorkerStatus();
    const retentionJob = getRetentionJobStatus();
    const eventQueueStatus = await getQueueStatus();
    const leadHealthWorker = getLeadHealthWorkerStatus();
    const platformSyncWorker = getPlatformSyncWorkerStatus();

    const components = {
        database: dbStatus,
        redis: redisStatus,
        metricsWorker: {
            status: metricsWorker.lastRunAt ? 'active' : 'not_started',
            lastRunAt: metricsWorker.lastRunAt,
            lastError: metricsWorker.lastError
        },
        retentionJob: {
            status: retentionJob.lastRunAt ? 'active' : 'not_started',
            lastRunAt: retentionJob.lastRunAt,
            lastError: retentionJob.lastError
        },
        eventQueue: {
            status: eventQueueStatus.isRunning ? 'active' : 'disabled',
            active: eventQueueStatus.activeCount,
            waiting: eventQueueStatus.waitingCount,
            failed: eventQueueStatus.failedCount,
            lastProcessedAt: eventQueueStatus.lastProcessedAt
        },
        leadHealthWorker: {
            status: leadHealthWorker.lastRunAt ? 'active' : 'not_started',
            lastRunAt: leadHealthWorker.lastRunAt,
            lastError: leadHealthWorker.lastError
        },
        platformSyncWorker: {
            status: platformSyncWorker.lastRunAt ? 'active' : 'not_started',
            lastRunAt: platformSyncWorker.lastRunAt,
            lastError: platformSyncWorker.lastError,
            totalSyncs: platformSyncWorker.totalSyncs,
            totalOrganizationsSynced: platformSyncWorker.totalOrganizationsSynced,
            lastSyncDurationMs: platformSyncWorker.lastSyncDurationMs,
            consecutiveFailures: platformSyncWorker.consecutiveFailures
        }
    };

    const allHealthy = dbStatus.status === 'healthy' &&
        (redisStatus.status === 'healthy' || redisStatus.status === 'not_configured');

    res.status(allHealthy ? 200 : 503).json({
        status: allHealthy ? 'ok' : 'degraded',
        timestamp: new Date(),
        version: '2.1.0',
        uptime: Math.floor(process.uptime()),
        components
    });
}));

// Metrics endpoint for observability
app.get('/metrics', (req, res) => {
    res.json(getMetrics());
});

// Apply organization context middleware to all /api routes
app.use('/api', extractOrgContext);

// Enforce subscription status on all /api routes (except auth, billing, GET user/me, webhooks)
app.use('/api', (req, res, next) => {
    const prefixExempt = ['/auth/', '/billing/', '/monitor/', '/ingest/'];
    if (prefixExempt.some(p => req.path.startsWith(p))) return next();
    // Allow only GET /user/me so the dashboard shell can render — block all other user routes
    if (req.path === '/user/me' && req.method === 'GET') return next();
    checkSubscriptionStatus(req, res, next);
});

// Slack Routes (Bypass /api and typical auth)
app.use('/slack', slackRoutes);

// API Routes
app.use('/api/leads', leadRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/sync', syncRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/assessment', assessmentRoutes);
app.use('/api/healing', healingRoutes);
app.use('/api/billing', billingRoutes);
app.use('/api/user', userRoutes);
app.use('/api/monitor', smartleadWebhookRoutes);
app.use('/api/monitor', emailbisonWebhookRoutes);
app.use('/api/monitor', instantlyWebhookRoutes);
app.use('/api/findings', findingsRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/sync-progress', syncProgressRoutes);
app.use('/api/infrastructure', infrastructureRoutes);
app.use('/api/slack', apiSlackRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/validation', validationRoutes);

// Ingestion endpoints
app.post('/api/ingest', checkLeadCapacity, asyncHandler(ingestionController.ingestLead));
app.post('/api/ingest/clay', checkLeadCapacity, asyncHandler(ingestionController.ingestClayWebhook));

// Monitoring endpoints
app.post('/api/monitor/event', asyncHandler(monitoringController.triggerEvent));
// Note: /api/monitor/smartlead-webhook is handled by smartleadWebhookRoutes (line 187)

// ============================================================================
// ADMIN ENDPOINTS — DLQ, Replay, System Metrics
// ============================================================================

import { getDeadLetterJobs, retryDeadLetterJob, retryAllDeadLetterJobs } from './services/eventQueue';
import { replayEvents, getReplaySummary } from './services/replayService';
import { smartleadBreaker } from './utils/circuitBreaker';
import { requireRole } from './middleware/security';
import { UserRole } from './types';
import * as healingService from './services/healingService';

// DLQ: List failed jobs (ADMIN only)
app.get('/api/admin/dlq', requireRole(UserRole.ADMIN), asyncHandler(async (req, res) => {
    const orgId = req.orgContext?.organizationId;
    const limit = parseInt(String(req.query.limit || '50'), 10);
    const allJobs = await getDeadLetterJobs(limit);
    // Scope DLQ to admin's own organization
    const jobs = orgId ? allJobs.filter((j: Record<string, unknown>) => (j as Record<string, unknown>).organizationId === orgId) : allJobs;
    res.json({ success: true, data: { count: jobs.length, jobs } });
}));

// DLQ: Retry a specific failed job (ADMIN only)
app.post('/api/admin/dlq/:jobId/retry', requireRole(UserRole.ADMIN), asyncHandler(async (req, res) => {
    const jobId = String(req.params.jobId);
    const success = await retryDeadLetterJob(jobId);
    res.json({ success: true, data: { retried: success, jobId } });
}));

// DLQ: Retry all failed jobs (ADMIN only)
app.post('/api/admin/dlq/retry-all', requireRole(UserRole.ADMIN), asyncHandler(async (req, res) => {
    const retried = await retryAllDeadLetterJobs();
    res.json({ success: true, data: { retriedCount: retried } });
}));

// Event Replay: Trigger replay for an entity (ADMIN only, org-scoped)
app.post('/api/admin/replay', requireRole(UserRole.ADMIN), asyncHandler(async (req, res) => {
    const { entityType, entityId, mode = 'dry_run', fromTimestamp, toTimestamp } = req.body;
    // SECURITY: Force org from auth context, never from body (prevents IDOR)
    const organizationId = req.orgContext?.organizationId;

    if (!organizationId || !entityType || !entityId) {
        return res.status(400).json({ success: false, error: 'entityType and entityId are required' });
    }

    if (!['dry_run', 'live'].includes(mode)) {
        return res.status(400).json({ success: false, error: 'mode must be "dry_run" or "live"' });
    }

    const result = await replayEvents({
        organizationId,
        entityType,
        entityId,
        mode,
        fromTimestamp: fromTimestamp ? new Date(fromTimestamp) : undefined,
        toTimestamp: toTimestamp ? new Date(toTimestamp) : undefined,
    });

    res.json({ success: true, data: result });
}));

// Event Replay: Get replay summary (ADMIN only, org-scoped)
app.get('/api/admin/replay/summary', requireRole(UserRole.ADMIN), asyncHandler(async (req, res) => {
    const { entityType, entityId } = req.query;
    // SECURITY: Force org from auth context
    const organizationId = req.orgContext?.organizationId;

    if (!organizationId || !entityType || !entityId) {
        return res.status(400).json({ success: false, error: 'entityType and entityId query params required' });
    }

    const summary = await getReplaySummary(
        organizationId,
        entityType as string,
        entityId as string,
    );
    res.json({ success: true, data: summary });
}));

// System Metrics Dashboard (ADMIN only)
app.get('/api/dashboard/system-metrics', requireRole(UserRole.ADMIN), asyncHandler(async (req, res) => {
    const orgId = req.orgContext?.organizationId;

    // Queue status
    const queueStatus = await getQueueStatus();

    // Circuit breaker status
    const circuitBreakerStatus = smartleadBreaker.getStatus();

    // Lead health worker status
    const leadHealthStatus = getLeadHealthWorkerStatus();

    // Entity health overview
    const [
        totalMailboxes, healthyMailboxes, pausedMailboxes, warningMailboxes,
        totalDomains, healthyDomains, pausedDomains,
    ] = await Promise.all([
        prisma.mailbox.count({ where: { organization_id: orgId } }),
        prisma.mailbox.count({ where: { organization_id: orgId, status: 'healthy' } }),
        prisma.mailbox.count({ where: { organization_id: orgId, status: 'paused' } }),
        prisma.mailbox.count({ where: { organization_id: orgId, status: 'warning' } }),
        prisma.domain.count({ where: { organization_id: orgId } }),
        prisma.domain.count({ where: { organization_id: orgId, status: 'healthy' } }),
        prisma.domain.count({ where: { organization_id: orgId, status: 'paused' } }),
    ]);

    // Recent bounce rate (last 24h)
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const recentEvents = await prisma.rawEvent.count({
        where: {
            organization_id: orgId,
            created_at: { gte: oneDayAgo },
        },
    });
    const recentBounces = await prisma.rawEvent.count({
        where: {
            organization_id: orgId,
            event_type: { in: ['HARD_BOUNCE', 'BOUNCE', 'EMAIL_BOUNCE'] },
            created_at: { gte: oneDayAgo },
        },
    });

    // DLQ count
    const dlqJobs = await getDeadLetterJobs(1);

    res.json({
        success: true, data: {
            timestamp: new Date(),
            eventQueue: {
                status: queueStatus.isRunning ? 'active' : 'disabled',
                active: queueStatus.activeCount,
                waiting: queueStatus.waitingCount,
                failed: queueStatus.failedCount,
                completed: queueStatus.completedCount,
                lastProcessedAt: queueStatus.lastProcessedAt,
            },
            circuitBreaker: {
                smartlead: {
                    state: circuitBreakerStatus.state,
                    consecutiveFailures: circuitBreakerStatus.consecutiveFailures,
                    totalFailures: circuitBreakerStatus.totalFailures,
                    lastFailureAt: circuitBreakerStatus.lastFailureAt,
                    nextAttemptAt: circuitBreakerStatus.nextAttemptAt,
                },
            },
            leadHealthWorker: {
                lastRunAt: leadHealthStatus.lastRunAt,
                totalReclassified: leadHealthStatus.totalReclassified,
                lastBatchSize: leadHealthStatus.lastBatchSize,
            },
            entityHealth: {
                mailboxes: {
                    total: totalMailboxes,
                    healthy: healthyMailboxes,
                    paused: pausedMailboxes,
                    warning: warningMailboxes,
                },
                domains: {
                    total: totalDomains,
                    healthy: healthyDomains,
                    paused: pausedDomains,
                },
            },
            events24h: {
                total: recentEvents,
                bounces: recentBounces,
                bounceRate: recentEvents > 0 ? ((recentBounces / recentEvents) * 100).toFixed(2) + '%' : '0%',
            },
            dlq: {
                count: queueStatus.failedCount,
            },
        }
    });
}));

// Routing Rules (shared with dashboard router)
app.post('/api/dashboard/routing-rules', dashboardRoutes);

// Organization management endpoints
app.get('/api/organization', asyncHandler(async (req, res) => {
    const orgId = req.orgContext?.organizationId;
    if (!orgId) {
        return res.status(401).json({ success: false, error: 'Organization context required' });
    }

    const org = await prisma.organization.findUnique({
        where: { id: orgId },
        select: {
            id: true,
            name: true,
            slug: true,
            system_mode: true,
            created_at: true
        }
    });

    res.json({ success: true, data: org });
}));

// Update organization settings
app.patch('/api/organization', asyncHandler(async (req, res) => {
    const orgId = req.orgContext?.organizationId;
    if (!orgId) {
        return res.status(401).json({ error: 'Organization context required' });
    }

    const { name, system_mode } = req.body;

    // Validate system_mode if provided
    if (system_mode && !['observe', 'suggest', 'enforce'].includes(system_mode)) {
        return res.status(400).json({ success: false, error: 'Invalid system_mode. Must be: observe, suggest, or enforce' });
    }

    // Check if transitioning to enforce mode
    let isSwitchingToEnforce = false;
    if (system_mode === 'enforce') {
        const previousOrg = await prisma.organization.findUnique({
            where: { id: orgId },
            select: { system_mode: true }
        });
        isSwitchingToEnforce = previousOrg?.system_mode !== 'enforce';
    }

    const org = await prisma.organization.update({
        where: { id: orgId },
        data: {
            ...(name && { name }),
            ...(system_mode && { system_mode })
        }
    });

    // #25: Mode switch timing - Trigger immediate assessment when switching to ENFORCE mode
    if (isSwitchingToEnforce) {
        logger.info(`[MODE-SWITCH] System mode switched to enforce for org ${orgId}. Triggering immediate infrastructure assessment.`);
        // Run asynchronously so we don't block the API response
        infrastructureAssessmentService.assessInfrastructure(orgId).catch(err => {
            logger.error(`[MODE-SWITCH] Failed to run immediate assessment for org ${orgId}`, err instanceof Error ? err : new Error(String(err)));
        });
    }

    logger.info('Organization updated', { orgId, name, system_mode });
    res.json({ success: true, data: org });
}));

// ============================================================================
// ERROR HANDLING
// ============================================================================

// Import error handling utils
import { AppError } from './utils/appError';
import { ZodError } from 'zod';

app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
    // Log the FULL error details — not just "Unhandled error"
    logger.error(`Unhandled error: ${err.message}`, err, {
        method: req.method,
        path: req.path,
        ip: req.ip,
        stack: err.stack,
        name: err.name
    });

    // 1. Zod Validation Errors
    if (err instanceof ZodError) {
        const message = err.issues.map(e => `${e.path.join('.')}: ${e.message}`).join(', ');
        return res.status(400).json({
            success: false,
            error: `Validation Error: ${message}`
        });
    }

    // 2. Operational Errors (AppError)
    if (err instanceof AppError) {
        return res.status(err.statusCode).json({
            success: false,
            error: err.message
        });
    }

    // 3. Programming/Unknown Errors — hide internal details in production
    res.status(500).json({
        success: false,
        error: process.env.NODE_ENV === 'production'
            ? 'Internal server error'
            : (err.message || 'Internal server error')
    });
});


// ============================================================================
// SERVER STARTUP
// ============================================================================

// Initialize Redis and rate limiters
initRedis();
initRateLimiters();

const server = app.listen(PORT, () => {
    logger.info(`Server started on port ${PORT}`, {
        port: PORT,
        env: process.env.NODE_ENV || 'development'
    });

    // Start background workers
    startMetricsWorker();
    logger.info('Metrics worker started');

    startRetentionJob();
    logger.info('Compliance retention job started');

    // Start event queue (async webhook processing)
    const queueStarted = initEventQueue();
    logger.info(queueStarted ? 'Event queue started (async processing enabled)' : 'Event queue disabled (sync fallback)');

    // Start lead health re-evaluation worker
    startLeadHealthWorker();
    logger.info('Lead health re-evaluation worker started');

    // Start lead scoring worker
    startLeadScoringWorker();
    logger.info('Lead scoring worker started (runs every 24h)');

    // Start trial expiration worker
    startTrialWorker();
    logger.info('Trial expiration worker started (runs hourly)');

    // Start Platform sync worker for 24/7 infrastructure monitoring
    startPlatformSyncWorker();
    logger.info('Platform sync worker started (runs every 20min for real-time monitoring)');

    // Start warmup tracking worker for automated recovery
    scheduleWarmupTracking();
    logger.info('Warmup tracking worker started (runs every 4h for auto-graduation)');

    // Seed DNSBL lists (upserts — safe to run on every startup)
    import('./services/dnsblService').then(dnsblService => {
        dnsblService.seedDnsblLists().catch(err => {
            logger.error('Failed to seed DNSBL lists', err instanceof Error ? err : new Error(String(err)));
        });
    });

    // Start periodic domain infrastructure assessment
    infrastructureAssessmentService.startPeriodicAssessment();
});

// ============================================================================
// GRACEFUL SHUTDOWN
// ============================================================================

async function gracefulShutdown(signal: string): Promise<void> {
    logger.info(`${signal} received, shutting down gracefully`);

    // Force exit after 30 seconds if shutdown hangs
    const forceExitTimeout = setTimeout(() => {
        logger.error('Graceful shutdown timed out after 30s, forcing exit');
        process.exit(1);
    }, 30000);
    forceExitTimeout.unref(); // Don't let this timer keep the process alive

    // Stop background workers
    stopLeadScoringWorker();
    logger.info('Lead scoring worker stopped');

    stopTrialWorker();
    logger.info('Trial worker stopped');

    stopPlatformSyncWorker();
    logger.info('Platform sync worker stopped');

    infrastructureAssessmentService.stopPeriodicAssessment();
    logger.info('Periodic assessment worker stopped');

    // Stop accepting new connections and wait for in-flight requests to finish
    await new Promise<void>((resolve) => {
        server.close(() => {
            logger.info('HTTP server closed (all in-flight requests completed)');
            resolve();
        });
    });

    // Disconnect services
    try {
        await prisma.$disconnect();
        logger.info('Database disconnected');
    } catch (err) {
        logger.error('Error disconnecting database', err as Error);
    }

    try {
        await shutdownEventQueue();
    } catch (err) {
        logger.error('Error shutting down event queue', err as Error);
    }

    try {
        await disconnectRedis();
    } catch (err) {
        logger.error('Error disconnecting Redis', err as Error);
    }

    clearTimeout(forceExitTimeout);
    process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ============================================================================
// CRASH HANDLERS — Prevent silent deaths in production
// ============================================================================

process.on('uncaughtException', (err) => {
    logger.error('UNCAUGHT EXCEPTION — process will exit', err, {
        type: 'uncaughtException',
        message: err.message,
        stack: err.stack,
    });
    // Give logger time to flush, then exit with failure code
    setTimeout(() => process.exit(1), 1000);
});

process.on('unhandledRejection', (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    logger.error('UNHANDLED REJECTION', err, {
        type: 'unhandledRejection',
        message: err.message,
        stack: err.stack,
    });
    // Don't exit on unhandled rejections — log and continue
    // Node.js 15+ would crash by default; this handler prevents that
});
