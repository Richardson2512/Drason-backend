/**
 * HubSpot OAuth 2.0 service.
 *
 * Mirrors the shape of googleOAuthService.ts: pure functions, no DB
 * touch, state CSRF protection via signed JWT, refresh-token support
 * (HubSpot grants one when the `oauth` scope is included; we always
 * request it).
 *
 * Required env vars (set at deploy time):
 *   HUBSPOT_CLIENT_ID
 *   HUBSPOT_CLIENT_SECRET
 *   HUBSPOT_REDIRECT_URI       - e.g. https://api.superkabe.com/api/integrations/hubspot/callback
 *   JWT_SECRET                  - reused for state signing
 */

import jwt from 'jsonwebtoken';
import { logger } from '../../observabilityService';
import type { CrmOAuthTokens } from '../types';
import { JWT_SECRET } from '../../../utils/jwtSecret';

const HUBSPOT_AUTH_BASE = 'https://app.hubspot.com/oauth/authorize';
const HUBSPOT_TOKEN_URL = 'https://api.hubapi.com/oauth/v1/token';
const HUBSPOT_API_BASE = 'https://api.hubapi.com';

// Default scopes for v1: read + write contacts, read lists for import,
// schemas for field discovery, timeline for activity push, oauth for
// refresh-token issuance, plus crm.export for bulk listing.
export const HUBSPOT_DEFAULT_SCOPES = [
    'oauth',
    'crm.objects.contacts.read',
    'crm.objects.contacts.write',
    'crm.lists.read',
    'crm.schemas.contacts.read',
    'timeline',
] as const;

const STATE_TTL_SEC = 10 * 60; // 10 minutes - covers the longest realistic OAuth flow

interface StatePayload {
    organizationId: string;
    userId: string;
    redirectAfterConnect?: string;
    /** Source-of-action attribution: dashboard | settings | …. */
    source?: string;
}

export function envGuard(): { ok: true } | { ok: false; reason: string } {
    if (!process.env.HUBSPOT_CLIENT_ID) return { ok: false, reason: 'HUBSPOT_CLIENT_ID is not set' };
    if (!process.env.HUBSPOT_CLIENT_SECRET) return { ok: false, reason: 'HUBSPOT_CLIENT_SECRET is not set' };
    if (!process.env.HUBSPOT_REDIRECT_URI) return { ok: false, reason: 'HUBSPOT_REDIRECT_URI is not set' };
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
    scopes?: readonly string[];
}): string {
    const params = new URLSearchParams({
        client_id: process.env.HUBSPOT_CLIENT_ID!,
        redirect_uri: process.env.HUBSPOT_REDIRECT_URI!,
        scope: (opts.scopes ?? HUBSPOT_DEFAULT_SCOPES).join(' '),
        state: opts.state,
    });
    return `${HUBSPOT_AUTH_BASE}?${params.toString()}`;
}

export async function exchangeCodeForTokens(code: string): Promise<CrmOAuthTokens> {
    const body = new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: process.env.HUBSPOT_CLIENT_ID!,
        client_secret: process.env.HUBSPOT_CLIENT_SECRET!,
        redirect_uri: process.env.HUBSPOT_REDIRECT_URI!,
        code,
    });

    const res = await fetch(HUBSPOT_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
    });

    const json = await res.json().catch(() => ({})) as any;
    if (!res.ok) {
        // Truncate to avoid dumping large response bodies into logs / error
        // chains. HubSpot error responses don't contain tokens but this caps
        // exposure in case upstream changes.
        const detail = String(json?.message || json?.error || 'unknown').slice(0, 200);
        logger.warn('[HUBSPOT_OAUTH] token exchange failed', { status: res.status, detail });
        throw new Error(`HubSpot token exchange failed: ${detail}`);
    }

    const expiresAt = json.expires_in
        ? new Date(Date.now() + (Number(json.expires_in) - 30) * 1000) // 30s safety margin
        : null;

    return {
        access_token: json.access_token,
        refresh_token: json.refresh_token ?? null,
        expires_at: expiresAt,
        scopes: typeof json.scope === 'string' ? json.scope.split(' ') : undefined,
    };
}

export async function refreshAccessToken(refreshToken: string): Promise<CrmOAuthTokens> {
    const body = new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: process.env.HUBSPOT_CLIENT_ID!,
        client_secret: process.env.HUBSPOT_CLIENT_SECRET!,
        refresh_token: refreshToken,
    });

    const res = await fetch(HUBSPOT_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
    });

    const json = await res.json().catch(() => ({})) as any;
    if (!res.ok) {
        const detail = String(json?.message || json?.error || 'unknown').slice(0, 200);
        throw new Error(`HubSpot refresh failed: ${detail}`);
    }

    return {
        access_token: json.access_token,
        refresh_token: json.refresh_token ?? refreshToken,
        expires_at: json.expires_in
            ? new Date(Date.now() + (Number(json.expires_in) - 30) * 1000)
            : null,
        scopes: typeof json.scope === 'string' ? json.scope.split(' ') : undefined,
    };
}

/**
 * Fetch the portal_id + name for the access token. HubSpot exposes this
 * at /oauth/v1/access-tokens/{token} with no extra auth.
 */
export async function fetchAccountInfo(accessToken: string): Promise<{
    externalAccountId: string;
    externalAccountName: string;
}> {
    const res = await fetch(`${HUBSPOT_API_BASE}/oauth/v1/access-tokens/${encodeURIComponent(accessToken)}`);
    const json = await res.json().catch(() => ({})) as any;
    if (!res.ok) {
        throw new Error(`HubSpot account-info lookup failed (status ${res.status})`);
    }
    return {
        externalAccountId: String(json.hub_id ?? ''),
        externalAccountName: json.hub_domain || json.user || `HubSpot portal ${json.hub_id ?? '?'}`,
    };
}

export const HUBSPOT_API = {
    base: HUBSPOT_API_BASE,
};
