import { google } from 'googleapis';
import { logger } from '../services/observabilityService';
import { createState, consumeState } from './oauthStateService';
import { verifyGrantedScopes } from '../utils/googleOAuth';

const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
);

// Metadata stored alongside the state token. Persisted in the DB-backed
// OAuthState row so it survives restarts and works under horizontal scale.
export interface StateMetadata {
    plan?: string;   // Selected plan from pricing (starter/growth/scale)
    source?: string; // Origin page (signup/login)
}

const USER_LOGIN_REQUIRED_SCOPES = [
    'https://www.googleapis.com/auth/userinfo.email',
];

export interface GoogleUserInfo {
    id: string;
    email: string;
    verified_email: boolean;
    name: string;
    given_name: string;
    family_name: string;
    picture: string;
    locale: string;
    hd?: string; // Hosted domain - present for Google Workspace accounts (e.g., "acmecorp.com")
}

export interface GoogleTokens {
    access_token: string;
    refresh_token?: string;
    expiry_date?: number;
    id_token?: string;
}

/**
 * Generate Google OAuth authorization URL with state parameter for CSRF
 * protection. The state nonce is persisted in the DB-backed OAuthState
 * table - replaces the earlier in-memory Map which was lost on every
 * restart and broken under horizontal scale.
 */
export async function generateAuthUrl(options?: { plan?: string; source?: string }): Promise<{ url: string; state: string }> {
    const state = await createState({
        purpose: 'user_login_oauth',
        organizationId: null, // user-login: no org exists yet
        metadata: { plan: options?.plan, source: options?.source },
    });

    const url = oauth2Client.generateAuthUrl({
        access_type: 'offline', // Get refresh token
        prompt: 'consent',      // Force consent screen to always get refresh token
        scope: [
            'https://www.googleapis.com/auth/userinfo.profile',
            'https://www.googleapis.com/auth/userinfo.email',
            'openid'
        ],
        state,
        include_granted_scopes: true, // future-proof for incremental scope additions
    });

    logger.info('[GoogleOAuth] Generated auth URL', { plan: options?.plan, source: options?.source });

    return { url, state };
}

/**
 * Validate state parameter to prevent CSRF attacks.
 * Returns the stored metadata if valid, or null if invalid/expired.
 *
 * Async because the underlying store is the database - caller must await.
 */
export async function validateState(state: string): Promise<StateMetadata | null> {
    const result = await consumeState(state, 'user_login_oauth');
    if (!result) return null;
    return result.metadata as StateMetadata;
}

/**
 * Exchange authorization code for access and refresh tokens
 */
export async function exchangeCodeForTokens(code: string): Promise<GoogleTokens> {
    try {
        const { tokens } = await oauth2Client.getToken(code);

        if (!tokens.access_token) {
            throw new Error('No access token received from Google');
        }

        // Verify the user granted the email scope at minimum - without it
        // we can't identify them and the login is meaningless. Profile is
        // nice-to-have; email is hard-required.
        const missing = verifyGrantedScopes(tokens.scope, USER_LOGIN_REQUIRED_SCOPES);
        if (missing.length > 0) {
            throw new Error(
                `Google did not grant the required permission to read your email address. ` +
                `Please retry and grant all requested permissions on the consent screen.`,
            );
        }

        logger.info('[GoogleOAuth] Successfully exchanged code for tokens');

        return {
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token || undefined,
            expiry_date: tokens.expiry_date || undefined,
            id_token: tokens.id_token || undefined
        };
    } catch (error: any) {
        logger.error('[GoogleOAuth] Failed to exchange code for tokens', error);
        throw new Error('Failed to exchange authorization code for tokens');
    }
}

/**
 * Get user profile information from Google.
 * Returns the `hd` (hosted domain) field for Workspace accounts.
 */
export async function getUserInfo(accessToken: string): Promise<GoogleUserInfo> {
    try {
        oauth2Client.setCredentials({ access_token: accessToken });

        const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
        const { data } = await oauth2.userinfo.get();

        if (!data.email || !data.id) {
            throw new Error('Incomplete user info received from Google');
        }

        logger.info('[GoogleOAuth] Successfully retrieved user info', {
            email: data.email,
            google_id: data.id,
            hd: data.hd || 'none (personal Gmail)'
        });

        return {
            id: data.id,
            email: data.email,
            verified_email: data.verified_email || false,
            name: data.name || '',
            given_name: data.given_name || '',
            family_name: data.family_name || '',
            picture: data.picture || '',
            locale: data.locale || 'en',
            hd: data.hd || undefined
        };
    } catch (error: any) {
        logger.error('[GoogleOAuth] Failed to get user info', error);
        throw new Error('Failed to retrieve user information from Google');
    }
}

/**
 * Refresh expired access token using refresh token
 */
export async function refreshAccessToken(refreshToken: string): Promise<GoogleTokens> {
    try {
        oauth2Client.setCredentials({ refresh_token: refreshToken });

        const { credentials } = await oauth2Client.refreshAccessToken();

        if (!credentials.access_token) {
            throw new Error('No access token received when refreshing');
        }

        logger.info('[GoogleOAuth] Successfully refreshed access token');

        // Capture rotated refresh token if Google supplied one. Keeping the
        // old token after a rotation strands the connection.
        const rotated = credentials.refresh_token && credentials.refresh_token !== refreshToken;
        if (rotated) {
            logger.info('[GoogleOAuth] Refresh token rotated by Google');
        }
        return {
            access_token: credentials.access_token,
            refresh_token: credentials.refresh_token || refreshToken,
            expiry_date: credentials.expiry_date || undefined
        };
    } catch (error: any) {
        logger.error('[GoogleOAuth] Failed to refresh access token', error);
        throw new Error('Failed to refresh access token');
    }
}

/**
 * Check if access token is expired or will expire soon
 */
export function isTokenExpired(expiryDate: Date | null): boolean {
    if (!expiryDate) {
        return true;
    }

    // Consider token expired if it expires within 5 minutes
    const FIVE_MINUTES = 5 * 60 * 1000;
    const now = Date.now();
    const expiry = new Date(expiryDate).getTime();

    return expiry - now < FIVE_MINUTES;
}

/**
 * Determine if a Google account is a Workspace account or a personal Gmail account.
 * Returns true if the user belongs to a Google Workspace organization.
 */
export function isWorkspaceAccount(hd?: string): boolean {
    if (!hd) return false;
    // gmail.com and googlemail.com are personal accounts, everything else is Workspace
    const personalDomains = ['gmail.com', 'googlemail.com'];
    return !personalDomains.includes(hd.toLowerCase());
}

/**
 * Derive a human-readable organization name from a Workspace domain.
 * e.g., "acmecorp.com" → "Acme Corp", "my-company.io" → "My Company"
 */
export function deriveOrgNameFromDomain(domain: string): string {
    // Strip TLD
    const baseName = domain.split('.')[0];
    // Convert hyphens/underscores to spaces, then title-case
    return baseName
        .replace(/[-_]/g, ' ')
        .replace(/\b\w/g, (char) => char.toUpperCase());
}
