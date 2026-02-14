import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';

dotenv.config();

// ============================================================================
// STARTUP VALIDATION
// ============================================================================

function validateEnvironment(): void {
    const required: string[] = ['DATABASE_URL'];

    if (process.env.NODE_ENV === 'production') {
        required.push('JWT_SECRET');
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

// Initialize Prisma
export const prisma = new PrismaClient();

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

// Import controllers
import * as monitoringController from './controllers/monitoringController';
import * as ingestionController from './controllers/ingestionController';

// Import services for wiring
import { logger, correlationMiddleware, metricsMiddleware, getMetrics } from './services/observabilityService';
import { startWorker as startMetricsWorker, getWorkerStatus as getMetricsWorkerStatus } from './services/metricsWorker';
import { startRetentionJob, getRetentionJobStatus } from './services/complianceService';
import { initEventQueue, getQueueStatus, shutdownEventQueue } from './services/eventQueue';
import { startLeadHealthWorker, getLeadHealthWorkerStatus } from './services/leadHealthWorker';

import cookieParser from 'cookie-parser';

// Middleware
app.use(cors({
    origin: process.env.FRONTEND_URL || (process.env.NODE_ENV === 'production' ? '' : 'http://localhost:3000'),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Organization-ID'],
}));
app.use(cookieParser());
app.use(express.json({ limit: '1mb' }));

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

// Health alias under /api (for Vercel proxy — must be BEFORE orgContext middleware)
app.get('/api/health', (req, res) => {
    res.redirect('/health');
});

// Apply organization context middleware to all /api routes
app.use('/api', extractOrgContext);

// API Routes
app.use('/api/leads', leadRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/sync', syncRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/assessment', assessmentRoutes);
app.use('/api/healing', healingRoutes);

// Ingestion endpoints
app.post('/api/ingest', asyncHandler(ingestionController.ingestLead));
app.post('/api/ingest/clay', asyncHandler(ingestionController.ingestClayWebhook));

// Monitoring endpoints
app.post('/api/monitor/event', asyncHandler(monitoringController.triggerEvent));
app.post('/api/monitor/smartlead-webhook', asyncHandler(monitoringController.handleSmartleadWebhook));

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
    const limit = parseInt(String(req.query.limit || '50'), 10);
    const jobs = await getDeadLetterJobs(limit);
    res.json({ count: jobs.length, jobs });
}));

// DLQ: Retry a specific failed job (ADMIN only)
app.post('/api/admin/dlq/:jobId/retry', requireRole(UserRole.ADMIN), asyncHandler(async (req, res) => {
    const jobId = String(req.params.jobId);
    const success = await retryDeadLetterJob(jobId);
    res.json({ success, jobId });
}));

// DLQ: Retry all failed jobs (ADMIN only)
app.post('/api/admin/dlq/retry-all', requireRole(UserRole.ADMIN), asyncHandler(async (req, res) => {
    const retried = await retryAllDeadLetterJobs();
    res.json({ retriedCount: retried });
}));

// Event Replay: Trigger replay for an entity (ADMIN only, org-scoped)
app.post('/api/admin/replay', requireRole(UserRole.ADMIN), asyncHandler(async (req, res) => {
    const { entityType, entityId, mode = 'dry_run', fromTimestamp, toTimestamp } = req.body;
    // SECURITY: Force org from auth context, never from body (prevents IDOR)
    const organizationId = req.orgContext?.organizationId;

    if (!organizationId || !entityType || !entityId) {
        return res.status(400).json({ error: 'entityType and entityId are required' });
    }

    if (!['dry_run', 'live'].includes(mode)) {
        return res.status(400).json({ error: 'mode must be "dry_run" or "live"' });
    }

    const result = await replayEvents({
        organizationId,
        entityType,
        entityId,
        mode,
        fromTimestamp: fromTimestamp ? new Date(fromTimestamp) : undefined,
        toTimestamp: toTimestamp ? new Date(toTimestamp) : undefined,
    });

    res.json(result);
}));

// Event Replay: Get replay summary (ADMIN only, org-scoped)
app.get('/api/admin/replay/summary', requireRole(UserRole.ADMIN), asyncHandler(async (req, res) => {
    const { entityType, entityId } = req.query;
    // SECURITY: Force org from auth context
    const organizationId = req.orgContext?.organizationId;

    if (!organizationId || !entityType || !entityId) {
        return res.status(400).json({ error: 'entityType and entityId query params required' });
    }

    const summary = await getReplaySummary(
        organizationId,
        entityType as string,
        entityId as string,
    );
    res.json(summary);
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
        prisma.mailbox.count({ where: orgId ? { organization_id: orgId } : {} }),
        prisma.mailbox.count({ where: { ...(orgId ? { organization_id: orgId } : {}), status: 'healthy' } }),
        prisma.mailbox.count({ where: { ...(orgId ? { organization_id: orgId } : {}), status: 'paused' } }),
        prisma.mailbox.count({ where: { ...(orgId ? { organization_id: orgId } : {}), status: 'warning' } }),
        prisma.domain.count({ where: orgId ? { organization_id: orgId } : {} }),
        prisma.domain.count({ where: { ...(orgId ? { organization_id: orgId } : {}), status: 'healthy' } }),
        prisma.domain.count({ where: { ...(orgId ? { organization_id: orgId } : {}), status: 'paused' } }),
    ]);

    // Recent bounce rate (last 24h)
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const recentEvents = await prisma.rawEvent.count({
        where: {
            ...(orgId ? { organization_id: orgId } : {}),
            created_at: { gte: oneDayAgo },
        },
    });
    const recentBounces = await prisma.rawEvent.count({
        where: {
            ...(orgId ? { organization_id: orgId } : {}),
            event_type: { in: ['HARD_BOUNCE', 'BOUNCE', 'EMAIL_BOUNCE'] },
            created_at: { gte: oneDayAgo },
        },
    });

    // DLQ count
    const dlqJobs = await getDeadLetterJobs(1);

    res.json({
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
    });
}));

// Routing Rules (shared with dashboard router)
app.post('/api/dashboard/routing-rules', dashboardRoutes);

// Organization management endpoints
app.get('/api/organization', asyncHandler(async (req, res) => {
    const orgId = req.orgContext?.organizationId;
    if (!orgId) {
        return res.status(401).json({ error: 'Organization context required' });
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

    res.json(org);
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
        return res.status(400).json({ error: 'Invalid system_mode. Must be: observe, suggest, or enforce' });
    }

    const org = await prisma.organization.update({
        where: { id: orgId },
        data: {
            ...(name && { name }),
            ...(system_mode && { system_mode })
        }
    });

    logger.info('Organization updated', { orgId, name, system_mode });
    res.json(org);
}));

// ============================================================================
// ERROR HANDLING
// ============================================================================

app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
    logger.error('Unhandled error', err, {
        method: req.method,
        path: req.path,
        ip: req.ip
    });
    res.status(500).json({
        error: 'Internal server error',
        message: process.env.NODE_ENV === 'development' ? err.message : undefined
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
});

// ============================================================================
// GRACEFUL SHUTDOWN
// ============================================================================

async function gracefulShutdown(signal: string): Promise<void> {
    logger.info(`${signal} received, shutting down gracefully`);

    // Stop accepting new connections
    server.close(() => {
        logger.info('HTTP server closed');
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

    process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
