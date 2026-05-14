/**
 * Security Middleware
 * 
 * Implements:
 * - Redis-backed rate limiting with per-endpoint configuration
 * - RBAC (Admin, Operator, Viewer roles)
 * - API key scoped permissions
 * - Security headers
 */

import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { prisma } from '../prisma';
import { UserRole, ApiScope } from '../types';
import { RateLimiterRedis, RateLimiterMemory, RateLimiterAbstract } from 'rate-limiter-flexible';
import { getRedisClient } from '../utils/redis';
import { logger } from '../services/observabilityService';
import { JWT_SECRET } from '../services/tokenService';

// ============================================================================
// RATE LIMITING (Redis-backed with in-memory fallback)
// ============================================================================

interface RateLimitTier {
    points: number;    // Max requests
    duration: number;  // Window in seconds
}

const RATE_LIMIT_TIERS: Record<string, RateLimitTier> = {
    // 60 req/min on /auth gives the legal-versions / refresh / logout / google
    // endpoints headroom for a SPA that pings them on every nav. Login itself
    // is bcrypt-bound so it self-throttles; brute-force protection lives in
    // the per-user failed_login_count counter, not here.
    auth: { points: 60, duration: 60 },
    register: { points: 5, duration: 300 },  // 5 req/5min for registration (anti-abuse)
    admin: { points: 30, duration: 60 },   // 30 req/min for admin endpoints
    ingest: { points: 200, duration: 60 },   // 200 req/min for webhooks
    sync: { points: 5, duration: 60 },   // 5 req/min for syncs
    // 600 req/min = 10 req/sec sustained. Real dashboards burst 20–40 reqs
    // on initial mount (DashboardContext + each page's data fetch). The
    // identifier below buckets per-user when authenticated so multiple users
    // behind the same NAT don't cannibalize each other's budget.
    general: { points: 600, duration: 60 },
    apiKey: { points: 1000, duration: 60 },   // 1000 req/min for API keys
};

let rateLimiters: Record<string, RateLimiterAbstract> = {};

/**
 * Initialize rate limiters.
 *
 * When Redis is available, each tier uses RateLimiterRedis as the primary
 * store with a RateLimiterMemory `insuranceLimiter` as fallback. The
 * library transparently delegates to the insurance limiter on Redis errors
 * — without it, a Redis outage causes every consume() to reject, which
 * our catch block then treats as "rate limit exceeded" and 429s every
 * authenticated request. That bricks the API for the duration of the
 * outage. Insurance keeps things working (with per-process state) until
 * Redis recovers.
 *
 * If Redis is unavailable at init time, we run pure in-memory.
 */
export function initRateLimiters(): void {
    const redis = getRedisClient();

    for (const [tier, config] of Object.entries(RATE_LIMIT_TIERS)) {
        if (redis) {
            const insuranceLimiter = new RateLimiterMemory({
                keyPrefix: `rl:insurance:${tier}`,
                points: config.points,
                duration: config.duration,
            });
            rateLimiters[tier] = new RateLimiterRedis({
                storeClient: redis,
                keyPrefix: `rl:${tier}`,
                points: config.points,
                duration: config.duration,
                insuranceLimiter,
            });
        } else {
            rateLimiters[tier] = new RateLimiterMemory({
                keyPrefix: `rl:${tier}`,
                points: config.points,
                duration: config.duration,
            });
        }
    }

    logger.info('Rate limiters initialized', {
        backend: redis ? 'redis+memory-insurance' : 'memory',
        tiers: Object.keys(RATE_LIMIT_TIERS)
    });
}

/**
 * Determine which rate limit tier applies to a request.
 */
function getTier(req: Request): string {
    const path = req.path.toLowerCase();
    if (path.startsWith('/auth/register')) return 'register';
    if (path.startsWith('/auth')) return 'auth';
    if (path.startsWith('/admin')) return 'admin';
    if (path.startsWith('/ingest')) return 'ingest';
    if (path.startsWith('/sync')) return 'sync';
    if (req.headers.authorization?.startsWith('Bearer ')) return 'apiKey';
    return 'general';
}

/**
 * Rate limiting middleware.
 */
export async function rateLimit(req: Request, res: Response, next: NextFunction): Promise<void> {
    const tier = getTier(req);
    const limiter = rateLimiters[tier] || rateLimiters['general'];

    if (!limiter) {
        // Limiters not initialized yet — allow request
        next();
        return;
    }

    const identifier = getClientIdentifier(req);

    try {
        const result = await limiter.consume(identifier);

        // Set rate limit headers
        res.setHeader('X-RateLimit-Limit', RATE_LIMIT_TIERS[tier]?.points || 100);
        res.setHeader('X-RateLimit-Remaining', result.remainingPoints);
        res.setHeader('X-RateLimit-Reset', new Date(Date.now() + result.msBeforeNext).toISOString());

        next();
    } catch (rejRes: any) {
        // rate-limiter-flexible distinguishes two reject shapes:
        //   - RateLimiterRes (real rate-limit hit) — has msBeforeNext + remainingPoints
        //   - Error (storage/Redis failure) — opaque
        // Without this check, a Redis outage rejects with an Error; our old
        // code would interpret that as "rate limit exceeded" and 429 every
        // request. Fail open for storage errors so the API stays up.
        const isRateLimitHit = rejRes && typeof rejRes.msBeforeNext === 'number';
        if (!isRateLimitHit) {
            logger.warn('[RATE-LIMIT] Limiter store error — failing open', {
                tier,
                err: rejRes instanceof Error ? rejRes.message : String(rejRes),
            });
            next();
            return;
        }

        const retryAfter = Math.ceil((rejRes.msBeforeNext || 60000) / 1000);

        res.setHeader('Retry-After', retryAfter);
        res.setHeader('X-RateLimit-Limit', RATE_LIMIT_TIERS[tier]?.points || 100);
        res.setHeader('X-RateLimit-Remaining', 0);

        res.status(429).json({
            error: 'Too Many Requests',
            retryAfter
        });
    }
}

/**
 * Choose a rate-limit bucket key for the request. Priority:
 *   1. JWT cookie / bearer token  → bucket by userId. Multiple tabs / colleagues
 *      behind the same NAT each get their own budget.
 *   2. API key bearer token       → bucket by key prefix.
 *   3. Anonymous                  → bucket by IP.
 *
 * The JWT decode here is verify-then-trust; an invalid/expired token falls
 * through to the IP path. orgContext middleware does the real auth checks.
 */
function getClientIdentifier(req: Request): string {
    // Cookie-auth is the dominant path now (SPA dashboard).
    const cookieToken = (req as any).cookies?.token as string | undefined;
    if (cookieToken) {
        try {
            const decoded = jwt.verify(cookieToken, JWT_SECRET) as { userId?: string };
            if (decoded?.userId) return `user:${decoded.userId}`;
        } catch { /* fall through */ }
    }

    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
        const token = authHeader.substring(7);
        // Try JWT first (e.g. mobile clients sending Bearer instead of cookie).
        try {
            const decoded = jwt.verify(token, JWT_SECRET) as { userId?: string };
            if (decoded?.userId) return `user:${decoded.userId}`;
        } catch { /* not a JWT — treat as API key */ }
        return `key:${token.substring(0, 16)}`;
    }

    return `ip:${req.ip || req.socket.remoteAddress || 'unknown'}`;
}

// ============================================================================
// RBAC (Role-Based Access Control)
// ============================================================================

const ROLE_PERMISSIONS: Record<UserRole, string[]> = {
    [UserRole.SUPER_ADMIN]: [
        'users:read', 'users:write', 'users:delete',
        'org:read', 'org:write',
        'settings:read', 'settings:write',
        'leads:read', 'leads:write', 'leads:delete',
        'campaigns:read', 'campaigns:write',
        'audit:read',
        'webhooks:manage',
        'admin:read', 'admin:write'
    ],
    [UserRole.ADMIN]: [
        'users:read', 'users:write', 'users:delete',
        'org:read', 'org:write',
        'settings:read', 'settings:write',
        'leads:read', 'leads:write', 'leads:delete',
        'campaigns:read', 'campaigns:write',
        'audit:read',
        'webhooks:manage'
    ],
    [UserRole.OPERATOR]: [
        'leads:read', 'leads:write',
        'campaigns:read', 'campaigns:write',
        'settings:read',
        'audit:read'
    ],
    [UserRole.VIEWER]: [
        'leads:read',
        'campaigns:read',
        'audit:read'
    ]
};

/**
 * Check if a role has a specific permission.
 */
export function hasPermission(role: UserRole | undefined, permission: string): boolean {
    if (!role) return false;
    return ROLE_PERMISSIONS[role]?.includes(permission) || false;
}

/**
 * Require specific permission middleware.
 */
export function requirePermission(permission: string) {
    return (req: Request, res: Response, next: NextFunction): void => {
        const role = req.orgContext?.role;

        if (!hasPermission(role, permission)) {
            res.status(403).json({
                error: 'Forbidden',
                message: `Permission '${permission}' required`,
                yourRole: role || 'none'
            });
            return;
        }

        next();
    };
}

/**
 * Require specific role middleware.
 */
export function requireRole(...allowedRoles: UserRole[]) {
    return (req: Request, res: Response, next: NextFunction): void => {
        const role = req.orgContext?.role;

        if (!role || !allowedRoles.includes(role)) {
            res.status(403).json({
                error: 'Forbidden',
                message: `One of these roles required: ${allowedRoles.join(', ')}`,
                yourRole: role || 'none'
            });
            return;
        }

        next();
    };
}

// ============================================================================
// API KEY SCOPE VALIDATION
// ============================================================================

const SCOPE_TO_PERMISSIONS: Record<ApiScope, string[]> = {
    [ApiScope.LEADS_READ]: ['leads:read'],
    [ApiScope.LEADS_WRITE]: ['leads:read', 'leads:write'],
    [ApiScope.CAMPAIGNS_READ]: ['campaigns:read'],
    [ApiScope.CAMPAIGNS_WRITE]: ['campaigns:read', 'campaigns:write'],
    [ApiScope.SETTINGS_READ]: ['settings:read'],
    [ApiScope.SETTINGS_WRITE]: ['settings:read', 'settings:write'],
    [ApiScope.AUDIT_READ]: ['audit:read'],
    [ApiScope.WEBHOOKS]: ['webhooks:manage']
};

/**
 * Validate API key has required scope.
 */
export async function validateApiKeyScope(
    apiKeyId: string,
    requiredScope: ApiScope
): Promise<boolean> {
    const apiKey = await prisma.apiKey.findUnique({
        where: { id: apiKeyId },
        select: { scopes: true, revoked_at: true, expires_at: true }
    });

    if (!apiKey) return false;
    if (apiKey.revoked_at) return false;
    if (apiKey.expires_at && apiKey.expires_at < new Date()) return false;

    return apiKey.scopes.includes(requiredScope);
}

/**
 * Require API key scope middleware.
 */
export function requireScope(scope: ApiScope) {
    return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        const authHeader = req.headers.authorization;

        if (!authHeader?.startsWith('Bearer ')) {
            res.status(401).json({ error: 'API key required' });
            return;
        }

        const apiKey = authHeader.substring(7);
        const keyHash = hashApiKey(apiKey);

        const keyRecord = await prisma.apiKey.findFirst({
            where: { key_hash: keyHash },
            select: { id: true, scopes: true, revoked_at: true, expires_at: true }
        });

        if (!keyRecord) {
            res.status(401).json({ error: 'Invalid API key' });
            return;
        }

        if (keyRecord.revoked_at) {
            res.status(401).json({ error: 'API key has been revoked' });
            return;
        }

        if (keyRecord.expires_at && keyRecord.expires_at < new Date()) {
            res.status(401).json({ error: 'API key has expired' });
            return;
        }

        if (!keyRecord.scopes.includes(scope)) {
            res.status(403).json({
                error: 'Insufficient scope',
                required: scope,
                available: keyRecord.scopes
            });
            return;
        }

        next();
    };
}

/**
 * Hash an API key for storage/lookup.
 */
function hashApiKey(key: string): string {
    const crypto = require('crypto');
    return crypto.createHash('sha256').update(key).digest('hex');
}

// ============================================================================
// SECURITY HEADERS
// ============================================================================

/**
 * Apply security headers middleware.
 */
export function securityHeaders(req: Request, res: Response, next: NextFunction): void {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    res.setHeader('Content-Security-Policy', "default-src 'self'");
    next();
}

// ============================================================================
// EXPORTS
// ============================================================================

export const security = {
    rateLimit,
    initRateLimiters,
    requirePermission,
    requireRole,
    requireScope,
    hasPermission,
    validateApiKeyScope,
    securityHeaders
};
