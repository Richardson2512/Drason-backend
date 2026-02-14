/**
 * Organization Context Middleware
 * 
 * Provides multi-tenancy support by extracting and validating organization context
 * from requests. All database queries should be scoped to the organization.
 * 
 * Section 3 of Infrastructure Audit: Multi-Tenancy (Mandatory)
 */

import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { prisma } from '../index';
import { OrgContext, UserRole } from '../types';
import { logger } from '../services/observabilityService';

// ============================================================================
// JWT VERIFICATION
// ============================================================================

interface JwtPayload {
    userId: string;
    email: string;
    role: string;
    orgId: string;
}

/**
 * Get JWT secret — same logic as authController.
 */
function getJwtSecret(): string {
    const secret = process.env.JWT_SECRET;
    if (!secret) {
        if (process.env.NODE_ENV === 'production') {
            throw new Error('FATAL: JWT_SECRET is not set in production');
        }
        return 'drason_dev_only_secret_DO_NOT_USE_IN_PROD';
    }
    return secret;
}

const JWT_SECRET = getJwtSecret();

/**
 * Verify a JWT token and extract claims.
 * Returns null if the token is invalid, expired, or not a JWT.
 */
function verifyJwt(token: string): JwtPayload | null {
    try {
        const decoded = jwt.verify(token, JWT_SECRET) as JwtPayload;
        if (decoded && decoded.userId && decoded.orgId) {
            return decoded;
        }
        return null;
    } catch {
        // Invalid or expired token — not a JWT (might be an API key)
        return null;
    }
}

// Extend Express Request to include organization context
declare global {
    namespace Express {
        interface Request {
            orgContext?: OrgContext;
        }
    }
}

/**
 * Default organization ID for development/single-tenant mode.
 * In production, this should not be used and proper auth is required.
 */
const DEFAULT_ORG_ID = process.env.DEFAULT_ORG_ID || '123e4567-e89b-12d3-a456-426614174000';

/**
 * Middleware to extract organization context from request.
 * 
 * Authentication priority:
 * 1. JWT token (Authorization: Bearer <jwt>) → extracts userId, role, orgId
 * 2. API key (Authorization: Bearer <api-key>) → extracts orgId from key lookup
 * 3. Development fallback (NON-PRODUCTION ONLY) → uses DEFAULT_ORG_ID
 * 
 * Security:
 * - X-Organization-ID header is ONLY trusted if it matches the JWT's orgId claim
 * - Cross-tenant access is prevented by validating header against token
 */
export const extractOrgContext = async (
    req: Request,
    res: Response,
    next: NextFunction
): Promise<void> => {
    try {
        let organizationId: string | undefined;
        let userId: string | undefined;
        let role: UserRole | undefined;
        let authMethod: 'jwt' | 'api_key' | 'dev_fallback' | 'none' = 'none';

        const authHeader = req.headers.authorization;

        // PUBLIC ROUTES: Skip context check for auth endpoints and webhooks
        // Note: req.path is relative to the mount point ('/api')
        const publicPaths = ['/auth/login', '/auth/register', '/monitor/smartlead-webhook', '/ingest/clay'];
        if (publicPaths.some(path => req.path.startsWith(path))) {
            return next();
        }

        if (authHeader && authHeader.startsWith('Bearer ')) {
            const token = authHeader.substring(7);

            // Try JWT first
            const jwtPayload = verifyJwt(token);
            if (jwtPayload) {
                // JWT authentication — trusted source for userId, role, orgId
                userId = jwtPayload.userId;
                role = jwtPayload.role as UserRole;
                organizationId = jwtPayload.orgId;
                authMethod = 'jwt';

                // X-Organization-ID header: ONLY trust if it matches JWT claim
                const orgHeader = req.headers['x-organization-id'];
                if (orgHeader && typeof orgHeader === 'string') {
                    if (orgHeader !== organizationId) {
                        logger.warn('[ORG_CONTEXT] Cross-tenant access attempt blocked', {
                            jwtOrgId: organizationId,
                            headerOrgId: orgHeader,
                            userId,
                        });
                        res.status(403).json({
                            error: 'Forbidden',
                            message: 'X-Organization-ID does not match your authenticated organization',
                        });
                        return;
                    }
                }
            } else {
                // Not a valid JWT — try API key
                const keyData = await validateApiKey(token);
                if (keyData) {
                    organizationId = keyData.organizationId;
                    authMethod = 'api_key';
                }
            }
        }

        // Development fallback — ONLY when no auth provided and NOT in production
        if (!organizationId && process.env.NODE_ENV !== 'production') {
            organizationId = DEFAULT_ORG_ID;
            role = UserRole.ADMIN; // Dev gets admin for convenience
            authMethod = 'dev_fallback';

            // Ensure default org exists in development
            await ensureDefaultOrganization(organizationId);
        }

        logger.debug(`[ORG_CONTEXT] Auth: ${authMethod} | OrgID: ${organizationId || 'none'}`);

        if (!organizationId) {
            res.status(401).json({
                error: 'Authentication required',
                message: 'Provide a valid JWT token (Authorization: Bearer <token>) or API key',
            });
            return;
        }

        // Set context on request
        req.orgContext = {
            organizationId,
            userId,
            role,
        };

        next();
    } catch (error) {
        logger.error('[ORG_CONTEXT] Error extracting context:', error as Error);
        next(error);
    }
};

/**
 * Validate an API key and return organization context.
 * Returns null if key is invalid or expired.
 */
async function validateApiKey(apiKey: string): Promise<{ organizationId: string; scopes: string[] } | null> {
    // TODO: Implement proper key hashing and validation
    // For now, we'll do a simple lookup (keys should be hashed in production)

    // Hash the key for lookup
    const crypto = await import('crypto');
    const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');

    const key = await prisma.apiKey.findUnique({
        where: { key_hash: keyHash }
    });

    if (!key) return null;
    if (key.revoked_at) return null;
    if (key.expires_at && key.expires_at < new Date()) return null;

    // Update last used timestamp
    await prisma.apiKey.update({
        where: { id: key.id },
        data: { last_used_at: new Date() }
    });

    return {
        organizationId: key.organization_id,
        scopes: key.scopes
    };
}

/**
 * Ensure the default organization exists for development.
 */
async function ensureDefaultOrganization(orgId: string): Promise<void> {
    const existing = await prisma.organization.findUnique({
        where: { id: orgId }
    });

    if (!existing) {
        await prisma.organization.create({
            data: {
                id: orgId,
                name: 'Superkabe Default Org',
                slug: 'superkabe-default',
                system_mode: 'observe'
            }
        });
        logger.info('[ORG_CONTEXT] Created default organization for development');
    }
}

/**
 * Require a specific role for the route.
 * Used with requireAuth middleware.
 */
export const requireRole = (requiredRole: UserRole) => {
    return (req: Request, res: Response, next: NextFunction) => {
        if (!req.orgContext) {
            return res.status(401).json({ error: 'Authentication required' });
        }

        // Role hierarchy: admin > operator > viewer
        const roleHierarchy: Record<UserRole, number> = {
            [UserRole.ADMIN]: 3,
            [UserRole.OPERATOR]: 2,
            [UserRole.VIEWER]: 1
        };

        const userRoleLevel = req.orgContext.role ? roleHierarchy[req.orgContext.role] : 0;
        const requiredRoleLevel = roleHierarchy[requiredRole];

        if (userRoleLevel < requiredRoleLevel) {
            return res.status(403).json({
                error: 'Insufficient permissions',
                required: requiredRole,
                current: req.orgContext.role
            });
        }

        next();
    };
};

/**
 * Helper to get organization ID from request.
 * Throws if not available.
 */
export function getOrgId(req: Request): string {
    if (!req.orgContext?.organizationId) {
        throw new Error('Organization context not available');
    }
    return req.orgContext.organizationId;
}
