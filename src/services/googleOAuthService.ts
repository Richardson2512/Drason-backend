import { google } from 'googleapis';
import crypto from 'crypto';
import { logger } from '../services/observabilityService';

const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
);

// Store state parameters in memory with TTL
// In production, use Redis for distributed systems
const stateStore = new Map<string, { timestamp: number }>();

// Clean up expired state parameters every 5 minutes
setInterval(() => {
    const now = Date.now();
    const FIVE_MINUTES = 5 * 60 * 1000;

    for (const [state, data] of stateStore.entries()) {
        if (now - data.timestamp > FIVE_MINUTES) {
            stateStore.delete(state);
        }
    }
}, 5 * 60 * 1000);

interface GoogleUserInfo {
    id: string;
    email: string;
    verified_email: boolean;
    name: string;
    given_name: string;
    family_name: string;
    picture: string;
    locale: string;
}

interface GoogleTokens {
    access_token: string;
    refresh_token?: string;
    expiry_date?: number;
    id_token?: string;
}

/**
 * Generate Google OAuth authorization URL with state parameter for CSRF protection
 */
export function generateAuthUrl(): { url: string; state: string } {
    // Generate cryptographically secure random state parameter
    const state = crypto.randomBytes(32).toString('hex');

    // Store state with timestamp for validation
    stateStore.set(state, { timestamp: Date.now() });

    const url = oauth2Client.generateAuthUrl({
        access_type: 'offline', // Get refresh token
        prompt: 'consent',      // Force consent screen to always get refresh token
        scope: [
            'https://www.googleapis.com/auth/userinfo.profile',
            'https://www.googleapis.com/auth/userinfo.email',
            'openid'
        ],
        state
    });

    logger.info('[GoogleOAuth] Generated auth URL', { state });

    return { url, state };
}

/**
 * Validate state parameter to prevent CSRF attacks
 */
export function validateState(state: string): boolean {
    const storedState = stateStore.get(state);

    if (!storedState) {
        logger.warn('[GoogleOAuth] Invalid state parameter', { state });
        return false;
    }

    // Check if state is expired (5 minutes)
    const FIVE_MINUTES = 5 * 60 * 1000;
    const now = Date.now();

    if (now - storedState.timestamp > FIVE_MINUTES) {
        logger.warn('[GoogleOAuth] Expired state parameter', { state });
        stateStore.delete(state);
        return false;
    }

    // State is valid, remove it (one-time use)
    stateStore.delete(state);

    logger.info('[GoogleOAuth] State validated successfully', { state });
    return true;
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
 * Get user profile information from Google
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
            google_id: data.id
        });

        return {
            id: data.id,
            email: data.email,
            verified_email: data.verified_email || false,
            name: data.name || '',
            given_name: data.given_name || '',
            family_name: data.family_name || '',
            picture: data.picture || '',
            locale: data.locale || 'en'
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

        return {
            access_token: credentials.access_token,
            refresh_token: credentials.refresh_token || refreshToken, // Keep old refresh token if new one not provided
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
