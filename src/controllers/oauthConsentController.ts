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
