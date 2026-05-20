/**
 * OAuth consent controller.
 *
 * The frontend at /oauth/consent talks to these endpoints to:
 *   1. Decode the consent session JWT (set by SuperkabeOAuthProvider.authorize)
 *      and surface the requesting client + scopes to the user.
 *   2. On approval, mint an authorization code and return the redirect URL
 *      that the frontend then sends the browser to.
 */

import type { Request, Response } from 'express';
import { logger } from '../services/observabilityService';
import { prisma } from '../prisma';
import { oauthProvider, verifyConsentSession, SUPPORTED_SCOPES } from '../mcp/oauthProvider';
import { recordConsentFromRequest } from '../services/consentService';
import { recordSecurityEvent, EVENT_TYPES } from '../services/securityAuditLog';

/**
 * Pull the org slug out of an RFC 8707 resource URL like
 * `https://api.superkabe.com/mcp/<slug>`. Returns null for the bare
 * `/mcp` URL (back-compat - no per-org binding requested) or anything
 * that doesn't match the expected shape.
 */
function extractOrgSlugFromResource(resource: string | undefined): string | null {
    if (!resource) return null;
    try {
        const u = new URL(resource);
        // Match /mcp/<slug> only - bare /mcp returns null.
        const m = u.pathname.match(/^\/mcp\/([^\/]+)$/);
        return m ? m[1] : null;
    } catch {
        return null;
    }
}

/**
 * GET /oauth/consent/details?session=<jwt>
 * Returns information the consent page needs to render.
 */
export async function getConsentDetails(req: Request, res: Response): Promise<Response> {
    const session = req.query.session as string | undefined;
    if (!session) {
        return res.status(400).json({ success: false, error: 'session is required' });
    }

    let payload;
    try {
        payload = verifyConsentSession(session);
    } catch (err) {
        logger.warn('[OAUTH] invalid consent session', { error: (err as Error).message });
        return res.status(400).json({ success: false, error: 'Consent session expired or invalid. Restart the connection from your MCP client.' });
    }

    const client = await prisma.oAuthClient.findUnique({ where: { client_id: payload.client_id } });
    if (!client || client.revoked_at) {
        return res.status(400).json({ success: false, error: 'Unknown OAuth client' });
    }

    // If the client requested a per-org resource (e.g. `/mcp/acme-inc`),
    // resolve the org so the consent UI can show "Authorize Claude for
    // Acme Inc." instead of a generic prompt. Bare `/mcp` returns null →
    // UI falls back to the user's current org at approve time.
    const targetSlug = extractOrgSlugFromResource(payload.resource);
    let target_org: { id: string; name: string; slug: string } | null = null;
    if (targetSlug) {
        const org = await prisma.organization.findUnique({
            where: { slug: targetSlug },
            select: { id: true, name: true, slug: true },
        });
        if (!org) {
            return res.status(404).json({
                success: false,
                error: `No organization found for "${targetSlug}". The MCP URL in your client may be wrong.`,
            });
        }
        target_org = org;
    }

    return res.json({
        success: true,
        data: {
            client: {
                name: client.client_name,
                client_uri: client.client_uri,
                logo_uri: client.logo_uri,
            },
            scopes: payload.scopes,
            supported_scopes: SUPPORTED_SCOPES,
            target_org,
        },
    });
}

/**
 * POST /oauth/consent/approve
 * Body: {
 *   session: string,
 *   granted_scopes?: string[]   // OPTIONAL user-narrowed subset of the
 *                                // client-requested scopes. Omitted →
 *                                // full requested set (back-compat).
 *                                // Server enforces: must be a subset of
 *                                // payload.scopes; cannot widen; unknown
 *                                // scopes rejected.
 * }
 * Requires: authenticated user (req.orgContext set by extractOrgContext).
 * Returns: { redirect_to: string }
 */
export async function approveConsent(req: Request, res: Response): Promise<Response> {
    if (!req.orgContext) {
        return res.status(401).json({ success: false, error: 'Login required' });
    }

    const { session, granted_scopes } = req.body;
    if (!session || typeof session !== 'string') {
        return res.status(400).json({ success: false, error: 'session is required' });
    }

    let payload;
    try {
        payload = verifyConsentSession(session);
    } catch {
        return res.status(400).json({ success: false, error: 'Consent session expired. Restart the connection.' });
    }

    // Resolve the actually-granted scopes. API/MCP audit G5 root-cause
    // fix: previously the controller used payload.scopes verbatim, so the
    // user couldn't say "OK to read but NOT to launch campaigns" - the
    // OAuth scope vocabulary was theatrical. Now the consent UI can post
    // a user-chosen subset; we enforce three rules:
    //   (1) every requested scope must be a STRING and a known scope
    //       from SUPPORTED_SCOPES (no fabrication)
    //   (2) the granted set must be a subset of payload.scopes (no
    //       widening past what the client asked for)
    //   (3) omitting the field falls back to the full requested set
    //       so existing consent UIs that don't post the field keep
    //       working unchanged
    let effectiveScopes: string[] = payload.scopes;
    if (granted_scopes !== undefined) {
        if (!Array.isArray(granted_scopes) || granted_scopes.some(s => typeof s !== 'string')) {
            return res.status(400).json({
                success: false,
                error: 'granted_scopes must be an array of strings (or omitted to grant the full requested set).',
            });
        }
        const requestedSet = new Set(payload.scopes);
        const unknown = granted_scopes.filter(s => !requestedSet.has(s));
        if (unknown.length > 0) {
            return res.status(400).json({
                success: false,
                error: `granted_scopes contains values the client did not request: ${unknown.join(', ')}. The granted set must be a subset of the requested scopes.`,
            });
        }
        // De-dupe and preserve the canonical (client-requested) order so
        // the audit/Consent row's "documentVersion" stays comparable across
        // grants that selected the same subset in different click orders.
        const grantedSet = new Set(granted_scopes);
        effectiveScopes = payload.scopes.filter(s => grantedSet.has(s));
    }

    const userId = req.orgContext.userId;
    const orgId = req.orgContext.organizationId;
    if (!userId || !orgId) {
        return res.status(401).json({ success: false, error: 'Login required' });
    }

    // Per-org URL flow: if the resource pinned a specific org, verify the
    // signed-in user actually belongs to it. Without this check, a user
    // logged into Org A could approve a Claude.ai connector pointed at
    // `/mcp/org-b` and the resulting token would still bind to Org A -
    // the URL would lie about which org Claude is talking to. Reject with
    // a message that tells them what to do (log into the right account).
    const targetSlug = extractOrgSlugFromResource(payload.resource);
    if (targetSlug) {
        const targetOrg = await prisma.organization.findUnique({
            where: { slug: targetSlug },
            select: { id: true, slug: true, name: true },
        });
        if (!targetOrg) {
            return res.status(404).json({
                success: false,
                error: `No organization found for "${targetSlug}".`,
            });
        }
        if (targetOrg.id !== orgId) {
            logger.warn('[OAUTH] Consent denied - signed-in org does not match resource slug', {
                userId,
                signedInOrgId: orgId,
                targetSlug,
                targetOrgId: targetOrg.id,
            });
            return res.status(403).json({
                success: false,
                error: `You're signed in to a different Superkabe organization than this connector targets (${targetOrg.name}). Sign out and sign in with an account that belongs to ${targetOrg.name}, then re-open this consent link from your MCP client.`,
            });
        }
    }

    const code = await oauthProvider.createAuthorizationCode({
        client_id: payload.client_id,
        user_id: userId,
        organization_id: orgId,
        redirect_uri: payload.redirect_uri,
        // effectiveScopes - the user-narrowed subset (or the full requested
        // set if the consent UI didn't post a subset). The Authorization
        // Code row stores ONLY what was actually granted; the downstream
        // token-exchange respects it without re-consulting the requested
        // set, so a narrowed grant can never silently widen at /token.
        scope: effectiveScopes.join(' '),
        code_challenge: payload.code_challenge,
        code_challenge_method: payload.code_challenge_method,
        resource: payload.resource,
        state: payload.state,
    });

    // Record an audit-grade consent row. MCP OAuth grants give third-party
    // AI clients (Claude.ai, etc.) ongoing access to the user's data - that's
    // a substantial privacy decision and needs a Consent row alongside the
    // OAuthAccessToken/AuthorizationCode. The token's revocation lifecycle
    // is functional state; this Consent record is the legal artifact saying
    // "user X authorized client Y for scopes Z on date D from IP/UA".
    // Snapshotted email/name + IP/UA come from the request via
    // recordConsentFromRequest so the row stays valid even if the user is
    // erased later. Best-effort - failure must not break the OAuth flow.
    try {
        const userRow = await prisma.user.findUnique({
            where: { id: userId },
            select: { email: true, name: true },
        });
        const clientRow = await prisma.oAuthClient.findUnique({
            where: { client_id: payload.client_id },
            select: { client_name: true, client_uri: true, redirect_uris: true },
        });
        await recordConsentFromRequest(req, {
            consentType: 'mcp_oauth_grant',
            // Canonical scope-string is the "version" of what was granted -
            // a re-authorization with different scopes produces a distinct
            // Consent row, which is exactly what we want. We record the
            // ACTUALLY-granted set (post-narrowing), not the requested
            // set, because that is what the user signed up to.
            documentVersion: effectiveScopes.slice().sort().join(' '),
            channel: 'oauth_consent_screen',
            userId,
            organizationId: orgId,
            userEmailSnapshot: userRow?.email || null,
            userNameSnapshot: userRow?.name || null,
            metadata: {
                client_id: payload.client_id,
                client_name: clientRow?.client_name || null,
                client_uri: clientRow?.client_uri || null,
                // Surface both the requested and the granted set so an
                // auditor can see whether the user narrowed scopes.
                requested_scopes: payload.scopes,
                granted_scopes: effectiveScopes,
                redirect_uri: payload.redirect_uri,
                resource: payload.resource || null,
            },
        });
    } catch (err) {
        // Don't break the user's OAuth flow if consent recording fails -
        // log loudly so ops can backfill if needed.
        logger.error('[OAUTH] Failed to record MCP grant consent (non-fatal)',
            err instanceof Error ? err : new Error(String(err)));
    }

    const url = new URL(payload.redirect_uri);
    url.searchParams.set('code', code);
    if (payload.state) url.searchParams.set('state', payload.state);

    logger.info('[OAUTH] Consent approved', { clientId: payload.client_id, userId, orgId });
    void recordSecurityEvent({
        organizationId: orgId,
        actorKind: 'user',
        actorId: userId,
        eventType: EVENT_TYPES.OAUTH_CONSENT_APPROVED,
        target: payload.client_id,
        metadata: {
            requested_scopes: payload.scopes,
            granted_scopes: effectiveScopes,
            redirect_uri: payload.redirect_uri,
            resource: payload.resource || null,
        },
        req,
    });

    return res.json({
        success: true,
        data: { redirect_to: url.toString() },
    });
}

/**
 * POST /oauth/consent/deny
 * Body: { session: string }
 * Returns: { redirect_to: string }   (carries `error=access_denied` per RFC 6749)
 */
export async function denyConsent(req: Request, res: Response): Promise<Response> {
    const { session } = req.body;
    if (!session || typeof session !== 'string') {
        return res.status(400).json({ success: false, error: 'session is required' });
    }

    let payload;
    try {
        payload = verifyConsentSession(session);
    } catch {
        return res.status(400).json({ success: false, error: 'Consent session expired' });
    }

    const url = new URL(payload.redirect_uri);
    url.searchParams.set('error', 'access_denied');
    url.searchParams.set('error_description', 'User denied authorization');
    if (payload.state) url.searchParams.set('state', payload.state);

    void recordSecurityEvent({
        organizationId: req.orgContext?.organizationId ?? null,
        actorKind: req.orgContext?.userId ? 'user' : 'system',
        actorId: req.orgContext?.userId ?? null,
        eventType: EVENT_TYPES.OAUTH_CONSENT_DENIED,
        target: payload.client_id,
        metadata: { requested_scopes: payload.scopes },
        req,
    });

    return res.json({
        success: true,
        data: { redirect_to: url.toString() },
    });
}
