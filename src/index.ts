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
import authRoutes from './routes/auth';
import assessmentRoutes from './routes/assessment';
import healingRoutes from './routes/healing';
import billingRoutes from './routes/billing';
import userRoutes from './routes/user';
import findingsRoutes from './routes/findings';
import analyticsRoutes from './routes/analytics';
import validationRoutes from './routes/validation';
import uniboxRoutes from './routes/unibox';
import sequencerRoutes from './routes/sequencer';
import coldCallListRoutes from './routes/coldCallList';
import trackingRoutes from './routes/tracking';
import infrastructureRoutes from './routes/infrastructure';
import slackRoutes from './routes/slack';
import apiSlackRoutes from './routes/apiSlack';
import adminRoutes from './routes/admin';
import apiKeyRoutes from './routes/apiKeys';
import v1Routes from './routes/v1';
import aiRoutes from './routes/ai';
import webhookRoutes from './routes/webhooks';

import { checkSubscriptionStatus } from './middleware/featureGate';
import { requireFreshConsent } from './middleware/requireFreshConsent';

// Import controllers
import * as monitoringController from './controllers/monitoringController';
import * as ingestionController from './controllers/ingestionController';

// Import services for wiring
import { logger, correlationMiddleware, metricsMiddleware, getMetrics } from './services/observabilityService';
import { startWorker as startMetricsWorker, getWorkerStatus as getMetricsWorkerStatus } from './services/metricsWorker';
import { startRetentionJob, getRetentionJobStatus } from './services/complianceService';
import { initEventQueue, getQueueStatus, shutdownEventQueue } from './services/eventQueue';
import { startLeadHealthWorker, getLeadHealthWorkerStatus } from './services/leadHealthWorker';
import { schedulePostmasterFetch, stopPostmasterFetch, getPostmasterWorkerStatus } from './workers/postmasterToolsWorker';
import { scheduleImportKeyTtlSweep, stopImportKeyTtlSweep } from './workers/importKeyTtlWorker';
import { scheduleAccountDeletionWorker, stopAccountDeletionWorker } from './workers/accountDeletionWorker';
import * as postmasterController from './controllers/postmasterController';
import * as migrationController from './controllers/migrationFromSmartleadController';
import * as migrationInstantlyController from './controllers/migrationFromInstantlyController';
import * as consentController from './controllers/consentController';
import * as dataRightsController from './controllers/dataRightsController';
import { startLeadScoringWorker, stopLeadScoringWorker } from './services/leadScoringWorker';
import { startTrialWorker, stopTrialWorker } from './services/trialWorker';
import { scheduleWarmupTracking } from './workers/warmupTrackingWorker';
import { scheduleSequencerSpikeWorker, stopSequencerSpikeWorker } from './workers/sequencerSpikeWorker';
import { scheduleEspPerformanceAggregation } from './workers/espPerformanceWorker';
import { scheduleSendQueue } from './services/sendQueueService';
import { scheduleImapPolling } from './workers/imapReplyWorker';
import { startWebhookDispatcherWorker } from './workers/webhookDispatcherWorker';
import { scheduleMailboxIpBlacklist } from './workers/mailboxIpBlacklistWorker';
import { scheduleColdCallListSnapshots } from './workers/coldCallListWorker';
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
            'https://app.superkabe.com',
            'https://claude.ai',
            'https://www.claude.ai'
        ].filter(Boolean);

        if (allowedOrigins.includes(origin)) {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Organization-ID', 'X-API-Key', 'Mcp-Session-Id', 'Mcp-Protocol-Version'],
    exposedHeaders: ['Mcp-Session-Id'],
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

// Apply organization context middleware to all /api routes
app.use('/api', extractOrgContext);

// Enforce subscription status on all /api routes (except auth, billing, GET user/me, webhooks, OAuth callbacks)
app.use('/api', (req, res, next) => {
    const prefixExempt = ['/auth/', '/billing/', '/monitor/', '/ingest/'];
    if (prefixExempt.some(p => req.path.startsWith(p))) return next();
    // OAuth callbacks from Google/Microsoft don't carry our auth — exempt them
    if (req.path === '/sequencer/accounts/google/callback' || req.path === '/sequencer/accounts/microsoft/callback') return next();
    // Allow only GET /user/me so the dashboard shell can render — block all other user routes
    if (req.path === '/user/me' && req.method === 'GET') return next();
    // Anonymous-friendly consent endpoint (cookie banner). Other /consent/* paths
    // are authenticated and DO go through subscription gating.
    if (req.path === '/consent/cookies') return next();
    checkSubscriptionStatus(req, res, next);
});

// Consent freshness gate — runs after subscription check, before routes.
// Returns 412 with a structured payload when the user hasn't accepted the
// current ToS or Privacy version. Frontend interceptor renders a blocking
// re-acceptance modal that calls /api/auth/accept-current-terms to resolve.
app.use('/api', requireFreshConsent);

// Slack Routes (Bypass /api and typical auth)
app.use('/slack', slackRoutes);

// API Routes
app.use('/api/leads', leadRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/assessment', assessmentRoutes);
app.use('/api/healing', healingRoutes);
app.use('/api/billing', billingRoutes);
app.use('/api/user', userRoutes);
app.use('/api/findings', findingsRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/infrastructure', infrastructureRoutes);
app.use('/api/slack', apiSlackRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/api-keys', apiKeyRoutes);
app.use('/api/v1', v1Routes);
app.use('/api/validation', validationRoutes);
app.use('/api/unibox', uniboxRoutes);
app.use('/api/sequencer', sequencerRoutes);
app.use('/api/cold-call-list', coldCallListRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/webhooks', webhookRoutes);
app.use('/t', trackingRoutes); // public, no auth — tracking pixels + click redirects + unsubscribe

// ── MCP OAuth 2.0 / DCR (RFC 7591) ──────────────────────────────────
// Mounts /.well-known/oauth-authorization-server, /.well-known/oauth-
// protected-resource, /authorize, /token, /register, /revoke so Claude.ai
// (and any MCP-spec client) can discover and complete the OAuth flow
// before calling /mcp.
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { oauthProvider, SUPPORTED_SCOPES } from './mcp/oauthProvider';
import * as oauthConsentController from './controllers/oauthConsentController';

// BACKEND_URL drives our OAuth issuer + resource URLs. The MCP SDK
// requires HTTPS in production; we coerce here so a misset http://
// value (Railway sometimes injects internal http URLs) doesn't crash
// the whole backend at boot.
let publicBackendUrl = (process.env.BACKEND_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
if (process.env.NODE_ENV === 'production' && publicBackendUrl.startsWith('http://')) {
    console.warn('[STARTUP] BACKEND_URL starts with http:// — coercing to https:// for OAuth issuer');
    publicBackendUrl = publicBackendUrl.replace(/^http:\/\//, 'https://');
}
const PUBLIC_BACKEND_URL = publicBackendUrl;

// Mount the MCP OAuth router defensively. If the SDK rejects our
// configuration, log it loudly and continue booting — the rest of the
// backend (REST API, dashboard) must come up regardless so existing
// users aren't blocked by an OAuth-only misconfig.
try {
    app.use(mcpAuthRouter({
        provider: oauthProvider,
        issuerUrl: new URL(PUBLIC_BACKEND_URL),
        resourceServerUrl: new URL(`${PUBLIC_BACKEND_URL}/mcp`),
        scopesSupported: SUPPORTED_SCOPES,
        resourceName: 'Superkabe MCP',
    }));
    console.log(`[STARTUP] MCP OAuth router mounted (issuer=${PUBLIC_BACKEND_URL})`);
} catch (err) {
    console.error('[STARTUP] Failed to mount MCP OAuth router — /authorize, /token, /register endpoints disabled', err);
}

// Consent UI bridge — frontend at /oauth/consent calls these.
// approveConsent requires login; denyConsent does not.
app.get('/api/oauth/consent/details', asyncHandler(oauthConsentController.getConsentDetails));
app.post('/api/oauth/consent/approve', asyncHandler(oauthConsentController.approveConsent));
app.post('/api/oauth/consent/deny', asyncHandler(oauthConsentController.denyConsent));

// ── MCP (Model Context Protocol) ────────────────────────────────────
// Public path /mcp for Claude.ai browser integrations and any remote
// MCP client. Auth supports OAuth 2.0 (oat_*) tokens and Bearer API
// keys (sk_*) — both go through extractOrgContext.
import { handleMcpRequest, handleMcpMethodNotAllowed } from './mcp/transport';

// Emit RFC 9728 WWW-Authenticate header on 401 so MCP clients can
// discover our OAuth metadata. extractOrgContext sets 401 status when
// auth is missing/invalid; the header set here ships with that response.
const advertiseResourceMetadata = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    res.setHeader(
        'WWW-Authenticate',
        `Bearer resource_metadata="${PUBLIC_BACKEND_URL}/.well-known/oauth-protected-resource/mcp"`
    );
    next();
};

app.post('/mcp', advertiseResourceMetadata, extractOrgContext, checkSubscriptionStatus, asyncHandler(handleMcpRequest));
app.get('/mcp', handleMcpMethodNotAllowed);
app.delete('/mcp', handleMcpMethodNotAllowed);

// Ingestion endpoints
app.post('/api/ingest', asyncHandler(ingestionController.ingestLead));
app.post('/api/ingest/clay', asyncHandler(ingestionController.ingestClayWebhook));

// Monitoring endpoints
app.post('/api/monitor/event', asyncHandler(monitoringController.triggerEvent));

// Postmaster Tools (Google reputation API) — OAuth + status + reputation read
app.post('/api/postmaster/connect', asyncHandler(postmasterController.startConnect));
app.post('/api/postmaster/disconnect', asyncHandler(postmasterController.disconnect));
app.post('/api/postmaster/fetch-now', asyncHandler(postmasterController.fetchNow));
app.get('/api/postmaster/status', asyncHandler(postmasterController.getStatus));
app.get('/api/dashboard/domains/:id/reputation', asyncHandler(postmasterController.getDomainReputation));
// Public OAuth callback — Google redirects here without our auth context.
app.get('/oauth/callback/postmaster', asyncHandler(postmasterController.oauthCallback));

// Migration tool (one-time import from Smartlead). Feature-flag gated by
// MIGRATION_TOOL_ENABLED env var. Routes return 404 when disabled.
app.get('/api/migration/from-smartlead/feature',      asyncHandler(migrationController.featureFlag));
app.get('/api/migration/from-smartlead/key-status',   asyncHandler(migrationController.keyStatus));
app.post('/api/migration/from-smartlead/validate-key', asyncHandler(migrationController.validateKey));
app.post('/api/migration/from-smartlead/store-key',    asyncHandler(migrationController.storeKey));
app.post('/api/migration/from-smartlead/discard-key',  asyncHandler(migrationController.discardKey));
app.post('/api/migration/from-smartlead/preview',      asyncHandler(migrationController.preview));
app.post('/api/migration/from-smartlead/start',        asyncHandler(migrationController.start));
app.get('/api/migration/from-smartlead/status',       asyncHandler(migrationController.status));

app.get('/api/migration/from-instantly/feature',      asyncHandler(migrationInstantlyController.featureFlag));
app.get('/api/migration/from-instantly/key-status',   asyncHandler(migrationInstantlyController.keyStatus));
app.post('/api/migration/from-instantly/validate-key', asyncHandler(migrationInstantlyController.validateKey));
app.post('/api/migration/from-instantly/store-key',    asyncHandler(migrationInstantlyController.storeKey));
app.post('/api/migration/from-instantly/discard-key',  asyncHandler(migrationInstantlyController.discardKey));
app.post('/api/migration/from-instantly/preview',      asyncHandler(migrationInstantlyController.preview));
app.post('/api/migration/from-instantly/start',        asyncHandler(migrationInstantlyController.start));
app.get('/api/migration/from-instantly/status',       asyncHandler(migrationInstantlyController.status));

// Consent endpoints — cookies (anonymous-friendly), DSAR audit, withdrawal.
app.post('/api/consent/cookies',  asyncHandler(consentController.recordCookieConsent));
app.get('/api/consent/mine',      asyncHandler(consentController.listMyConsents));
app.post('/api/consent/withdraw', asyncHandler(consentController.withdrawMyConsent));

// Data Subject Access Request (GDPR / CCPA / DPDP / PDPA) endpoints.
app.get('/api/account/my-data',           asyncHandler(dataRightsController.exportMyData));
app.post('/api/account/delete-request',   asyncHandler(dataRightsController.requestAccountDeletion));
app.get('/api/account/delete-request',    asyncHandler(dataRightsController.getDeletionStatus));
app.post('/api/account/cancel-deletion',  asyncHandler(dataRightsController.cancelAccountDeletion));

// ============================================================================
// ADMIN ENDPOINTS — DLQ, Replay, System Metrics
// ============================================================================

import { getDeadLetterJobs, retryDeadLetterJob, retryAllDeadLetterJobs } from './services/eventQueue';
import { replayEvents, getReplaySummary } from './services/replayService';
import { getAllBreakerStatuses } from './utils/circuitBreaker';
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

    // Circuit breaker status — Gmail, Microsoft Graph, SMTP send paths
    const circuitBreakerStatus = getAllBreakerStatuses();

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
            circuitBreaker: Object.fromEntries(
                circuitBreakerStatus.map((s) => [
                    s.name,
                    {
                        state: s.state,
                        consecutiveFailures: s.consecutiveFailures,
                        totalFailures: s.totalFailures,
                        lastFailureAt: s.lastFailureAt,
                        nextAttemptAt: s.nextAttemptAt,
                    },
                ]),
            ),
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
            mailing_address: true,
            mailing_address_updated_at: true,
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

    const { name, system_mode, mailing_address } = req.body;

    // Validate system_mode if provided
    if (system_mode && !['observe', 'suggest', 'enforce'].includes(system_mode)) {
        return res.status(400).json({ success: false, error: 'Invalid system_mode. Must be: observe, suggest, or enforce' });
    }

    // Validate mailing_address — CAN-SPAM § 5(a)(5) requires a valid postal
    // address. Minimum sanity check: not empty + has at least one comma or
    // newline (street + city/country). Real-world addresses are too varied to
    // strictly validate; we just rule out obvious garbage like single tokens.
    if (mailing_address !== undefined) {
        if (typeof mailing_address !== 'string' || mailing_address.trim().length < 10) {
            return res.status(400).json({
                success: false,
                error: 'mailing_address must be a complete postal address (street, city, country). CAN-SPAM § 5(a)(5) requires it on every commercial email.',
            });
        }
        if (!/,|\n/.test(mailing_address)) {
            return res.status(400).json({
                success: false,
                error: 'mailing_address looks incomplete — please include street, city, and country separated by commas or line breaks.',
            });
        }
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
            ...(system_mode && { system_mode }),
            ...(mailing_address !== undefined && {
                mailing_address: mailing_address.trim(),
                mailing_address_updated_at: new Date(),
            }),
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

    // Start Postmaster Tools daily fetch (03:00 UTC)
    schedulePostmasterFetch();
    logger.info('Postmaster Tools worker started (daily fetch at 03:00 UTC)');

    // Start import-key TTL sweep (every 15 min) — wipes expired one-time-import keys
    scheduleImportKeyTtlSweep();
    logger.info('Import-key TTL worker started (sweep every 15m)');

    // Start DSAR account-deletion worker — executes deletion requests after
    // the 30-day grace period. Required for GDPR Art. 17 compliance.
    scheduleAccountDeletionWorker();
    logger.info('Account deletion worker started (sweep every 6h)');

    // Start lead scoring worker
    startLeadScoringWorker();
    logger.info('Lead scoring worker started (runs every 24h)');

    // Start trial expiration worker
    startTrialWorker();
    logger.info('Trial expiration worker started (runs hourly)');


    // Start warmup tracking worker for automated recovery
    scheduleWarmupTracking();
    logger.info('Warmup tracking worker started (runs every 4h for auto-graduation)');

    // Start sequencer spike detector (campaign-level bounce + unsubscribe)
    scheduleSequencerSpikeWorker();
    logger.info('Sequencer spike detector started (hourly bounce + unsubscribe rate scans)');

    // Start ESP performance aggregation worker
    scheduleEspPerformanceAggregation();
    logger.info('ESP performance worker started (runs every 6h for mailbox ESP scoring)');

    // Start send queue (processes campaign emails every 30s)
    scheduleSendQueue();
    logger.info('Send queue worker started (runs every 30s for campaign email delivery)');

    // Start IMAP reply detection (polls every 60s)
    scheduleImapPolling();
    logger.info('IMAP reply worker started (runs every 60s for reply detection)');

    // Start outbound webhook dispatcher (BullMQ worker + 60s rescue scan)
    startWebhookDispatcherWorker();
    logger.info('Webhook dispatcher worker started (BullMQ + 60s rescue scan)');

    // Per-mailbox sending-IP DNSBL check (runs every 6h)
    scheduleMailboxIpBlacklist();
    logger.info('Mailbox IP blacklist worker scheduled (every 6h)');

    // Cold Call List daily snapshot worker (runs hourly, fires per-org at
    // 06:00 in each workspace's local timezone)
    scheduleColdCallListSnapshots();
    logger.info('Cold Call List snapshot worker scheduled (hourly tick, 06:00 workspace-local trigger)');

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

    stopPostmasterFetch();
    logger.info('Postmaster Tools worker stopped');

    stopImportKeyTtlSweep();
    logger.info('Import-key TTL worker stopped');

    stopAccountDeletionWorker();
    logger.info('Account deletion worker stopped');

    stopSequencerSpikeWorker();
    logger.info('Sequencer spike detector stopped');


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
