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
import { prisma } from '../index';
import { oauthProvider, verifyConsentSession, SUPPORTED_SCOPES } from '../mcp/oauthProvider';

/**
 * Pull the org slug out of an RFC 8707 resource URL like
 * `https://api.superkabe.com/mcp/<slug>`. Returns null for the bare
 * `/mcp` URL (back-compat — no per-org binding requested) or anything
 * that doesn't match the expected shape.
 */
function extractOrgSlugFromResource(resource: string | undefined): string | null {
    if (!resource) return null;
    try {
        const u = new URL(resource);
        // Match /mcp/<slug> only — bare /mcp returns null.
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
 * Body: { session: string }
 * Requires: authenticated user (req.orgContext set by extractOrgContext).
 * Returns: { redirect_to: string }
 */
export async function approveConsent(req: Request, res: Response): Promise<Response> {
    if (!req.orgContext) {
        return res.status(401).json({ success: false, error: 'Login required' });
    }

    const { session } = req.body;
    if (!session || typeof session !== 'string') {
        return res.status(400).json({ success: false, error: 'session is required' });
    }

    let payload;
    try {
        payload = verifyConsentSession(session);
    } catch {
        return res.status(400).json({ success: false, error: 'Consent session expired. Restart the connection.' });
    }

    const userId = req.orgContext.userId;
    const orgId = req.orgContext.organizationId;
    if (!userId || !orgId) {
        return res.status(401).json({ success: false, error: 'Login required' });
    }

    // Per-org URL flow: if the resource pinned a specific org, verify the
    // signed-in user actually belongs to it. Without this check, a user
    // logged into Org A could approve a Claude.ai connector pointed at
    // `/mcp/org-b` and the resulting token would still bind to Org A —
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
            logger.warn('[OAUTH] Consent denied — signed-in org does not match resource slug', {
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
        scope: payload.scopes.join(' '),
        code_challenge: payload.code_challenge,
        code_challenge_method: payload.code_challenge_method,
        resource: payload.resource,
        state: payload.state,
    });

    const url = new URL(payload.redirect_uri);
    url.searchParams.set('code', code);
    if (payload.state) url.searchParams.set('state', payload.state);

    logger.info('[OAUTH] Consent approved', { clientId: payload.client_id, userId, orgId });

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

    return res.json({
        success: true,
        data: { redirect_to: url.toString() },
    });
}
