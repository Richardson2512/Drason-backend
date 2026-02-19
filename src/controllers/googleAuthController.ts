import { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { prisma } from '../index';
import { logger } from '../services/observabilityService';
import * as googleOAuth from '../services/googleOAuthService';
import { encrypt, decrypt } from '../utils/encryption';

// JWT_SECRET is validated at startup in index.ts
function getJwtSecret(): string {
    const secret = process.env.JWT_SECRET;
    if (!secret) {
        if (process.env.NODE_ENV === 'production') {
            throw new Error('FATAL: JWT_SECRET is not set in production');
        }
        logger.warn('JWT_SECRET not set — using dev-only fallback. NEVER use this in production.');
        return 'drason_dev_only_secret_DO_NOT_USE_IN_PROD';
    }
    return secret;
}

const JWT_SECRET = getJwtSecret();
const TOKEN_EXPIRY = '3d'; // 3-day token lifetime
const COOKIE_MAX_AGE = 3 * 24 * 60 * 60 * 1000; // 3 days in ms

/**
 * Set auth token as httpOnly server-side cookie
 */
function setTokenCookie(res: Response, token: string): void {
    res.cookie('token', token, {
        httpOnly: true,           // Not accessible via document.cookie — XSS safe
        secure: process.env.NODE_ENV === 'production', // HTTPS only in production
        sameSite: 'lax',          // CSRF protection
        path: '/',
        maxAge: COOKIE_MAX_AGE,
    });
}

/**
 * Generate a JWT for a user
 */
function generateToken(user: { id: string; email: string; role: string; organization_id: string }): string {
    return jwt.sign(
        {
            userId: user.id,
            email: user.email,
            role: user.role,
            orgId: user.organization_id,
        },
        JWT_SECRET,
        { expiresIn: TOKEN_EXPIRY }
    );
}

/**
 * Initiate Google OAuth flow
 * Redirects user to Google consent screen
 */
export const initiateGoogleAuth = async (req: Request, res: Response) => {
    try {
        const { url, state } = googleOAuth.generateAuthUrl();

        logger.info('[GoogleAuth] Initiating OAuth flow', { state });

        // Redirect user to Google consent screen
        res.redirect(url);
    } catch (error: any) {
        logger.error('[GoogleAuth] Failed to initiate OAuth', error);

        // Redirect to login page with error
        const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
        res.redirect(`${frontendUrl}/login?error=${encodeURIComponent('Failed to initiate Google sign-in')}`);
    }
};

/**
 * Handle Google OAuth callback
 * Processes authorization code, creates/updates user, sets session
 */
export const handleGoogleCallback = async (req: Request, res: Response) => {
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';

    try {
        const { code, state, error: oauthError } = req.query;

        // Check if user denied consent
        if (oauthError) {
            logger.warn('[GoogleAuth] User denied consent', { error: oauthError });
            return res.redirect(`${frontendUrl}/login?error=${encodeURIComponent('Google sign-in was cancelled')}`);
        }

        // Validate required parameters
        if (!code || typeof code !== 'string') {
            logger.warn('[GoogleAuth] Missing authorization code');
            return res.redirect(`${frontendUrl}/login?error=${encodeURIComponent('Invalid authorization code')}`);
        }

        if (!state || typeof state !== 'string') {
            logger.warn('[GoogleAuth] Missing state parameter');
            return res.redirect(`${frontendUrl}/login?error=${encodeURIComponent('Invalid state parameter')}`);
        }

        // Validate state to prevent CSRF
        const isValidState = googleOAuth.validateState(state);
        if (!isValidState) {
            logger.warn('[GoogleAuth] Invalid or expired state parameter', { state });
            return res.redirect(`${frontendUrl}/login?error=${encodeURIComponent('Invalid or expired session')}`);
        }

        // Exchange authorization code for tokens
        const tokens = await googleOAuth.exchangeCodeForTokens(code);

        // Get user info from Google
        const googleUser = await googleOAuth.getUserInfo(tokens.access_token);

        logger.info('[GoogleAuth] Retrieved Google user info', {
            google_id: googleUser.id,
            email: googleUser.email
        });

        // Check if user exists by google_id or email
        let user = await prisma.user.findFirst({
            where: {
                OR: [
                    { google_id: googleUser.id },
                    { email: googleUser.email }
                ]
            },
            include: { organization: true }
        });

        if (user) {
            // Existing user - update Google OAuth fields
            logger.info('[GoogleAuth] Existing user found', { userId: user.id });

            const expiresAt = tokens.expiry_date ? new Date(tokens.expiry_date) : null;

            user = await prisma.user.update({
                where: { id: user.id },
                data: {
                    google_id: googleUser.id,
                    google_access_token: encrypt(tokens.access_token),
                    google_refresh_token: tokens.refresh_token ? encrypt(tokens.refresh_token) : user.google_refresh_token,
                    google_token_expires_at: expiresAt,
                    avatar_url: googleUser.picture,
                    last_login_at: new Date(),
                    // Update name if not set
                    name: user.name || googleUser.name
                },
                include: { organization: true }
            });

            logger.info('[GoogleAuth] Updated existing user with Google OAuth', { userId: user.id });
        } else {
            // New user - create user and organization
            logger.info('[GoogleAuth] Creating new user and organization');

            // Generate organization slug from email or name
            const baseSlug = (googleUser.email.split('@')[0] || googleUser.name)
                .toLowerCase()
                .replace(/[^a-z0-9]/g, '-');

            // Ensure unique slug
            let slug = baseSlug;
            let counter = 1;
            while (await prisma.organization.findUnique({ where: { slug } })) {
                slug = `${baseSlug}-${counter}`;
                counter++;
            }

            const trialStartedAt = new Date();
            const trialEndsAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000); // 14 days
            const expiresAt = tokens.expiry_date ? new Date(tokens.expiry_date) : null;

            // Generate Clay webhook secret
            const clayWebhookSecret = crypto.randomBytes(32).toString('hex');

            // Create organization and user in transaction
            const result = await prisma.$transaction(async (tx) => {
                const org = await tx.organization.create({
                    data: {
                        name: googleUser.name || googleUser.email,
                        slug,
                        system_mode: 'enforce',
                        subscription_tier: 'trial',
                        subscription_status: 'trialing',
                        trial_started_at: trialStartedAt,
                        trial_ends_at: trialEndsAt,
                        clay_webhook_secret: clayWebhookSecret
                    }
                });

                const newUser = await tx.user.create({
                    data: {
                        email: googleUser.email,
                        password_hash: null, // OAuth-only user, no password
                        name: googleUser.name,
                        role: 'admin', // First user is admin
                        organization_id: org.id,
                        google_id: googleUser.id,
                        google_access_token: encrypt(tokens.access_token),
                        google_refresh_token: tokens.refresh_token ? encrypt(tokens.refresh_token) : null,
                        google_token_expires_at: expiresAt,
                        avatar_url: googleUser.picture,
                        last_login_at: new Date()
                    }
                });

                return { org, user: newUser };
            });

            user = { ...result.user, organization: result.org };

            logger.info('[GoogleAuth] Created new user and organization', {
                userId: user.id,
                orgId: result.org.id
            });
        }

        // Generate JWT token
        const token = generateToken({
            id: user.id,
            email: user.email,
            role: user.role,
            organization_id: user.organization_id
        });

        // Set httpOnly cookie
        setTokenCookie(res, token);

        logger.info('[GoogleAuth] Google OAuth successful', { userId: user.id });

        // Redirect to dashboard
        res.redirect(`${frontendUrl}/dashboard`);

    } catch (error: any) {
        logger.error('[GoogleAuth] OAuth callback error', error);

        // Redirect to login with error
        res.redirect(`${frontendUrl}/login?error=${encodeURIComponent('Failed to complete Google sign-in')}`);
    }
};
