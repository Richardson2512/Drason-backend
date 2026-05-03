/**
 * Outreach.io OAuth 2.0 service.
 *
 * Pure functions — no DB. State CSRF protection via signed JWT.
 * Outreach uses Authorization Code flow with refresh tokens (rotated on refresh).
 *
 * Required env vars:
 *   OUTREACH_CLIENT_ID
 *   OUTREACH_CLIENT_SECRET
 *   OUTREACH_REDIRECT_URI       — e.g. https://api.superkabe.com/api/integrations/outreach/callback
 *   JWT_SECRET                  — reused for state signing
 *
 * Docs: https://api.outreach.io/api/v2/docs#authentication
 */

import jwt from 'jsonwebtoken';
import { logger } from '../observabilityService';
import type { OutreachOAuthTokens } from './types';

const OUTREACH_AUTH_BASE = 'https://api.outreach.io/oauth/authorize';
const OUTREACH_TOKEN_URL = 'https://api.outreach.io/oauth/token';
export const OUTREACH_API_BASE = 'https://api.outreach.io/api/v2';

// Scopes for v1: read sequences/mailboxes for the picker, create
// prospects + sequences, add prospects to sequences. profile.read for /me.
export const OUTREACH_DEFAULT_SCOPES = [
    'profile.read',
    'prospects.read',
    'prospects.write',
    'sequences.read',
    'sequences.write',
    'sequenceStates.write',
    'mailboxes.read',
    'tags.read',
] as const;

const STATE_TTL_SEC = 10 * 60;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

interface StatePayload {
    organizationId: string;
    userId: string;
    redirectAfterConnect?: string;
    source?: string;
}

export function envGuard(): { ok: true } | { ok: false; reason: string } {
    if (!process.env.OUTREACH_CLIENT_ID) return { ok: false, reason: 'OUTREACH_CLIENT_ID is not set' };
    if (!process.env.OUTREACH_CLIENT_SECRET) return { ok: false, reason: 'OUTREACH_CLIENT_SECRET is not set' };
    if (!process.env.OUTREACH_REDIRECT_URI) return { ok: false, reason: 'OUTREACH_REDIRECT_URI is not set' };
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
        client_id: process.env.OUTREACH_CLIENT_ID!,
        redirect_uri: process.env.OUTREACH_REDIRECT_URI!,
        response_type: 'code',
        scope: (opts.scopes ?? OUTREACH_DEFAULT_SCOPES).join(' '),
        state: opts.state,
    });
    return `${OUTREACH_AUTH_BASE}?${params.toString()}`;
}

function tokensFromResponse(json: any): OutreachOAuthTokens {
    if (!json?.access_token) {
        throw new Error('Outreach token response missing access_token');
    }
    if (!json?.refresh_token) {
        throw new Error('Outreach token response missing refresh_token');
    }
    const expiresIn = Number(json.expires_in ?? 7200);
    return {
        access_token: json.access_token,
        refresh_token: json.refresh_token,
        expires_at: new Date(Date.now() + (expiresIn - 30) * 1000), // 30s safety margin
        scopes: typeof json.scope === 'string' ? json.scope.split(' ') : undefined,
    };
}

export async function exchangeCodeForTokens(code: string): Promise<OutreachOAuthTokens> {
    const body = new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: process.env.OUTREACH_CLIENT_ID!,
        client_secret: process.env.OUTREACH_CLIENT_SECRET!,
        redirect_uri: process.env.OUTREACH_REDIRECT_URI!,
        code,
    });

    const res = await fetch(OUTREACH_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
    });

    const json = await res.json().catch(() => ({})) as any;
    if (!res.ok) {
        const detail = String(json?.error_description || json?.error || 'unknown').slice(0, 200);
        logger.warn('[OUTREACH_OAUTH] token exchange failed', { status: res.status, detail });
        throw new Error(`Outreach token exchange failed: ${detail}`);
    }
    return tokensFromResponse(json);
}

export async function refreshAccessToken(refreshToken: string): Promise<OutreachOAuthTokens> {
    const body = new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: process.env.OUTREACH_CLIENT_ID!,
        client_secret: process.env.OUTREACH_CLIENT_SECRET!,
        refresh_token: refreshToken,
    });

    const res = await fetch(OUTREACH_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
    });

    const json = await res.json().catch(() => ({})) as any;
    if (!res.ok) {
        const detail = String(json?.error_description || json?.error || 'unknown').slice(0, 200);
        throw new Error(`Outreach refresh failed: ${detail}`);
    }
    // Outreach rotates refresh tokens on every refresh — always take the new one.
    return tokensFromResponse(json);
}
