import { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { prisma } from '../index';
import { logger } from '../services/observabilityService';
import * as googleOAuth from '../services/googleOAuthService';
import { encrypt } from '../utils/encryption';

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
const PENDING_TOKEN_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Set auth token as httpOnly server-side cookie
 */
function setTokenCookie(res: Response, token: string): void {
    res.cookie('token', token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/',
        maxAge: COOKIE_MAX_AGE,
    });
}

/**
 * Set the pending registration token as a lightweight httpOnly cookie.
 * Contains only the opaque token — all sensitive data stays in the database.
 */
function setPendingTokenCookie(res: Response, pendingToken: string): void {
    res.cookie('pending_token', pendingToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/',
        maxAge: PENDING_TOKEN_EXPIRY_MS,
    });
}

/**
 * Clear the pending registration token cookie
 */
function clearPendingTokenCookie(res: Response): void {
    res.cookie('pending_token', '', {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/',
        maxAge: 0,
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
 * Create organization + user in a single atomic transaction.
 * Used by both Workspace auto-org and Gmail onboarding flows.
 */
async function createOrgAndUser(params: {
    orgName: string;
    googleUser: googleOAuth.GoogleUserInfo;
    tokens: { access_token: string; refresh_token?: string; expiry_date?: number };
    selectedPlan?: string;
    tokensAlreadyEncrypted?: boolean; // True when reading from PendingRegistration (already encrypted)
}) {
    const { orgName, googleUser, tokens, selectedPlan, tokensAlreadyEncrypted } = params;

    // Generate unique slug from org name
    const baseSlug = orgName
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');

    let slug = baseSlug;
    let counter = 1;
    while (await prisma.organization.findUnique({ where: { slug } })) {
        slug = `${baseSlug}-${counter}`;
        counter++;
    }

    const trialStartedAt = new Date();
    const trialEndsAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000); // 14 days
    const expiresAt = tokens.expiry_date ? new Date(tokens.expiry_date) : null;
    const clayWebhookSecret = crypto.randomBytes(32).toString('hex');

    // If tokens are already encrypted (from PendingRegistration), use as-is
    const encryptedAccessToken = tokensAlreadyEncrypted ? tokens.access_token : encrypt(tokens.access_token);
    const encryptedRefreshToken = tokens.refresh_token
        ? (tokensAlreadyEncrypted ? tokens.refresh_token : encrypt(tokens.refresh_token))
        : null;

    const result = await prisma.$transaction(async (tx) => {
        const org = await tx.organization.create({
            data: {
                name: orgName,
                slug,
                system_mode: 'enforce',
                subscription_tier: selectedPlan || 'trial',
                subscription_status: 'trialing',
                trial_started_at: trialStartedAt,
                trial_ends_at: trialEndsAt,
                clay_webhook_secret: clayWebhookSecret
            }
        });

        const newUser = await tx.user.create({
            data: {
                email: googleUser.email,
                password_hash: null,
                name: googleUser.name,
                role: 'admin',
                organization_id: org.id,
                google_id: googleUser.id,
                google_access_token: encryptedAccessToken,
                google_refresh_token: encryptedRefreshToken,
                google_token_expires_at: expiresAt,
                avatar_url: googleUser.picture,
                last_login_at: new Date()
            }
        });

        return { org, user: newUser };
    });

    logger.info('[GoogleAuth] Created new user and organization', {
        userId: result.user.id,
        orgId: result.org.id,
        orgName: result.org.name,
        slug: result.org.slug,
        tier: selectedPlan || 'trial'
    });

    return result;
}

/**
 * Clean up expired PendingRegistration records.
 * Called opportunistically during callback to keep the table clean.
 */
async function cleanupExpiredPendingRegistrations(): Promise<void> {
    try {
        const { count } = await prisma.pendingRegistration.deleteMany({
            where: { expires_at: { lt: new Date() } }
        });
        if (count > 0) {
            logger.info('[GoogleAuth] Cleaned up expired pending registrations', { count });
        }
    } catch (error: unknown) {
        // Non-critical — log and continue
        logger.warn('[GoogleAuth] Failed to clean up expired pending registrations', error as Record<string, any>);
    }
}

/**
 * Initiate Google OAuth flow.
 * Accepts optional query params: plan (starter/growth/scale), source (signup/login).
 * Redirects user to Google consent screen.
 */
export const initiateGoogleAuth = async (req: Request, res: Response) => {
    try {
        const plan = req.query.plan as string | undefined;
        const source = req.query.source as string | undefined;

        const { url } = googleOAuth.generateAuthUrl({ plan, source });

        logger.info('[GoogleAuth] Initiating OAuth flow', { plan, source });

        res.redirect(url);
    } catch (error: any) {
        logger.error('[GoogleAuth] Failed to initiate OAuth', error);
        const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
        res.redirect(`${frontendUrl}/login?error=${encodeURIComponent('Failed to initiate Google sign-in')}`);
    }
};

/**
 * Handle Google OAuth callback.
 * Differentiates between Workspace and personal Gmail accounts:
 * - Workspace: Auto-create org from domain name → redirect to dashboard
 * - Gmail: Store auth data in PendingRegistration → redirect to onboarding
 * - Existing user: Update tokens → redirect to dashboard
 */
export const handleGoogleCallback = async (req: Request, res: Response) => {
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';

    try {
        const { code, state, error: oauthError } = req.query;

        // Check if user denied consent
        if (oauthError) {
            logger.warn('[GoogleAuth] User denied consent', { error: oauthError });
            return res.redirect(`${frontendUrl}/signup?error=${encodeURIComponent('Google sign-in was cancelled')}`);
        }

        // Validate required parameters
        if (!code || typeof code !== 'string') {
            logger.warn('[GoogleAuth] Missing authorization code');
            return res.redirect(`${frontendUrl}/signup?error=${encodeURIComponent('Invalid authorization code')}`);
        }

        if (!state || typeof state !== 'string') {
            logger.warn('[GoogleAuth] Missing state parameter');
            return res.redirect(`${frontendUrl}/signup?error=${encodeURIComponent('Invalid state parameter')}`);
        }

        // Validate state to prevent CSRF — now returns metadata
        const stateMetadata = googleOAuth.validateState(state);
        if (!stateMetadata) {
            logger.warn('[GoogleAuth] Invalid or expired state parameter', { state });
            return res.redirect(`${frontendUrl}/signup?error=${encodeURIComponent('Invalid or expired session')}`);
        }

        const selectedPlan = stateMetadata.plan;

        // Exchange authorization code for tokens
        const tokens = await googleOAuth.exchangeCodeForTokens(code);

        // Get user info from Google (now includes `hd` field for Workspace accounts)
        const googleUser = await googleOAuth.getUserInfo(tokens.access_token);

        logger.info('[GoogleAuth] Retrieved Google user info', {
            google_id: googleUser.id,
            email: googleUser.email,
            hd: googleUser.hd || 'personal'
        });

        // ─── EXISTING USER ───────────────────────────────────────────────
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
            // Existing user — update Google OAuth fields and log in
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
                    name: user.name || googleUser.name
                },
                include: { organization: true }
            });

            logger.info('[GoogleAuth] Updated existing user with Google OAuth', { userId: user.id });

            const token = generateToken({
                id: user.id,
                email: user.email,
                role: user.role,
                organization_id: user.organization_id
            });

            setTokenCookie(res, token);
            return res.redirect(`${frontendUrl}/dashboard`);
        }

        // ─── NEW USER: WORKSPACE ACCOUNT ─────────────────────────────────
        if (googleOAuth.isWorkspaceAccount(googleUser.hd)) {
            const orgName = googleOAuth.deriveOrgNameFromDomain(googleUser.hd!);

            logger.info('[GoogleAuth] Workspace account detected — auto-creating org', {
                hd: googleUser.hd,
                derivedOrgName: orgName
            });

            const result = await createOrgAndUser({
                orgName,
                googleUser,
                tokens,
                selectedPlan,
            });

            const token = generateToken({
                id: result.user.id,
                email: result.user.email,
                role: result.user.role,
                organization_id: result.user.organization_id
            });

            setTokenCookie(res, token);
            return res.redirect(`${frontendUrl}/dashboard`);
        }

        // ─── NEW USER: PERSONAL GMAIL ────────────────────────────────────
        logger.info('[GoogleAuth] Personal Gmail detected — redirecting to onboarding', {
            email: googleUser.email
        });

        // Clean up expired pending registrations opportunistically
        await cleanupExpiredPendingRegistrations();

        // Generate a cryptographically secure one-time-use token
        const pendingToken = crypto.randomBytes(48).toString('hex');
        const expiresAt = tokens.expiry_date ? new Date(tokens.expiry_date) : null;

        // Store all sensitive data in the database — nothing in the cookie
        await prisma.pendingRegistration.create({
            data: {
                token: pendingToken,
                google_id: googleUser.id,
                email: googleUser.email,
                name: googleUser.name || null,
                avatar_url: googleUser.picture || null,
                google_access_token: encrypt(tokens.access_token),
                google_refresh_token: tokens.refresh_token ? encrypt(tokens.refresh_token) : null,
                google_token_expires_at: expiresAt,
                selected_plan: selectedPlan || null,
                expires_at: new Date(Date.now() + PENDING_TOKEN_EXPIRY_MS),
            }
        });

        logger.info('[GoogleAuth] Created PendingRegistration', { email: googleUser.email });

        // Set only the opaque token in a lightweight cookie
        setPendingTokenCookie(res, pendingToken);
        return res.redirect(`${frontendUrl}/onboarding`);

    } catch (error: any) {
        logger.error('[GoogleAuth] OAuth callback error', error);
        res.redirect(`${frontendUrl}/signup?error=${encodeURIComponent('Failed to complete Google sign-in')}`);
    }
};

/**
 * Complete the onboarding flow for personal Gmail users.
 * Reads PendingRegistration from DB, creates org + user, sets JWT.
 */
export const completeOnboarding = async (req: Request, res: Response) => {
    try {
        const pendingToken = req.cookies?.pending_token;

        if (!pendingToken || typeof pendingToken !== 'string') {
            logger.warn('[GoogleAuth] Onboarding called without pending token');
            return res.status(401).json({ success: false, error: 'No pending registration found. Please sign up again.' });
        }

        const { organizationName } = req.body;

        if (!organizationName || typeof organizationName !== 'string' || organizationName.trim().length < 2) {
            return res.status(400).json({ success: false, error: 'Organization name is required (minimum 2 characters).' });
        }

        // Find the pending registration
        const pending = await prisma.pendingRegistration.findUnique({
            where: { token: pendingToken }
        });

        if (!pending) {
            logger.warn('[GoogleAuth] Pending registration not found', { token: pendingToken.substring(0, 8) + '...' });
            clearPendingTokenCookie(res);
            return res.status(401).json({ success: false, error: 'Registration expired. Please sign up again.' });
        }

        // Verify not expired
        if (new Date() > pending.expires_at) {
            logger.warn('[GoogleAuth] Pending registration expired', { email: pending.email });
            await prisma.pendingRegistration.delete({ where: { id: pending.id } });
            clearPendingTokenCookie(res);
            return res.status(401).json({ success: false, error: 'Registration expired. Please sign up again.' });
        }

        // Check if user was already created (e.g., double submission)
        const existingUser = await prisma.user.findFirst({
            where: {
                OR: [
                    { google_id: pending.google_id },
                    { email: pending.email }
                ]
            }
        });

        if (existingUser) {
            logger.warn('[GoogleAuth] User already exists during onboarding', { email: pending.email });
            await prisma.pendingRegistration.delete({ where: { id: pending.id } });
            clearPendingTokenCookie(res);
            return res.status(409).json({ success: false, error: 'An account with this email already exists. Please sign in instead.' });
        }

        // Create org + user atomically
        const result = await createOrgAndUser({
            orgName: organizationName.trim(),
            googleUser: {
                id: pending.google_id,
                email: pending.email,
                name: pending.name || '',
                picture: pending.avatar_url || '',
                verified_email: true,
                given_name: '',
                family_name: '',
                locale: 'en',
            },
            tokens: {
                access_token: pending.google_access_token, // Already encrypted in DB
                refresh_token: pending.google_refresh_token || undefined,
                expiry_date: pending.google_token_expires_at?.getTime(),
            },
            selectedPlan: pending.selected_plan || undefined,
            tokensAlreadyEncrypted: true, // Tokens in PendingRegistration are already encrypted
        });

        // Delete the pending registration — one-time use
        await prisma.pendingRegistration.delete({ where: { id: pending.id } });

        // Generate and set the real JWT
        const token = generateToken({
            id: result.user.id,
            email: result.user.email,
            role: result.user.role,
            organization_id: result.user.organization_id
        });

        clearPendingTokenCookie(res);
        setTokenCookie(res, token);

        logger.info('[GoogleAuth] Onboarding completed successfully', {
            userId: result.user.id,
            orgId: result.org.id,
            orgName: result.org.name
        });

        return res.json({ success: true });

    } catch (error: any) {
        logger.error('[GoogleAuth] Onboarding error', error);
        return res.status(500).json({ success: false, error: 'Failed to complete registration. Please try again.' });
    }
};
