/**
 * Shared Google OAuth utilities.
 *
 * Centralizes three things that were previously missing or duplicated across
 * the Postmaster / Sequencer Gmail / user-login flows:
 *
 *   1. revokeGoogleToken — call Google's revocation endpoint on disconnect
 *      so the grant is killed on Google's side, not just locally.
 *   2. verifyGrantedScopes — Google's web-server doc step 6: "users may not
 *      grant your app access to all of them. Your app must verify which
 *      scopes were actually granted." Returns a list of missing required
 *      scopes (empty if all granted).
 *   3. assertHttpsBackendUrlInProd — Google requires HTTPS for non-localhost
 *      redirect URIs. Catch the misconfig at boot, not at OAuth time.
 *   4. verifyIdTokenEmail — extract a verified email from a Google id_token
 *      JWT without an extra HTTP call to userinfo. Validates signature
 *      against Google's published JWKS.
 */

import axios from 'axios';
import { OAuth2Client } from 'google-auth-library';
import { logger } from '../services/observabilityService';

const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

/**
 * Revoke a Google OAuth token (refresh or access). Idempotent — Google
 * returns 200 on success, 400 if already revoked/invalid; we treat both as
 * "the grant is gone" and never throw upward.
 *
 * Important: passing the refresh_token revokes the entire grant (all access
 * tokens for that user × client are immediately invalidated). Passing an
 * access_token revokes only that specific access token.
 */
export async function revokeGoogleToken(token: string): Promise<{ revoked: boolean; status: number | null }> {
    if (!token) return { revoked: false, status: null };
    try {
        const res = await axios.post(REVOKE_URL, new URLSearchParams({ token }).toString(), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            timeout: 10_000,
            validateStatus: () => true,
        });
        if (res.status === 200) return { revoked: true, status: 200 };
        // Google returns 400 with `invalid_token` for already-revoked / unknown
        // tokens. From our perspective the grant is gone, which is what we
        // want — treat as success.
        if (res.status === 400) return { revoked: true, status: 400 };
        logger.warn('[GOOGLE_OAUTH] Revoke returned unexpected status', { status: res.status, body: typeof res.data === 'string' ? res.data.slice(0, 200) : res.data });
        return { revoked: false, status: res.status };
    } catch (err) {
        logger.error(
            '[GOOGLE_OAUTH] Revoke request failed',
            err instanceof Error ? err : new Error(String(err)),
        );
        return { revoked: false, status: null };
    }
}

/**
 * Compare the `scope` string Google returned in the token response against
 * the scopes the app required. Returns the list of missing scopes — empty
 * if all granted. Caller should reject the connection on any miss rather
 * than silently writing a half-broken row to the DB.
 *
 * Google delimits scopes with spaces in the response.
 */
export function verifyGrantedScopes(returnedScope: string | null | undefined, required: string[]): string[] {
    const granted = new Set((returnedScope || '').split(/\s+/).filter(Boolean));
    return required.filter(s => !granted.has(s));
}

/**
 * Verify a Google id_token JWT and return the verified email. Faster and
 * MitM-safer than calling oauth2.userinfo.get over HTTP — id_token is signed
 * by Google and includes the email + verified_email claim directly.
 *
 * Throws if the token is unsigned, expired, or doesn't include a verified
 * email — caller should treat as a hard failure and refuse the connection.
 */
export async function verifyIdTokenEmail(
    idToken: string,
    audienceClientId: string,
): Promise<{ email: string; name?: string; sub: string }> {
    if (!idToken) throw new Error('No id_token to verify');
    const client = new OAuth2Client(audienceClientId);
    const ticket = await client.verifyIdToken({ idToken, audience: audienceClientId });
    const payload = ticket.getPayload();
    if (!payload || !payload.email || payload.email_verified !== true || !payload.sub) {
        throw new Error('id_token did not contain a verified email');
    }
    return {
        email: payload.email.toLowerCase(),
        name: payload.name,
        sub: payload.sub,
    };
}

/**
 * Boot-time guard: in production, BACKEND_URL must use HTTPS. Google's
 * web-server OAuth doc: "Redirect URIs must use the HTTPS scheme, not
 * plain HTTP. Localhost URIs are exempt." Catching this at boot avoids
 * the silent runtime failure where users click Connect and Google
 * rejects the redirect.
 */
export function assertHttpsBackendUrlInProd(): void {
    if (process.env.NODE_ENV !== 'production') return;
    const url = process.env.BACKEND_URL || '';
    if (!url) {
        throw new Error('FATAL: BACKEND_URL is required in production for OAuth redirect URIs');
    }
    if (!url.startsWith('https://')) {
        throw new Error(
            `FATAL: BACKEND_URL must be HTTPS in production (got: ${url}). ` +
            `Google rejects non-HTTPS OAuth redirect URIs for non-localhost hosts.`,
        );
    }
}
