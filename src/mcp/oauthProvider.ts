/**
 * SuperkabeOAuthProvider — OAuth 2.0 / DCR / PKCE provider for the
 * MCP authorization router.
 *
 * Backs the SDK's mcpAuthRouter with our Postgres tables:
 *   - OAuthClient        (DCR-registered MCP clients)
 *   - OAuthAuthorizationCode (60-second auth codes, single-use, PKCE)
 *   - OAuthAccessToken   (1-hour access + 90-day refresh, both hashed)
 *
 * Flow:
 *   1. Client (Claude.ai) POSTs to /register → we persist a public client
 *      record, hand back client_id (no secret — public client + PKCE).
 *   2. Client redirects user to /authorize → SDK calls our authorize().
 *      We sign a short-lived JWT carrying the auth params and bounce the
 *      user to the frontend consent UI at /oauth/consent?session=<jwt>.
 *   3. User approves on the frontend → frontend POSTs /oauth/consent/approve
 *      → controller mints the auth code and returns the redirect URL.
 *   4. Client POSTs /token with code + verifier → SDK calls our
 *      exchangeAuthorizationCode() → we mint access + refresh tokens.
 *   5. Client calls /mcp with `Authorization: Bearer oat_…` → our
 *      extractOrgContext middleware calls verifyAccessToken() to resolve
 *      the org context.
 */

import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import type { Response } from 'express';
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type {
    OAuthClientInformationFull,
    OAuthTokens,
    OAuthTokenRevocationRequest,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { prisma } from '../index';
import { logger } from '../services/observabilityService';

// ────────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────────

const ACCESS_TOKEN_TTL_SEC = 60 * 60;             // 1 hour
const REFRESH_TOKEN_TTL_SEC = 90 * 24 * 60 * 60;  // 90 days
const AUTH_CODE_TTL_SEC = 60;                     // 60 seconds
const CONSENT_SESSION_TTL_SEC = 10 * 60;          // 10 minutes

// All scopes a client may be granted. Mirrors the API-key scope vocabulary
// in apiKeyController so OAuth-issued tokens slot into the same authz model.
export const SUPPORTED_SCOPES = [
    'account:read',
    'leads:read', 'leads:write',
    'campaigns:read', 'campaigns:write',
    'mailboxes:read',
    'domains:read',
    'replies:read', 'replies:send',
    'validation:read', 'validation:trigger',
    'reports:read',
];

const FRONTEND_URL = (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

function hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
}

function generateToken(prefix: string): string {
    return `${prefix}_${crypto.randomBytes(32).toString('hex')}`;
}

function nowSec(): number {
    return Math.floor(Date.now() / 1000);
}

interface ConsentSessionPayload {
    client_id: string;
    redirect_uri: string;
    code_challenge: string;
    code_challenge_method: string;
    state?: string;
    scopes: string[];
    resource?: string;
}

export function signConsentSession(payload: ConsentSessionPayload): string {
    return jwt.sign(payload, JWT_SECRET, { expiresIn: CONSENT_SESSION_TTL_SEC });
}

export function verifyConsentSession(token: string): ConsentSessionPayload {
    return jwt.verify(token, JWT_SECRET) as ConsentSessionPayload;
}

// ────────────────────────────────────────────────────────────────────
// Clients store (Dynamic Client Registration)
// ────────────────────────────────────────────────────────────────────

class SuperkabeClientsStore implements OAuthRegisteredClientsStore {
    async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
        const c = await prisma.oAuthClient.findUnique({ where: { client_id: clientId } });
        if (!c || c.revoked_at) return undefined;
        return this.toFullInfo(c);
    }

    async registerClient(
        info: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>
    ): Promise<OAuthClientInformationFull> {
        const clientId = `mcp_client_${crypto.randomBytes(12).toString('hex')}`;

        // We allow only public clients (PKCE-based). If a secret is
        // requested, we generate one and hash it; otherwise null.
        const wantsSecret = info.token_endpoint_auth_method && info.token_endpoint_auth_method !== 'none';
        let plainSecret: string | undefined;
        let secretHash: string | null = null;
        if (wantsSecret) {
            plainSecret = `mcp_secret_${crypto.randomBytes(32).toString('hex')}`;
            secretHash = await bcrypt.hash(plainSecret, 10);
        }

        const created = await prisma.oAuthClient.create({
            data: {
                client_id: clientId,
                client_secret_hash: secretHash,
                client_name: info.client_name || 'MCP Client',
                redirect_uris: info.redirect_uris as any,
                grant_types: (info.grant_types || ['authorization_code', 'refresh_token']) as any,
                response_types: (info.response_types || ['code']) as any,
                token_endpoint_auth_method: info.token_endpoint_auth_method || 'none',
                scope: info.scope || SUPPORTED_SCOPES.join(' '),
                client_uri: info.client_uri || null,
                logo_uri: info.logo_uri || null,
                software_id: info.software_id || null,
                software_version: info.software_version || null,
            },
        });

        logger.info('[OAUTH] Registered new client', { clientId, name: created.client_name });

        const full = this.toFullInfo(created);
        if (plainSecret) full.client_secret = plainSecret;
        return full;
    }

    private toFullInfo(c: any): OAuthClientInformationFull {
        return {
            client_id: c.client_id,
            client_name: c.client_name,
            redirect_uris: c.redirect_uris,
            grant_types: c.grant_types,
            response_types: c.response_types,
            token_endpoint_auth_method: c.token_endpoint_auth_method,
            scope: c.scope || undefined,
            client_uri: c.client_uri || undefined,
            logo_uri: c.logo_uri || undefined,
            software_id: c.software_id || undefined,
            software_version: c.software_version || undefined,
            client_id_issued_at: Math.floor(c.client_id_issued_at.getTime() / 1000),
            client_secret_expires_at: c.client_secret_expires_at
                ? Math.floor(c.client_secret_expires_at.getTime() / 1000)
                : 0,
        };
    }
}

// ────────────────────────────────────────────────────────────────────
// Provider
// ────────────────────────────────────────────────────────────────────

export class SuperkabeOAuthProvider implements OAuthServerProvider {
    readonly clientsStore = new SuperkabeClientsStore();

    /**
     * Called by the SDK when a client redirects the user to /authorize.
     * We don't issue the code yet — we bounce the user to our consent UI
     * with the auth params packed into a signed JWT. After consent the
     * frontend posts /oauth/consent/approve with the user's session and
     * we mint the actual code there.
     */
    async authorize(
        client: OAuthClientInformationFull,
        params: AuthorizationParams,
        res: Response
    ): Promise<void> {
        const session = signConsentSession({
            client_id: client.client_id,
            redirect_uri: params.redirectUri,
            code_challenge: params.codeChallenge,
            code_challenge_method: 'S256',
            state: params.state,
            scopes: params.scopes ?? SUPPORTED_SCOPES,
            resource: params.resource?.toString(),
        });

        const consentUrl = `${FRONTEND_URL}/oauth/consent?session=${encodeURIComponent(session)}`;
        logger.info('[OAUTH] Authorize → bounce to consent UI', { clientId: client.client_id });
        res.redirect(consentUrl);
    }

    /** Returns the PKCE challenge stored when the auth code was issued. */
    async challengeForAuthorizationCode(
        _client: OAuthClientInformationFull,
        authorizationCode: string
    ): Promise<string> {
        const row = await prisma.oAuthAuthorizationCode.findUnique({
            where: { code_hash: hashToken(authorizationCode) },
        });
        if (!row) throw new Error('Invalid authorization code');
        if (row.used_at) throw new Error('Authorization code already used');
        if (row.expires_at < new Date()) throw new Error('Authorization code expired');
        return row.code_challenge;
    }

    async exchangeAuthorizationCode(
        client: OAuthClientInformationFull,
        authorizationCode: string,
        _codeVerifier?: string,
        redirectUri?: string,
        resource?: URL
    ): Promise<OAuthTokens> {
        const codeHash = hashToken(authorizationCode);

        const row = await prisma.oAuthAuthorizationCode.findUnique({ where: { code_hash: codeHash } });
        if (!row) throw new Error('Invalid authorization code');
        if (row.used_at) throw new Error('Authorization code already used');
        if (row.expires_at < new Date()) throw new Error('Authorization code expired');
        if (row.client_id !== client.client_id) throw new Error('Authorization code issued to a different client');
        if (redirectUri && row.redirect_uri !== redirectUri) throw new Error('redirect_uri mismatch');

        // Mark used FIRST to prevent replay even if subsequent operations race.
        await prisma.oAuthAuthorizationCode.update({
            where: { code_hash: codeHash },
            data: { used_at: new Date() },
        });

        return this.mintTokens({
            client_id: client.client_id,
            user_id: row.user_id,
            organization_id: row.organization_id,
            scope: row.scope || SUPPORTED_SCOPES.join(' '),
            resource: resource?.toString() ?? row.resource ?? undefined,
        });
    }

    async exchangeRefreshToken(
        client: OAuthClientInformationFull,
        refreshToken: string,
        scopes?: string[],
        resource?: URL
    ): Promise<OAuthTokens> {
        const refreshHash = hashToken(refreshToken);

        const row = await prisma.oAuthAccessToken.findUnique({ where: { refresh_token_hash: refreshHash } });
        if (!row) throw new Error('Invalid refresh token');
        if (row.revoked_at) throw new Error('Refresh token revoked');
        if (row.refresh_expires_at && row.refresh_expires_at < new Date()) {
            throw new Error('Refresh token expired');
        }
        if (row.client_id !== client.client_id) throw new Error('Refresh token issued to a different client');

        // Narrow scopes if requested; never widen.
        const grantedScopes = (row.scope || '').split(/\s+/).filter(Boolean);
        const newScope = scopes && scopes.length > 0
            ? scopes.filter(s => grantedScopes.includes(s)).join(' ')
            : row.scope;

        // Refresh token rotation — revoke the old grant and issue new pair.
        await prisma.oAuthAccessToken.update({
            where: { id: row.id },
            data: { revoked_at: new Date() },
        });

        return this.mintTokens({
            client_id: client.client_id,
            user_id: row.user_id,
            organization_id: row.organization_id,
            scope: newScope || SUPPORTED_SCOPES.join(' '),
            resource: resource?.toString() ?? row.resource ?? undefined,
        });
    }

    async verifyAccessToken(token: string): Promise<AuthInfo> {
        const row = await prisma.oAuthAccessToken.findUnique({ where: { access_token_hash: hashToken(token) } });
        if (!row) throw new Error('Invalid access token');
        if (row.revoked_at) throw new Error('Access token revoked');
        if (row.expires_at < new Date()) throw new Error('Access token expired');

        prisma.oAuthAccessToken.update({
            where: { id: row.id },
            data: { last_used_at: new Date() },
        }).catch(() => undefined); // fire-and-forget

        return {
            token,
            clientId: row.client_id,
            scopes: (row.scope || '').split(/\s+/).filter(Boolean),
            expiresAt: Math.floor(row.expires_at.getTime() / 1000),
            resource: row.resource ? new URL(row.resource) : undefined,
            extra: { user_id: row.user_id, organization_id: row.organization_id },
        };
    }

    async revokeToken(
        _client: OAuthClientInformationFull,
        request: OAuthTokenRevocationRequest
    ): Promise<void> {
        const tokenHash = hashToken(request.token);

        // Try access token first (and its paired refresh), then standalone refresh.
        const byAccess = await prisma.oAuthAccessToken.findUnique({ where: { access_token_hash: tokenHash } });
        if (byAccess) {
            await prisma.oAuthAccessToken.update({
                where: { id: byAccess.id },
                data: { revoked_at: new Date() },
            });
            return;
        }
        const byRefresh = await prisma.oAuthAccessToken.findUnique({ where: { refresh_token_hash: tokenHash } });
        if (byRefresh) {
            await prisma.oAuthAccessToken.update({
                where: { id: byRefresh.id },
                data: { revoked_at: new Date() },
            });
        }
    }

    /**
     * Mint an access + refresh token pair and persist hashes. Called from
     * exchangeAuthorizationCode and exchangeRefreshToken; also called
     * directly by the consent-approve controller after consent.
     */
    async mintTokens(opts: {
        client_id: string;
        user_id: string;
        organization_id: string;
        scope: string;
        resource?: string;
    }): Promise<OAuthTokens> {
        const accessToken = generateToken('oat');
        const refreshToken = generateToken('ort');

        const expires = new Date(Date.now() + ACCESS_TOKEN_TTL_SEC * 1000);
        const refreshExpires = new Date(Date.now() + REFRESH_TOKEN_TTL_SEC * 1000);

        await prisma.oAuthAccessToken.create({
            data: {
                access_token_hash: hashToken(accessToken),
                refresh_token_hash: hashToken(refreshToken),
                client_id: opts.client_id,
                user_id: opts.user_id,
                organization_id: opts.organization_id,
                scope: opts.scope,
                resource: opts.resource ?? null,
                expires_at: expires,
                refresh_expires_at: refreshExpires,
            },
        });

        return {
            access_token: accessToken,
            token_type: 'Bearer',
            expires_in: ACCESS_TOKEN_TTL_SEC,
            refresh_token: refreshToken,
            scope: opts.scope,
        } as OAuthTokens;
    }

    /**
     * Create a single-use authorization code for a consent-approved request.
     * Called by the /oauth/consent/approve controller after the user grants
     * access. Returns the plaintext code so the caller can build the
     * redirect URL.
     */
    async createAuthorizationCode(opts: {
        client_id: string;
        user_id: string;
        organization_id: string;
        redirect_uri: string;
        scope: string;
        code_challenge: string;
        code_challenge_method: string;
        resource?: string;
        state?: string;
    }): Promise<string> {
        const code = generateToken('oac');
        await prisma.oAuthAuthorizationCode.create({
            data: {
                code_hash: hashToken(code),
                client_id: opts.client_id,
                user_id: opts.user_id,
                organization_id: opts.organization_id,
                redirect_uri: opts.redirect_uri,
                scope: opts.scope,
                code_challenge: opts.code_challenge,
                code_challenge_method: opts.code_challenge_method,
                resource: opts.resource ?? null,
                state: opts.state ?? null,
                expires_at: new Date(Date.now() + AUTH_CODE_TTL_SEC * 1000),
            },
        });
        return code;
    }
}

export const oauthProvider = new SuperkabeOAuthProvider();
