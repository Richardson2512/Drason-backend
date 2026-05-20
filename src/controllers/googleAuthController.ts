import { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { prisma } from '../prisma';
import { logger } from '../services/observabilityService';
import * as googleOAuth from '../services/googleOAuthService';
import { encrypt } from '../utils/encryption';
import { dispatchEmail } from '../services/emailTemplates/dispatcher';
import { welcomeEmail } from '../services/emailTemplates/welcome';
import { internalNewSignupAlert } from '../services/emailTemplates/internalNewSignupAlert';
import { buildFrontendUrl } from '../services/emailTemplates/requesterContext';
import { isFreeEmailDomain } from '../constants/freeEmailDomains';
import { JWT_SECRET } from '../utils/jwtSecret';

const TOKEN_EXPIRY = '3d'; // 3-day token lifetime
const COOKIE_MAX_AGE = 3 * 24 * 60 * 60 * 1000; // 3 days in ms

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
                last_login_at: new Date(),
                // Google already verified this address (OAuth). OAuth signups
                // are verified at creation so they never hit the email-
                // verification gate that password signups must pass.
                email_verified_at: new Date(),
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
 *
 * Three paths in order of precedence:
 *   1. Existing user → update tokens, log in, redirect to /dashboard
 *   2. New user on a Google Workspace account (verified `hd` domain) →
 *      auto-create org from the domain, log in, redirect to /dashboard
 *   3. New user on a non-Workspace Google account (personal Gmail or
 *      personal-Google-on-custom-domain) → REJECT, redirect back to
 *      /signup with a message explaining they need either a Workspace
 *      account OR email/password signup with their work email
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

        // ─── NEW USER: NON-WORKSPACE - REJECT ───────────────────────────
        // Superkabe is B2B. The only Google sign-up path we support for new
        // users is Google Workspace (the branch above auto-creates an org
        // from the verified `hd` domain). A non-Workspace Google account is
        // by definition a personal account (Gmail or a non-Workspace
        // custom-domain), and we don't have a verified company identity to
        // tie an Organization to. Direct them to email/password signup
        // where the work-email gate runs anyway.
        //
        // Existing users with personal Google accounts are NOT affected -
        // they hit the "Existing user found" branch above and log in
        // normally.
        logger.info('[GoogleAuth] Blocking new non-Workspace Google signup', {
            email: googleUser.email,
            isFreeProvider: isFreeEmailDomain(googleUser.email),
        });
        const reason = encodeURIComponent(
            'To sign up with Google you need a Google Workspace account on your company domain. For personal or non-Workspace Google accounts, please use email + password signup with your work email instead.',
        );
        return res.redirect(`${frontendUrl}/signup?error=${reason}`);

    } catch (error: any) {
        logger.error('[GoogleAuth] OAuth callback error', error);
        res.redirect(`${frontendUrl}/signup?error=${encodeURIComponent('Failed to complete Google sign-in')}`);
    }
};

// The `completeOnboarding` endpoint + `PendingRegistration` workflow used
// to support new signups from personal Google accounts (Gmail, etc.). That
// flow was removed when we made Google Workspace the only supported Google
// signup path - personal-Google users now fall through to email/password
// signup with the work-email gate. The route was deleted from auth.ts at
// the same time.
