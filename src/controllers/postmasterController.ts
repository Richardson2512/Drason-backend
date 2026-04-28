/**
 * Postmaster Tools Controller
 *
 * - POST /api/postmaster/connect           — returns Google authorize URL
 * - GET  /oauth/callback/postmaster        — Google redirects back here (PUBLIC)
 * - POST /api/postmaster/disconnect        — revokes local tokens
 * - POST /api/postmaster/fetch-now         — admin trigger for ad-hoc fetch
 * - GET  /api/postmaster/status            — connection state for the dashboard
 * - GET  /api/dashboard/domains/:id/reputation?days=30 — time series for charts
 */

import { Request, Response } from 'express';
import { getOrgId } from '../middleware/orgContext';
import { logger } from '../services/observabilityService';
import { prisma } from '../index';
import { recordConsentFromRequest } from '../services/consentService';
import {
    buildAuthorizeUrl,
    completeAuthorization,
    disconnect as svcDisconnect,
    fetchAllForOrg,
} from '../services/postmasterToolsService';

/** POST /api/postmaster/connect → returns the Google authorize URL the
 *  frontend should open in a new tab. */
export const startConnect = async (req: Request, res: Response) => {
    try {
        const orgId = getOrgId(req);
        const url = buildAuthorizeUrl(orgId);
        res.json({ success: true, authorizeUrl: url });
    } catch (err: any) {
        logger.error('[POSTMASTER] startConnect failed', err);
        res.status(500).json({ success: false, error: err.message || 'Failed to build authorize URL' });
    }
};

/** GET /oauth/callback/postmaster — public route that Google redirects to
 *  after the user grants consent. State carries the orgId. */
export const oauthCallback = async (req: Request, res: Response) => {
    const { code, state, error } = req.query as { code?: string; state?: string; error?: string };
    const frontendBase = (process.env.FRONTEND_URL || '').replace(/\/+$/, '');

    if (error) {
        logger.warn('[POSTMASTER] OAuth callback error', { error });
        return res.redirect(`${frontendBase}/dashboard/settings?postmaster=error&reason=${encodeURIComponent(String(error))}`);
    }
    if (!code || !state) {
        return res.status(400).send('Missing code/state');
    }

    try {
        await completeAuthorization(state, code);

        // Record OAuth consent — required for GDPR Art. 7(1) auditability.
        // We capture the moment Google's consent UI was completed, with the
        // exact scope string the user authorized.
        try {
            const orgFirstUser = await prisma.user.findFirst({
                where: { organization_id: state },
                orderBy: { created_at: 'asc' },
                select: { id: true, email: true, name: true },
            });
            await recordConsentFromRequest(req, {
                consentType: 'oauth_postmaster',
                documentVersion: 'https://www.googleapis.com/auth/postmaster.readonly',
                channel: 'oauth_callback',
                userId: orgFirstUser?.id || null,
                organizationId: state,
                userEmailSnapshot: orgFirstUser?.email || null,
                userNameSnapshot: orgFirstUser?.name || null,
                metadata: {
                    provider: 'google_postmaster',
                    scope: 'https://www.googleapis.com/auth/postmaster.readonly',
                },
            });
        } catch (consentErr) {
            logger.error(
                '[POSTMASTER] OAuth consent record failed — manual remediation required',
                consentErr instanceof Error ? consentErr : new Error(String(consentErr)),
                { orgId: state },
            );
        }

        res.redirect(`${frontendBase}/dashboard/settings?postmaster=connected`);
    } catch (err: any) {
        logger.error('[POSTMASTER] OAuth callback failed', err);
        res.redirect(`${frontendBase}/dashboard/settings?postmaster=error&reason=${encodeURIComponent(err.message?.slice(0, 80) || 'unknown')}`);
    }
};

/** POST /api/postmaster/disconnect */
export const disconnect = async (req: Request, res: Response) => {
    try {
        const orgId = getOrgId(req);
        await svcDisconnect(orgId);
        res.json({ success: true });
    } catch (err: any) {
        logger.error('[POSTMASTER] disconnect failed', err);
        res.status(500).json({ success: false, error: err.message || 'Failed to disconnect' });
    }
};

/** POST /api/postmaster/fetch-now — admin-triggered ad-hoc fetch. */
export const fetchNow = async (req: Request, res: Response) => {
    try {
        const orgId = getOrgId(req);
        const result = await fetchAllForOrg(orgId);
        res.json({ success: true, result });
    } catch (err: any) {
        logger.error('[POSTMASTER] fetchNow failed', err);
        res.status(500).json({ success: false, error: err.message || 'Failed to fetch' });
    }
};

/** GET /api/postmaster/status — returns connection state for the dashboard. */
export const getStatus = async (req: Request, res: Response) => {
    try {
        const orgId = getOrgId(req);
        const org = await prisma.organization.findUnique({
            where: { id: orgId },
            select: {
                postmaster_connected_at: true,
                postmaster_last_fetch_at: true,
                postmaster_last_error: true,
            },
        });
        res.json({
            success: true,
            connected: !!org?.postmaster_connected_at,
            connectedAt: org?.postmaster_connected_at,
            lastFetchAt: org?.postmaster_last_fetch_at,
            lastError: org?.postmaster_last_error,
        });
    } catch (err: any) {
        res.status(500).json({ success: false, error: err.message || 'Failed to read status' });
    }
};

/** GET /api/dashboard/domains/:id/reputation?days=30 — time series. */
export const getDomainReputation = async (req: Request, res: Response) => {
    try {
        const orgId = getOrgId(req);
        const domainId = String(req.params.id);
        const days = Math.min(180, Math.max(1, parseInt(String(req.query.days ?? '30'), 10)));
        const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

        // Tenant guard: caller's org must own the domain.
        const owns = await prisma.domain.count({
            where: { id: domainId, organization_id: orgId },
        });
        if (owns === 0) return res.status(404).json({ success: false, error: 'Domain not found' });

        const rows = await prisma.domainReputation.findMany({
            where: {
                domain_id: domainId,
                date: { gte: since },
            },
            orderBy: { date: 'asc' },
            select: {
                date: true,
                source: true,
                reputation: true,
                spam_rate: true,
                authentication_dkim_pass_rate: true,
                authentication_spf_pass_rate: true,
                authentication_dmarc_pass_rate: true,
                encryption_outbound_rate: true,
            },
        });

        res.json({ success: true, data: rows });
    } catch (err: any) {
        logger.error('[POSTMASTER] getDomainReputation failed', err);
        res.status(500).json({ success: false, error: err.message || 'Failed to read reputation' });
    }
};
