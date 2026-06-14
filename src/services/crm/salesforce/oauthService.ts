/**
 * Salesforce OAuth 2.0 service.
 *
 * Production vs sandbox is captured in the state JWT (login_url) so the
 * callback knows which token endpoint to hit and the resulting
 * connection's instance_url is correct. After token exchange the
 * `instance_url` returned by Salesforce is the per-org base URL we
 * persist on CrmConnection.instance_url.
 *
 * Required env vars:
 *   SALESFORCE_CLIENT_ID
 *   SALESFORCE_CLIENT_SECRET
 *   SALESFORCE_REDIRECT_URI    - must match the Connected App's callback
 *   JWT_SECRET                  - reused for state signing
 */

import jwt from 'jsonwebtoken';
import { logger } from '../../observabilityService';
import type { CrmOAuthTokens } from '../types';

export type SalesforceLoginEnv = 'production' | 'sandbox';

const LOGIN_HOSTS: Record<SalesforceLoginEnv, string> = {
    production: 'https://login.salesforce.com',
    sandbox: 'https://test.salesforce.com',
};

export const SALESFORCE_DEFAULT_SCOPES = ['api', 'refresh_token', 'offline_access'] as const;

const STATE_TTL_SEC = 10 * 60;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

interface StatePayload {
    organizationId: string;
    userId: string;
    env: SalesforceLoginEnv;
    redirectAfterConnect?: string;
}

export function envGuard(): { ok: true } | { ok: false; reason: string } {
    if (!process.env.SALESFORCE_CLIENT_ID) return { ok: false, reason: 'SALESFORCE_CLIENT_ID is not set' };
    if (!process.env.SALESFORCE_CLIENT_SECRET) return { ok: false, reason: 'SALESFORCE_CLIENT_SECRET is not set' };
    if (!process.env.SALESFORCE_REDIRECT_URI) return { ok: false, reason: 'SALESFORCE_REDIRECT_URI is not set' };
    return { ok: true };
}

export function signState(payload: StatePayload): string {
    return jwt.sign(payload, JWT_SECRET, { expiresIn: STATE_TTL_SEC });
}

export function verifyState(token: string): StatePayload | null {
    try {
        return jwt.verify(token, JWT_SECRET) as StatePayload;
    } catch {
        return null;
    }
}

export function generateAuthUrl(opts: {
    state: string;
    env: SalesforceLoginEnv;
    scopes?: readonly string[];
}): string {
    const params = new URLSearchParams({
        response_type: 'code',
        client_id: process.env.SALESFORCE_CLIENT_ID!,
        redirect_uri: process.env.SALESFORCE_REDIRECT_URI!,
        scope: (opts.scopes ?? SALESFORCE_DEFAULT_SCOPES).join(' '),
        state: opts.state,
        // Force consent so we get a refresh token on every connect
        prompt: 'consent',
    });
    return `${LOGIN_HOSTS[opts.env]}/services/oauth2/authorize?${params.toString()}`;
}

export async function exchangeCodeForTokens(opts: {
    code: string;
    env: SalesforceLoginEnv;
}): Promise<CrmOAuthTokens & { instance_url?: string }> {
    const body = new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: process.env.SALESFORCE_CLIENT_ID!,
        client_secret: process.env.SALESFORCE_CLIENT_SECRET!,
        redirect_uri: process.env.SALESFORCE_REDIRECT_URI!,
        code: opts.code,
    });

    const res = await fetch(`${LOGIN_HOSTS[opts.env]}/services/oauth2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
    });
    const json = await res.json().catch(() => ({})) as any;
    if (!res.ok) {
        const detail = String(json?.error_description || json?.error || 'unknown').slice(0, 200);
        logger.warn('[SALESFORCE_OAUTH] token exchange failed', { status: res.status, detail });
        throw new Error(`Salesforce token exchange failed: ${detail}`);
    }
    return {
        access_token: json.access_token,
        refresh_token: json.refresh_token ?? null,
        expires_at: null, // Salesforce tokens last for the org session limit; we'll refresh on 401.
        scopes: typeof json.scope === 'string' ? json.scope.split(' ') : undefined,
        extra: { instance_url: json.instance_url, signature: json.signature, id: json.id },
        instance_url: json.instance_url,
    };
}

export async function refreshAccessToken(opts: {
    refreshToken: string;
    env: SalesforceLoginEnv;
}): Promise<CrmOAuthTokens & { instance_url?: string }> {
    const body = new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: process.env.SALESFORCE_CLIENT_ID!,
        client_secret: process.env.SALESFORCE_CLIENT_SECRET!,
        refresh_token: opts.refreshToken,
    });

    const res = await fetch(`${LOGIN_HOSTS[opts.env]}/services/oauth2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
    });
    const json = await res.json().catch(() => ({})) as any;
    if (!res.ok) {
        const detail = String(json?.error_description || json?.error || 'unknown').slice(0, 200);
        throw new Error(`Salesforce refresh failed: ${detail}`);
    }
    return {
        access_token: json.access_token,
        refresh_token: opts.refreshToken,
        expires_at: null,
        scopes: typeof json.scope === 'string' ? json.scope.split(' ') : undefined,
        extra: { instance_url: json.instance_url },
        instance_url: json.instance_url,
    };
}

/**
 * Detect production vs sandbox from a stored instance_url so the refresh
 * flow knows which login host to hit. Salesforce sandbox URLs match
 * `*.sandbox.my.salesforce.com` or `cs*.salesforce.com`.
 */
export function detectEnvFromInstanceUrl(instanceUrl: string | null | undefined): SalesforceLoginEnv {
    if (!instanceUrl) return 'production';
    return /sandbox|test\.salesforce\.com|cs\d+\.salesforce\.com/i.test(instanceUrl) ? 'sandbox' : 'production';
}

export async function fetchAccountInfo(opts: {
    accessToken: string;
    instanceUrl: string;
}): Promise<{ externalAccountId: string; externalAccountName: string }> {
    // /services/oauth2/userinfo returns the org_id and user_id.
    const res = await fetch(`${opts.instanceUrl}/services/oauth2/userinfo`, {
        headers: { Authorization: `Bearer ${opts.accessToken}` },
    });
    const json = await res.json().catch(() => ({})) as any;
    if (!res.ok) {
        throw new Error(`Salesforce userinfo lookup failed (status ${res.status})`);
    }
    return {
        externalAccountId: String(json.organization_id ?? ''),
        externalAccountName: json.name || json.preferred_username || `Salesforce org ${json.organization_id ?? '?'}`,
    };
}
