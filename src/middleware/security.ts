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
import { prisma } from '../index';
import { UserRole, ApiScope } from '../types';
import { RateLimiterRedis, RateLimiterMemory, RateLimiterAbstract } from 'rate-limiter-flexible';
import { getRedisClient } from '../utils/redis';
import { logger } from '../services/observabilityService';

// ============================================================================
// RATE LIMITING (Redis-backed with in-memory fallback)
// ============================================================================

interface RateLimitTier {
    points: number;    // Max requests
    duration: number;  // Window in seconds
}

const RATE_LIMIT_TIERS: Record<string, RateLimitTier> = {
    auth: { points: 10, duration: 60 },   // 10 req/min for login
    register: { points: 5, duration: 300 },  // 5 req/5min for registration (anti-abuse)
    admin: { points: 30, duration: 60 },   // 30 req/min for admin endpoints
    ingest: { points: 200, duration: 60 },   // 200 req/min for webhooks
    sync: { points: 5, duration: 60 },   // 5 req/min for syncs
    general: { points: 100, duration: 60 },   // 100 req/min default
    apiKey: { points: 1000, duration: 60 },   // 1000 req/min for API keys
};

let rateLimiters: Record<string, RateLimiterAbstract> = {};

/**
 * Initialize rate limiters.
 * Uses Redis when available, falls back to in-memory.
 */
export function initRateLimiters(): void {
    const redis = getRedisClient();

    for (const [tier, config] of Object.entries(RATE_LIMIT_TIERS)) {
        if (redis) {
            rateLimiters[tier] = new RateLimiterRedis({
                storeClient: redis,
                keyPrefix: `rl:${tier}`,
                points: config.points,
                duration: config.duration,
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
        backend: redis ? 'redis' : 'memory',
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

function getClientIdentifier(req: Request): string {
    const apiKey = req.headers.authorization?.replace('Bearer ', '');
    if (apiKey) {
        return `key:${apiKey.substring(0, 16)}`;
    }
    return `ip:${req.ip || req.socket.remoteAddress || 'unknown'}`;
}

// ============================================================================
// RBAC (Role-Based Access Control)
// ============================================================================

const ROLE_PERMISSIONS: Record<UserRole, string[]> = {
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
