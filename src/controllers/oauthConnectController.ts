/**
 * OAuth Connect Controller
 *
 * Handles the OAuth authorization + callback flow for connecting Google and
 * Microsoft mailboxes to the Sequencer. Creates ConnectedAccount records with
 * encrypted tokens once consent is granted.
 */

import { Request, Response } from 'express';
import { getOrgId } from '../middleware/orgContext';
import { prisma } from '../index';
import { logger } from '../services/observabilityService';
import { encrypt } from '../utils/encryption';
import { getSequencerSettings } from '../services/sequencerSettingsService';
import { provisionMailboxForConnectedAccount } from '../services/mailboxProvisioningService';
import {
    getGoogleAuthorizationUrl,
    parseGoogleState,
    exchangeGoogleCodeForTokens,
} from '../services/gmailSendService';
import {
    getMicrosoftAuthorizationUrl,
    parseMicrosoftState,
    exchangeMicrosoftCodeForTokens,
} from '../services/microsoftSendService';

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

// ─── GOOGLE ──────────────────────────────────────────────────────────────────

export const googleAuthorize = async (req: Request, res: Response): Promise<void> => {
    try {
        const orgId = getOrgId(req);
        const url = getGoogleAuthorizationUrl(orgId);
        res.redirect(url);
    } catch (err: any) {
        logger.error('[OAUTH] Google authorize failed', err);
        res.redirect(`${FRONTEND_URL}/dashboard/sequencer/accounts?error=${encodeURIComponent(err.message || 'OAuth setup failed')}`);
    }
};

export const googleCallback = async (req: Request, res: Response): Promise<void> => {
    const { code, state, error: oauthError } = req.query;

    if (oauthError) {
        logger.warn('[OAUTH] Google callback returned error', { error: oauthError });
        return res.redirect(`${FRONTEND_URL}/dashboard/sequencer/accounts?error=${encodeURIComponent(String(oauthError))}`);
    }

    if (!code || !state) {
        return res.redirect(`${FRONTEND_URL}/dashboard/sequencer/accounts?error=missing_code_or_state`);
    }

    const parsed = parseGoogleState(String(state));
    if (!parsed) {
        return res.redirect(`${FRONTEND_URL}/dashboard/sequencer/accounts?error=invalid_state`);
    }

    try {
        const { access_token, refresh_token, expires_at, email, name } = await exchangeGoogleCodeForTokens(String(code));

        // Upsert ConnectedAccount — if this org already has this email as google, update tokens
        const existing = await prisma.connectedAccount.findUnique({
            where: { organization_id_email: { organization_id: parsed.orgId, email } },
        });

        let accountId: string;
        if (existing) {
            await prisma.connectedAccount.update({
                where: { id: existing.id },
                data: {
                    provider: 'google',
                    access_token: encrypt(access_token),
                    refresh_token: encrypt(refresh_token),
                    token_expires_at: expires_at,
                    connection_status: 'active',
                    last_error: null,
                    display_name: name || existing.display_name,
                },
            });
            accountId = existing.id;
        } else {
            const orgSettings = await getSequencerSettings(parsed.orgId);
            const created = await prisma.connectedAccount.create({
                data: {
                    organization_id: parsed.orgId,
                    email,
                    display_name: name || null,
                    provider: 'google',
                    access_token: encrypt(access_token),
                    refresh_token: encrypt(refresh_token),
                    token_expires_at: expires_at,
                    connection_status: 'active',
                    daily_send_limit: orgSettings.default_daily_limit,
                },
            });
            accountId = created.id;
        }

        // Idempotent — creates shadow Mailbox + Domain if missing, no-op if already exists
        await provisionMailboxForConnectedAccount({
            connectedAccountId: accountId,
            organizationId: parsed.orgId,
            email,
            displayName: name,
        }).catch((e) => logger.error('[OAUTH] Google provisioning failed', e));

        logger.info(`[OAUTH] Google account connected: ${email}`, { orgId: parsed.orgId });
        res.redirect(`${FRONTEND_URL}/dashboard/sequencer/accounts?connected=google&email=${encodeURIComponent(email)}`);
    } catch (err: any) {
        logger.error('[OAUTH] Google callback failed', err);
        res.redirect(`${FRONTEND_URL}/dashboard/sequencer/accounts?error=${encodeURIComponent(err.message || 'Connection failed')}`);
    }
};

// ─── MICROSOFT ───────────────────────────────────────────────────────────────

export const microsoftAuthorize = async (req: Request, res: Response): Promise<void> => {
    try {
        const orgId = getOrgId(req);
        const url = await getMicrosoftAuthorizationUrl(orgId);
        res.redirect(url);
    } catch (err: any) {
        logger.error('[OAUTH] Microsoft authorize failed', err);
        res.redirect(`${FRONTEND_URL}/dashboard/sequencer/accounts?error=${encodeURIComponent(err.message || 'OAuth setup failed')}`);
    }
};

export const microsoftCallback = async (req: Request, res: Response): Promise<void> => {
    const { code, state, error: oauthError, error_description } = req.query;

    if (oauthError) {
        logger.warn('[OAUTH] Microsoft callback returned error', { error: oauthError, description: error_description });
        return res.redirect(`${FRONTEND_URL}/dashboard/sequencer/accounts?error=${encodeURIComponent(String(error_description || oauthError))}`);
    }

    if (!code || !state) {
        return res.redirect(`${FRONTEND_URL}/dashboard/sequencer/accounts?error=missing_code_or_state`);
    }

    const parsed = parseMicrosoftState(String(state));
    if (!parsed) {
        return res.redirect(`${FRONTEND_URL}/dashboard/sequencer/accounts?error=invalid_state`);
    }

    try {
        const { access_token, refresh_token, expires_at, email, name } = await exchangeMicrosoftCodeForTokens(String(code));

        const existing = await prisma.connectedAccount.findUnique({
            where: { organization_id_email: { organization_id: parsed.orgId, email } },
        });

        let accountId: string;
        if (existing) {
            await prisma.connectedAccount.update({
                where: { id: existing.id },
                data: {
                    provider: 'microsoft',
                    access_token: encrypt(access_token),
                    refresh_token: encrypt(refresh_token),
                    token_expires_at: expires_at,
                    connection_status: 'active',
                    last_error: null,
                    display_name: name || existing.display_name,
                },
            });
            accountId = existing.id;
        } else {
            const orgSettings = await getSequencerSettings(parsed.orgId);
            const created = await prisma.connectedAccount.create({
                data: {
                    organization_id: parsed.orgId,
                    email,
                    display_name: name || null,
                    provider: 'microsoft',
                    access_token: encrypt(access_token),
                    refresh_token: encrypt(refresh_token),
                    token_expires_at: expires_at,
                    connection_status: 'active',
                    daily_send_limit: orgSettings.default_daily_limit,
                },
            });
            accountId = created.id;
        }

        await provisionMailboxForConnectedAccount({
            connectedAccountId: accountId,
            organizationId: parsed.orgId,
            email,
            displayName: name,
        }).catch((e) => logger.error('[OAUTH] Microsoft provisioning failed', e));

        logger.info(`[OAUTH] Microsoft account connected: ${email}`, { orgId: parsed.orgId });
        res.redirect(`${FRONTEND_URL}/dashboard/sequencer/accounts?connected=microsoft&email=${encodeURIComponent(email)}`);
    } catch (err: any) {
        logger.error('[OAUTH] Microsoft callback failed', err);
        res.redirect(`${FRONTEND_URL}/dashboard/sequencer/accounts?error=${encodeURIComponent(err.message || 'Connection failed')}`);
    }
};
