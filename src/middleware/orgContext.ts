/**
 * Organization Context Middleware
 * 
 * Provides multi-tenancy support by extracting and validating organization context
 * from requests. All database queries should be scoped to the organization.
 * 
 * Section 3 of Infrastructure Audit: Multi-Tenancy (Mandatory)
 */

import crypto from 'crypto';
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
    iat?: number; // JWT issued-at timestamp (seconds since epoch)
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
        const publicPaths = ['/auth/login', '/auth/register', '/auth/refresh', '/auth/logout', '/auth/google', '/auth/onboarding', '/auth/legal-versions', '/auth/forgot-password', '/auth/reset-password', '/ingest/clay', '/billing/polar-webhook', '/sequencer/accounts/google/callback', '/sequencer/accounts/microsoft/callback', '/oauth/callback/postmaster', '/oauth/consent/details', '/oauth/consent/deny', '/consent/cookies', '/integrations/hubspot/callback', '/integrations/salesforce/callback', '/integrations/outreach/callback', '/integrations/hubspot/webhooks'];
        if (publicPaths.some(path => req.path.startsWith(path))) {
            return next();
        }

        let token: string | undefined;

        if (authHeader && authHeader.startsWith('Bearer ')) {
            token = authHeader.substring(7);
        } else if (req.cookies && req.cookies.token) {
            token = req.cookies.token;
        }

        if (token) {
            // Try JWT first
            const jwtPayload = verifyJwt(token);
            if (jwtPayload) {
                // Verify the user (and the org membership claim) the JWT
                // points at still exist. Without this, a JWT signed with a
                // valid secret but referencing a deleted user (re-seed,
                // schema reset, account deletion, restored backup, org
                // moved) is accepted by the middleware — every controller
                // below us then hits a null findUnique and returns 404
                // "User not found" / "Organization not found", and the
                // frontend (which only auto-redirects on 401) traps the
                // operator in a broken /dashboard with no path to /login.
                // Fold the password_changed_at check into the same lookup
                // so this is one query, not two.
                const user = await prisma.user.findUnique({
                    where: { id: jwtPayload.userId },
                    select: {
                        id: true,
                        organization_id: true,
                        password_changed_at: true,
                    },
                });
                if (!user) {
                    logger.warn('[ORG_CONTEXT] JWT references unknown user — clearing cookie + 401', {
                        userId: jwtPayload.userId,
                    });
                    res.clearCookie('token', { path: '/' });
                    res.status(401).json({
                        success: false,
                        error: 'Session expired',
                        message: 'Your session is no longer valid. Please log in again.',
                    });
                    return;
                }
                if (user.organization_id !== jwtPayload.orgId) {
                    logger.warn('[ORG_CONTEXT] JWT orgId no longer matches user — clearing cookie + 401', {
                        userId: jwtPayload.userId,
                        jwtOrgId: jwtPayload.orgId,
                        currentOrgId: user.organization_id,
                    });
                    res.clearCookie('token', { path: '/' });
                    res.status(401).json({
                        success: false,
                        error: 'Session expired',
                        message: 'Your session is no longer valid. Please log in again.',
                    });
                    return;
                }
                if (user.password_changed_at && jwtPayload.iat) {
                    const tokenIssuedAt = new Date(jwtPayload.iat * 1000);
                    if (tokenIssuedAt < user.password_changed_at) {
                        logger.warn('[ORG_CONTEXT] JWT issued before password change — rejected', {
                            userId: jwtPayload.userId,
                        });
                        res.clearCookie('token', { path: '/' });
                        res.status(401).json({
                            success: false,
                            error: 'Session expired',
                            message: 'Your password was changed. Please log in again.',
                        });
                        return;
                    }
                }

                // JWT authentication — trusted source for userId, role, orgId
                userId = jwtPayload.userId;
                role = jwtPayload.role as UserRole;
                organizationId = jwtPayload.orgId;
                authMethod = 'jwt';

                // Super admin can switch org context via query param
                if (role === UserRole.SUPER_ADMIN && req.query.org_id) {
                    organizationId = req.query.org_id as string;
                }

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
            } else if (token.startsWith('oat_')) {
                // OAuth 2.0 access token (issued by /oauth/token)
                const oat = await validateOAuthAccessToken(token);
                if (oat) {
                    organizationId = oat.organizationId;
                    userId = oat.userId;
                    authMethod = 'api_key'; // Reuse api_key path — same scope-based authz model
                    (req as any)._apiKeyScopes = oat.scopes;
                }
            } else {
                // Not a valid JWT — try API key
                const keyData = await validateApiKey(token);
                if (keyData) {
                    organizationId = keyData.organizationId;
                    authMethod = 'api_key';
                    // Store scopes on request for v1 endpoint permission checks
                    (req as any)._apiKeyScopes = keyData.scopes;
                }
            }

            // A token was supplied but matched none of the supported auth
            // methods (JWT signature invalid → likely a cookie from a prior
            // JWT_SECRET; OAuth token unknown; API key revoked/missing).
            // Falling through to the dev fallback here would be wrong: the
            // request *intended* to be authenticated, so quietly granting it
            // an empty userId + DEFAULT_ORG_ID just produces "User not found"
            // 404s in every downstream controller and traps the operator in
            // a broken /dashboard. Return 401 so the global frontend handler
            // redirects to /login, and clear the stale cookie on the way out.
            if (!organizationId) {
                logger.warn('[ORG_CONTEXT] Token present but unverifiable — clearing cookie + 401');
                if (req.cookies?.token) {
                    res.clearCookie('token', { path: '/' });
                }
                res.status(401).json({
                    success: false,
                    error: 'Session expired',
                    message: 'Your session is no longer valid. Please log in again.',
                });
                return;
            }
        }

        // Development fallback — ONLY when NO token was provided at all and
        // we're not in production. (If a token was present but unverifiable,
        // the block above already returned 401 — we never reach this.)
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
            scopes: (req as any)._apiKeyScopes,
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
    // Hash the key for lookup (SHA-256)
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
 * Validate an OAuth 2.0 access token (issued by /oauth/token). Returns the
 * org context the token grants, or null if invalid/expired/revoked.
 */
async function validateOAuthAccessToken(token: string): Promise<{ organizationId: string; userId: string; scopes: string[] } | null> {
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    const row = await prisma.oAuthAccessToken.findUnique({
        where: { access_token_hash: tokenHash },
    });

    if (!row) return null;
    if (row.revoked_at) return null;
    if (row.expires_at < new Date()) return null;

    prisma.oAuthAccessToken.update({
        where: { id: row.id },
        data: { last_used_at: new Date() },
    }).catch(() => undefined); // fire-and-forget

    return {
        organizationId: row.organization_id,
        userId: row.user_id,
        scopes: (row.scope || '').split(/\s+/).filter(Boolean),
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

        // Role hierarchy: super_admin > admin > operator > viewer
        const roleHierarchy: Record<UserRole, number> = {
            [UserRole.SUPER_ADMIN]: 4,
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
 * Require super admin role for the route.
 * Unlike requireRole, this checks for exact super_admin match — no hierarchy fallback.
 */
export const requireSuperAdmin = (req: Request, res: Response, next: NextFunction) => {
    if (!req.orgContext?.role || req.orgContext.role !== 'super_admin') {
        return res.status(403).json({ error: 'Super admin access required' });
    }
    next();
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

/**
 * Per-org MCP URL guard. When mounted on routes shaped `/mcp/:orgSlug`
 * (and analogous per-org metadata paths), enforces that the bearer token
 * resolved by extractOrgContext was issued for the org named in the URL.
 *
 * Why a separate middleware rather than baking this into extractOrgContext:
 * the bare `/mcp` path is back-compat — any valid token works there, with
 * the org coming from the token alone. The per-org URL is the new shape
 * that lets one user (one Superkabe account) hold separate Claude.ai
 * connectors per org without the cached-token cross-talk we hit before.
 *
 * Behavior:
 *   - 404 if the slug doesn't resolve to an org (bad URL, never authorize
 *     a connector against it).
 *   - 403 if the resolved token's org doesn't match the slug. The caller
 *     is presenting a token for a different org — this is the audience
 *     mismatch we explicitly want to reject.
 *   - Pass-through otherwise; downstream sees req.orgContext as today.
 */
export const enforceOrgSlug = async (
    req: Request,
    res: Response,
    next: NextFunction
): Promise<void> => {
    const rawSlug = req.params?.orgSlug;
    const slug = Array.isArray(rawSlug) ? rawSlug[0] : rawSlug;
    if (!slug || typeof slug !== 'string') {
        return next();
    }

    const org = await prisma.organization.findUnique({
        where: { slug },
        select: { id: true },
    });
    if (!org) {
        res.status(404).json({
            jsonrpc: '2.0',
            error: { code: -32004, message: 'Organization not found for this MCP URL.' },
            id: null,
        });
        return;
    }

    // Token must already have been resolved upstream. If not, the upstream
    // middleware should have already 401'd; defensive check just in case.
    const tokenOrgId = req.orgContext?.organizationId;
    if (!tokenOrgId) {
        res.status(401).json({
            jsonrpc: '2.0',
            error: { code: -32001, message: 'Authentication required.' },
            id: null,
        });
        return;
    }

    if (tokenOrgId !== org.id) {
        logger.warn('[MCP] Per-org URL mismatch — token org does not match URL slug', {
            urlSlug: slug,
            urlOrgId: org.id,
            tokenOrgId,
        });
        res.status(403).json({
            jsonrpc: '2.0',
            error: {
                code: -32003,
                message: 'This connector is for a different organization. Re-authorize from the matching org’s dashboard to connect this URL.',
            },
            id: null,
        });
        return;
    }

    next();
};
