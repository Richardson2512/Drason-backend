import { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { prisma } from '../index';
import { logger } from '../services/observabilityService';
import * as googleOAuth from '../services/googleOAuthService';
import { encrypt } from '../utils/encryption';
import { dispatchEmail } from '../services/emailTemplates/dispatcher';
import { welcomeEmail } from '../services/emailTemplates/welcome';
import { internalNewSignupAlert } from '../services/emailTemplates/internalNewSignupAlert';
import { buildFrontendUrl } from '../services/emailTemplates/requesterContext';
import { JWT_SECRET } from '../utils/jwtSecret';

const TOKEN_EXPIRY = '3d'; // 3-day token lifetime
const COOKIE_MAX_AGE = 3 * 24 * 60 * 60 * 1000; // 3 days in ms
const PENDING_TOKEN_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Cookie domain for subdomain-split mode. See tokenService.ts for the
 * full explanation. Setting this to `.superkabe.com` makes the cookie
 * visible to both `superkabe.com` and `app.superkabe.com`.
 */
const COOKIE_DOMAIN = process.env.COOKIE_DOMAIN || undefined;

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
        ...(COOKIE_DOMAIN ? { domain: COOKIE_DOMAIN } : {}),
    });
}

/**
 * Set the pending registration token as a lightweight httpOnly cookie.
 * Contains only the opaque token - all sensitive data stays in the database.
 */
function setPendingTokenCookie(res: Response, pendingToken: string): void {
    res.cookie('pending_token', pendingToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/',
        maxAge: PENDING_TOKEN_EXPIRY_MS,
        ...(COOKIE_DOMAIN ? { domain: COOKIE_DOMAIN } : {}),
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
        ...(COOKIE_DOMAIN ? { domain: COOKIE_DOMAIN } : {}),
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
                // Google has already verified ownership of this work email, so
                // the user is created verified and skips the email-link step.
                email_verified: true,
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
        // Non-critical - log and continue
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

        const { url } = await googleOAuth.generateAuthUrl({ plan, source });

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
    // FRONTEND_URL = marketing host (superkabe.com) - used for /signup, /login error redirects
    // APP_URL = app subdomain host (app.superkabe.com) - used for /dashboard, /onboarding
    // In single-domain mode just leave APP_URL unset; we fall back to FRONTEND_URL.
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    const appUrl = process.env.APP_URL || frontendUrl;

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

        // Validate state to prevent CSRF - now returns metadata.
        // Async because the underlying store is the database.
        const stateMetadata = await googleOAuth.validateState(state);
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
            // Existing user - update Google OAuth fields and log in
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
            return res.redirect(`${appUrl}/dashboard`);
        }

        // ─── NEW USER: WORKSPACE ACCOUNT ─────────────────────────────────
        if (googleOAuth.isWorkspaceAccount(googleUser.hd)) {
            const orgName = googleOAuth.deriveOrgNameFromDomain(googleUser.hd!);

            logger.info('[GoogleAuth] Workspace account detected - auto-creating org', {
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

            // Internal alert - Google Workspace auto-org path.
            const internalAlertTo = process.env.INTERNAL_SIGNUP_ALERT_TO || 'richardson@superkabe.com';
            void dispatchEmail({
                rendered: internalNewSignupAlert({
                    userEmail: result.user.email,
                    userName: result.user.name,
                    organizationName: result.org.name,
                    signupSource: 'google_workspace',
                    plan: selectedPlan ?? null,
                    ipAddress: req.ip ?? null,
                    userAgent: req.headers['user-agent'] ?? null,
                }),
                audience: { kind: 'email', email: internalAlertTo },
                category: 'system',
                eventKind: 'internal_new_signup',
                idempotencyKey: `internal-signup:${result.user.id}`,
                quiet: true,
            });

            return res.redirect(`${appUrl}/dashboard`);
        }

        // ─── NEW USER: PERSONAL GMAIL → REJECTED ─────────────────────────
        // Work-email only. Personal Gmail (and any non-Workspace Google
        // account) cannot create an account. We send them back to signup with
        // a clear message instead of the old org-name onboarding step, which
        // has been removed entirely.
        logger.info('[GoogleAuth] Personal Gmail rejected - work email required', {
            email: googleUser.email,
        });
        return res.redirect(
            `${frontendUrl}/signup?error=${encodeURIComponent('Please sign up with your work email. Personal Google accounts (gmail.com) are not supported.')}`
        );

    } catch (error: any) {
        logger.error('[GoogleAuth] OAuth callback error', error);
        res.redirect(`${frontendUrl}/signup?error=${encodeURIComponent('Failed to complete Google sign-in')}`);
    }
};

// NOTE: The personal-Gmail onboarding flow (completeOnboarding + the org-name
// collection step) was removed when signup became work-email-only. Personal
// Google accounts are now rejected in handleGoogleCallback before any
// PendingRegistration is created.
