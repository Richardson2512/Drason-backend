/**
 * Shared JWT issuance + cookie helpers.
 *
 * Both authController (login / signup / clientLogin) and agencyController
 * (switchWorkspace) need to mint a workspace-aware token. Keeping a single
 * source ensures the payload shape and expiry stay in lockstep - a previous
 * version had switchWorkspace using a 7d expiry while login used 3d, which
 * silently created sessions that outlived the original.
 */

import { Response } from 'express';
import jwt from 'jsonwebtoken';
// JWT secret resolution lives in utils/jwtSecret so every JWT issuer/
// verifier in the backend follows the same throw-in-prod contract.
// Re-exported below for back-compat with existing imports.
import { JWT_SECRET } from '../utils/jwtSecret';

export { JWT_SECRET };
export const TOKEN_EXPIRY = '3d';
export const COOKIE_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;

export interface TokenInput {
    id: string;
    email: string;
    role: string;
    organization_id: string;
    account_id?: string | null;
    is_agency_owner?: boolean;
    scoped_organization_id?: string | null;
}

/** Mint a JWT carrying the agency/workspace context the auth middleware reads. */
export function generateToken(user: TokenInput): string {
    return jwt.sign(
        {
            userId: user.id,
            email: user.email,
            role: user.role,
            orgId: user.organization_id,
            accountId: user.account_id ?? null,
            activeOrganizationId: user.organization_id,
            isAgencyOwner: !!user.is_agency_owner,
            scopedOrganizationId: user.scoped_organization_id ?? null,
        },
        JWT_SECRET,
        { expiresIn: TOKEN_EXPIRY }
    );
}

/**
 * Optional cookie domain - set in subdomain-split mode so the auth cookie
 * is visible to BOTH the marketing host (e.g. superkabe.com) and the app
 * host (app.superkabe.com). When unset (local dev) the cookie stays
 * host-only, which is the safer default. Always start with a leading dot.
 *   prod:  COOKIE_DOMAIN=.superkabe.com
 *   dev:   leave unset
 */
const COOKIE_DOMAIN = process.env.COOKIE_DOMAIN || undefined;

/** Set the httpOnly auth cookie. */
export function setTokenCookie(res: Response, token: string): void {
    res.cookie('token', token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/',
        maxAge: COOKIE_MAX_AGE_MS,
        ...(COOKIE_DOMAIN ? { domain: COOKIE_DOMAIN } : {}),
    });
}

/**
 * Clear the auth cookie. The browser will only clear a cookie when the
 * `domain`, `path`, `secure`, and `sameSite` attributes match the ones
 * used at set-time - so this MUST mirror setTokenCookie.
 */
export function clearTokenCookie(res: Response): void {
    res.clearCookie('token', {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/',
        ...(COOKIE_DOMAIN ? { domain: COOKIE_DOMAIN } : {}),
    });
}
