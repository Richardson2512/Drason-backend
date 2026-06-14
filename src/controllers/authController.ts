import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { prisma } from '../index';
import { logger } from '../services/observabilityService';
import { recordConsent, extractClientIp, extractUserAgent } from '../services/consentService';
import { TOS_VERSION, PRIVACY_VERSION, TOS_PATH, PRIVACY_PATH } from '../constants/legalDocVersions';
import { dispatchEmail } from '../services/emailTemplates/dispatcher';
import { passwordResetEmail } from '../services/emailTemplates/passwordReset';
import { welcomeEmail } from '../services/emailTemplates/welcome';
import { internalNewSignupAlert } from '../services/emailTemplates/internalNewSignupAlert';
import { accountLockedEmail } from '../services/emailTemplates/accountLocked';
import { passwordChangedEmail } from '../services/emailTemplates/passwordChanged';
import { summariseRequester, buildFrontendUrl } from '../services/emailTemplates/requesterContext';
import { JWT_SECRET, generateToken, setTokenCookie, clearTokenCookie } from '../services/tokenService';
import { uniqueSlug } from '../utils/slug';
import { isFreeEmailDomain, WORK_EMAIL_REQUIRED_MESSAGE } from '../utils/workEmail';
import { verifyEmailTemplate } from '../services/emailTemplates/verifyEmail';

/**
 * POST /api/auth/login/client
 * Body: { workspaceSlug: string, email: string, password: string }
 *
 * Workspace-scoped client login. Resolves the User by:
 *   1. Looking up the Organization by `workspaceSlug` (must exist).
 *   2. Finding a User where `scoped_organization_id = org.id` AND `email`
 *      matches (case-insensitive).
 *   3. Verifying password.
 *
 * Returns a JWT scoped to that workspace. The client cannot switch - the
 * `switch-workspace` endpoint enforces that.
 *
 * Agency owners attempting this endpoint will fail because their User rows
 * have `scoped_organization_id = NULL`. Agency owners use the regular
 * `/api/auth/login` endpoint.
 */
export const clientLogin = async (req: Request, res: Response) => {
    try {
        const { workspaceSlug, email, password } = req.body as {
            workspaceSlug?: unknown; email?: unknown; password?: unknown;
        };
        const slug = typeof workspaceSlug === 'string' ? workspaceSlug.trim().toLowerCase() : '';
        const emailLc = typeof email === 'string' ? email.trim().toLowerCase() : '';
        const pw = typeof password === 'string' ? password : '';

        if (!slug || !emailLc || !pw) {
            return res.status(400).json({ success: false, error: 'workspaceSlug, email, and password are required' });
        }

        const org = await prisma.organization.findUnique({
            where: { slug },
            select: { id: true, slug: true, name: true },
        });
        if (!org) {
            // Same generic error to avoid revealing which slugs exist.
            return res.status(401).json({ success: false, error: 'Invalid workspace, email, or password' });
        }

        // The partial unique on (scoped_organization_id, email) WHERE
        // scoped_organization_id IS NOT NULL guarantees this lookup hits at
        // most one row, so findFirst is safe. Email is stored as the user
        // typed it (no suffix) - see migration 20260506041000.
        const user = await prisma.user.findFirst({
            where: {
                scoped_organization_id: org.id,
                email: emailLc,
            },
            include: { organization: true },
        });
        if (!user || !user.password_hash) {
            return res.status(401).json({ success: false, error: 'Invalid workspace, email, or password' });
        }

        if (user.locked_until && user.locked_until > new Date()) {
            const minutesLeft = Math.ceil((user.locked_until.getTime() - Date.now()) / 60000);
            return res.status(423).json({
                success: false,
                error: `Account temporarily locked. Try again in ${minutesLeft} minute${minutesLeft === 1 ? '' : 's'}.`,
            });
        }

        const ok = await bcrypt.compare(pw, user.password_hash);
        if (!ok) {
            const newCount = (user.failed_login_count || 0) + 1;
            const lockUntil = newCount >= 10 ? new Date(Date.now() + 15 * 60 * 1000) : null;
            await prisma.user.update({
                where: { id: user.id },
                data: { failed_login_count: newCount, locked_until: lockUntil },
            });
            return res.status(401).json({ success: false, error: 'Invalid workspace, email, or password' });
        }

        const token = generateToken(user);
        await prisma.user.update({
            where: { id: user.id },
            data: { last_login_at: new Date(), failed_login_count: 0, locked_until: null },
        });
        // Update WorkspaceMembership last_seen_at as well so the agency can
        // see "last logged in" stats per client.
        await prisma.workspaceMembership.updateMany({
            where: { organization_id: org.id, user_id: user.id },
            data: { last_seen_at: new Date() },
        });

        logger.info('Client logged in', { userId: user.id, email: user.email, workspaceSlug: slug });

        setTokenCookie(res, token);

        res.json({
            token,
            user: {
                id: user.id,
                email: user.email,
                name: user.name,
                role: user.role,
                isClientUser: true,
                organization: {
                    id: org.id,
                    name: org.name,
                    slug: org.slug,
                },
            },
        });
    } catch (error: any) {
        logger.error('Client login error', error);
        res.status(500).json({ success: false, error: 'Login failed' });
    }
};

export const login = async (req: Request, res: Response) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ success: false, error: 'Email and password are required' });
        }

        // Agency-side login. Client logins come through /auth/login/client which
        // also passes a workspace slug, so we restrict this lookup to non-scoped
        // users. The new partial unique on (email) WHERE scoped_organization_id IS NULL
        // makes findFirst safe - at most one row matches.
        const user = await prisma.user.findFirst({
            where: { email, scoped_organization_id: null },
            include: { organization: true }
        });

        if (!user) {
            return res.status(401).json({ success: false, error: 'Invalid credentials' });
        }

        // OAuth-only users don't have a password hash
        if (!user.password_hash) {
            return res.status(401).json({ success: false, error: 'Please sign in with Google' });
        }

        // Check account lockout (10 failed attempts → 15 min lockout)
        if (user.locked_until && user.locked_until > new Date()) {
            const minutesLeft = Math.ceil((user.locked_until.getTime() - Date.now()) / 60000);
            logger.warn('Login attempt on locked account', { email, minutesLeft });
            return res.status(423).json({
                success: false,
                error: `Account temporarily locked. Try again in ${minutesLeft} minute${minutesLeft === 1 ? '' : 's'}.`
            });
        }

        const isValid = await bcrypt.compare(password, user.password_hash);
        if (!isValid) {
            // Increment failed attempt counter
            const newCount = (user.failed_login_count || 0) + 1;
            const lockUntil = newCount >= 10 ? new Date(Date.now() + 15 * 60 * 1000) : null; // Lock for 15 min after 10 failures

            await prisma.user.update({
                where: { id: user.id },
                data: {
                    failed_login_count: newCount,
                    locked_until: lockUntil
                }
            });

            if (lockUntil) {
                logger.warn('Account locked after too many failed attempts', { email, attempts: newCount });
                // Fire-and-forget security notification. Don't await - the
                // login response should not be slowed by an email send.
                void dispatchEmail({
                    rendered: accountLockedEmail({
                        name: user.name,
                        lockedUntil: lockUntil,
                        failedAttempts: newCount,
                        requesterContext: summariseRequester(req),
                        forgotPasswordUrl: buildFrontendUrl('/forgot-password'),
                    }),
                    audience: { kind: 'email', email: user.email },
                    category: 'account_security',
                    eventKind: 'account_locked',
                    // Per-lockout key so re-locking after auto-unlock sends a fresh email.
                    idempotencyKey: `account-locked:${user.id}:${lockUntil.getTime()}`,
                });
                return res.status(423).json({
                    success: false,
                    error: 'Too many failed login attempts. Account locked for 15 minutes.'
                });
            }

            return res.status(401).json({ success: false, error: 'Invalid credentials' });
        }

        // Email-verification gate. Credentials are correct, but an email/password
        // account cannot enter the dashboard until the address is verified. We
        // only signal this AFTER a valid password so we don't leak verification
        // state to wrong-password probes. Existing users were grandfathered to
        // verified by the migration; Google/Workspace users are created verified.
        if (!user.email_verified) {
            logger.info('[AUTH] Login blocked - email not verified', { userId: user.id, email: user.email });
            return res.status(403).json({
                success: false,
                code: 'email_not_verified',
                email: user.email,
                error: 'Please verify your email before signing in. Check your inbox for the verification link.',
            });
        }

        const token = generateToken(user);

        // Reset failed login counter on successful login
        await prisma.user.update({
            where: { id: user.id },
            data: {
                last_login_at: new Date(),
                failed_login_count: 0,
                locked_until: null
            }
        });

        logger.info('User logged in', { userId: user.id, email: user.email });

        // Set httpOnly cookie server-side
        setTokenCookie(res, token);

        res.json({
            token,
            user: {
                id: user.id,
                email: user.email,
                name: user.name,
                role: user.role,
                organization: {
                    id: user.organization.id,
                    name: user.organization.name,
                    slug: user.organization.slug
                }
            }
        });
    } catch (error: any) {
        logger.error('Login error', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
};

export const register = async (req: Request, res: Response) => {
    try {
        const {
            name,
            email,
            password,
            organizationName,
            tier,
            // Legal-doc consent (required) - frontend submits the version
            // strings the user actually saw. We compare against the current
            // server-side versions and reject mismatches so a stale frontend
            // can't sneak through with an old version.
            acceptedTosVersion,
            acceptedPrivacyVersion,
        } = req.body;

        if (!email || !password || !organizationName) {
            return res.status(400).json({ success: false, error: 'Missing required fields' });
        }

        // Required ToS + Privacy consent. We block signup outright if either
        // is missing or stale - under GDPR Art. 7(1) we must demonstrate
        // current-version consent, and we cannot create the account otherwise.
        if (acceptedTosVersion !== TOS_VERSION) {
            return res.status(400).json({
                success: false,
                error: 'You must accept the current Terms of Service to create an account.',
                required_tos_version: TOS_VERSION,
            });
        }
        if (acceptedPrivacyVersion !== PRIVACY_VERSION) {
            return res.status(400).json({
                success: false,
                error: 'You must accept the current Privacy Policy to create an account.',
                required_privacy_version: PRIVACY_VERSION,
            });
        }

        // Work-email only. Reject free/personal/disposable providers - this is
        // the single largest lever against signup spam, and a work email is a
        // far stronger signal of a real prospect. Same rule is enforced on the
        // Google path (personal Gmail is rejected there).
        if (isFreeEmailDomain(email)) {
            return res.status(400).json({ success: false, error: WORK_EMAIL_REQUIRED_MESSAGE });
        }

        // Agency-side signup - collision check only against the agency-side namespace.
        // Client users (scoped_organization_id IS NOT NULL) live in a per-workspace namespace.
        const existingUser = await prisma.user.findFirst({
            where: { email, scoped_organization_id: null },
            select: { id: true },
        });
        if (existingUser) {
            return res.status(400).json({ success: false, error: 'Email already registered' });
        }

        // Two people from the same company are intentionally allowed to each
        // hold a fully independent account under the same company name -
        // e.g. two Scale-tier subscriptions for double the monthly send
        // budget. Each becomes a separate Organization with its own trial,
        // billing, mailboxes, leads, etc. The internal `slug` auto-suffixes
        // on collision (acme, acme-2, acme-3, …); the human-visible `name`
        // stays as the user typed it for both. Scopes to every tier
        // including trial - no gating.
        const slug = await uniqueSlug(organizationName);

        const salt = await bcrypt.genSalt(10);
        const passwordHash = await bcrypt.hash(password, salt);

        // Email-verification token - the raw token goes in the emailed link;
        // we persist only its SHA-256 hash + expiry (same design as reset).
        const rawVerificationToken = crypto.randomBytes(VERIFICATION_TOKEN_BYTES).toString('hex');
        const verificationTokenHash = hashVerificationToken(rawVerificationToken);
        const verificationTokenExpiresAt = new Date(Date.now() + VERIFICATION_TOKEN_TTL_MS);

        // Transaction to create Org + User
        const result = await prisma.$transaction(async (tx) => {
            const trialStartedAt = new Date();
            const trialEndsAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000); // 14 days from now

            // Signup always starts as trial - paid tiers require checkout
            const subscriptionTier = 'trial';

            // Generate Clay webhook secret for HMAC validation
            const crypto = await import('crypto');
            const clayWebhookSecret = crypto.randomBytes(32).toString('hex');

            const org = await tx.organization.create({
                data: {
                    name: organizationName,
                    slug,
                    system_mode: 'enforce', // Default to full protection mode
                    // Initialize 14-day trial with selected tier limits
                    subscription_tier: subscriptionTier,
                    subscription_status: 'trialing',
                    trial_started_at: trialStartedAt,
                    trial_ends_at: trialEndsAt,
                    // Webhook security
                    clay_webhook_secret: clayWebhookSecret
                }
            });

            const user = await tx.user.create({
                data: {
                    email,
                    password_hash: passwordHash,
                    name,
                    role: 'admin', // First user is admin
                    organization_id: org.id,
                    // New email/password signups start unverified - they cannot
                    // log in until they click the emailed verification link.
                    email_verified: false,
                    verification_token_hash: verificationTokenHash,
                    verification_token_expires_at: verificationTokenExpiresAt,
                }
            });

            return { org, user };
        });

        // Record consent grants - two append-only rows, forensically self-contained
        // via identity snapshots so the audit record survives any later User erasure.
        const ipAddress = extractClientIp(req);
        const userAgent = extractUserAgent(req);
        try {
            await Promise.all([
                recordConsent({
                    consentType: 'tos',
                    documentVersion: acceptedTosVersion,
                    channel: 'signup',
                    userId: result.user.id,
                    organizationId: result.org.id,
                    userEmailSnapshot: result.user.email,
                    userNameSnapshot: result.user.name,
                    ipAddress,
                    userAgent,
                    metadata: { documentPath: TOS_PATH },
                }),
                recordConsent({
                    consentType: 'privacy',
                    documentVersion: acceptedPrivacyVersion,
                    channel: 'signup',
                    userId: result.user.id,
                    organizationId: result.org.id,
                    userEmailSnapshot: result.user.email,
                    userNameSnapshot: result.user.name,
                    ipAddress,
                    userAgent,
                    metadata: { documentPath: PRIVACY_PATH },
                }),
            ]);
        } catch (consentErr) {
            // Consent capture is non-fatal for the response (the user is already
            // created in the transaction above), but we MUST log the failure
            // loudly because a missing audit row is a compliance gap.
            logger.error(
                '[REGISTER] Consent recording failed after signup - manual remediation required',
                consentErr instanceof Error ? consentErr : new Error(String(consentErr)),
                { userId: result.user.id, orgId: result.org.id },
            );
        }

        logger.info('User registered (pending email verification)', { userId: result.user.id, email: result.user.email });

        // Verification email - the user is NOT logged in until they click this
        // link. Fire-and-forget so it doesn't block the response; the raw token
        // is only ever present here and in the email, never persisted.
        const verifyUrl = buildVerifyUrl(rawVerificationToken);
        if (process.env.RESEND_API_KEY) {
            void dispatchEmail({
                rendered: verifyEmailTemplate({
                    name: result.user.name,
                    verifyUrl,
                    expiresInHours: VERIFICATION_TOKEN_TTL_MS / (60 * 60 * 1000),
                }),
                audience: { kind: 'email', email: result.user.email },
                category: 'account_security',
                eventKind: 'verify_email',
                idempotencyKey: `verify-email:${result.user.id}:${verificationTokenHash.slice(0, 12)}`,
            });
        } else {
            // Fallback when email delivery is not configured - log the link so a
            // local/dev signup can still be completed. NEVER hit in prod, where
            // RESEND_API_KEY is set.
            logger.warn('[REGISTER] RESEND_API_KEY not set - verification email not sent. Verify link:', { verifyUrl });
        }

        // Internal alert - let the team know about every new signup.
        const internalAlertTo = process.env.INTERNAL_SIGNUP_ALERT_TO || 'richardson@superkabe.com';
        void dispatchEmail({
            rendered: internalNewSignupAlert({
                userEmail: result.user.email,
                userName: result.user.name,
                organizationName: result.org.name,
                signupSource: 'email_password',
                ipAddress: req.ip ?? null,
                userAgent: req.headers['user-agent'] ?? null,
            }),
            audience: { kind: 'email', email: internalAlertTo },
            category: 'system',
            eventKind: 'internal_new_signup',
            idempotencyKey: `internal-signup:${result.user.id}`,
            quiet: true,
        });

        // No auth cookie / token here - the account is created but not active.
        // The frontend shows a "check your email" state; the dashboard opens
        // only after the verification link is used.
        res.status(201).json({
            success: true,
            requiresVerification: true,
            email: result.user.email,
            message: 'Account created. Check your email to verify your address and activate your account.',
        });

    } catch (error: any) {
        logger.error('Registration error', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
};

/**
 * Refresh token - issues a new JWT if the current one is still valid.
 * Called periodically by the frontend to extend the session.
 * Requires a valid (non-expired) JWT in the cookie or Authorization header.
 */
export const refreshToken = async (req: Request, res: Response) => {
    try {
        // Extract token from cookie or header
        let token: string | undefined;

        if (req.cookies?.token) {
            token = req.cookies.token;
        } else {
            const authHeader = req.headers.authorization;
            if (authHeader?.startsWith('Bearer ')) {
                token = authHeader.substring(7);
            }
        }

        if (!token) {
            return res.status(401).json({ success: false, error: 'No token provided' });
        }

        // Verify current token
        let decoded: any;
        try {
            decoded = jwt.verify(token, JWT_SECRET);
        } catch (err: any) {
            if (err.name === 'TokenExpiredError') {
                return res.status(401).json({ success: false, error: 'Token expired. Please log in again.' });
            }
            return res.status(401).json({ success: false, error: 'Invalid token' });
        }

        // Look up user to ensure they still exist and are active
        const user = await prisma.user.findUnique({
            where: { id: decoded.userId },
            include: { organization: true }
        });

        if (!user) {
            return res.status(401).json({ success: false, error: 'User no longer exists' });
        }

        // Reject refresh if token was issued before a password change
        if (user.password_changed_at && decoded.iat) {
            const tokenIssuedAt = new Date(decoded.iat * 1000);
            if (tokenIssuedAt < user.password_changed_at) {
                clearTokenCookie(res);
                return res.status(401).json({ success: false, error: 'Password was changed. Please log in again.' });
            }
        }

        // Issue fresh token
        const newToken = generateToken(user);

        // Set new httpOnly cookie
        setTokenCookie(res, newToken);

        logger.info('Token refreshed', { userId: user.id });

        res.json({
            token: newToken,
            user: {
                id: user.id,
                email: user.email,
                name: user.name,
                role: user.role,
                organization: {
                    id: user.organization.id,
                    name: user.organization.name,
                    slug: user.organization.slug
                }
            }
        });
    } catch (error: any) {
        logger.error('Token refresh error', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
};

/**
 * Logout - clears the auth cookie.
 */
export const logout = async (_req: Request, res: Response) => {
    clearTokenCookie(res);
    res.json({ success: true, data: { message: 'Logged out successfully' } });
};

// ─── Password reset ────────────────────────────────────────────────────────
//
// Flow:
//   1. POST /api/auth/forgot-password { email }
//      → generates a 32-byte random token, stores SHA-256(token) on the user
//        with a 1-hour expiry, emails the raw token in a reset URL.
//      → ALWAYS returns 200 success - anti-enumeration. The response is the
//        same whether or not the email exists in the system.
//   2. GET /api/auth/reset-password/verify?token=...
//      → checks token validity so the reset page can render or show an
//        expired-link error before the user types a new password.
//   3. POST /api/auth/reset-password { token, newPassword }
//      → updates password_hash, bumps password_changed_at (which invalidates
//        any pre-existing JWTs via the orgContext middleware check), clears
//        the reset_token columns. Returns 200 on success.

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;            // 1 hour
const RESET_TOKEN_BYTES = 32;                         // 256 bits - 64 hex chars

function hashResetToken(rawToken: string): string {
    return crypto.createHash('sha256').update(rawToken).digest('hex');
}

function buildResetUrl(rawToken: string): string {
    const base = process.env.FRONTEND_URL || 'http://localhost:3000';
    const url = new URL('/reset-password', base);
    url.searchParams.set('token', rawToken);
    return url.toString();
}

// ─── Email verification ──────────────────────────────────────────────────────
//
// New email/password signups are created unverified with a hashed token. The
// raw token is emailed in a /verify-email link. Verifying flips email_verified,
// clears the token, and logs the user in (sets the JWT cookie). Login is gated
// on email_verified until then. resendVerification re-issues a fresh token.

const VERIFICATION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;   // 24 hours
const VERIFICATION_TOKEN_BYTES = 32;                     // 256 bits - 64 hex chars

function hashVerificationToken(rawToken: string): string {
    return crypto.createHash('sha256').update(rawToken).digest('hex');
}

function buildVerifyUrl(rawToken: string): string {
    const base = process.env.FRONTEND_URL || 'http://localhost:3000';
    const url = new URL('/verify-email', base);
    url.searchParams.set('token', rawToken);
    return url.toString();
}


/**
 * POST /api/auth/forgot-password
 * Body: { email }
 * Always 200 - does not leak whether the email exists.
 */
export const forgotPassword = async (req: Request, res: Response): Promise<void> => {
    try {
        const { email } = req.body as { email: string };
        const emailLower = email.toLowerCase().trim();
        // Agency-side reset only. Client users reset via the workspace-scoped
        // flow (which carries their workspace slug + email).
        const user = await prisma.user.findFirst({
            where: { email: emailLower, scoped_organization_id: null },
            select: { id: true, email: true, name: true, password_hash: true },
        });

        // Anti-enumeration: same response shape regardless of outcome.
        const successResponse = {
            success: true,
            message: 'If an account with that email exists, we have sent a password reset link.',
        };

        if (!user) {
            logger.info('[AUTH] forgot-password for unknown email - returning generic success', { email: emailLower });
            res.json(successResponse);
            return;
        }

        // OAuth-only accounts have no password to reset; behave the same to the caller
        // but skip the email send so we don't suggest a flow that won't work.
        if (!user.password_hash) {
            logger.info('[AUTH] forgot-password for OAuth-only user - skipping email', { userId: user.id });
            res.json(successResponse);
            return;
        }

        const rawToken = crypto.randomBytes(RESET_TOKEN_BYTES).toString('hex');
        const tokenHash = hashResetToken(rawToken);
        const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);

        await prisma.user.update({
            where: { id: user.id },
            data: {
                reset_token_hash: tokenHash,
                reset_token_expires_at: expiresAt,
            },
        });

        const resetUrl = buildResetUrl(rawToken);
        const composed = passwordResetEmail({
            name: user.name,
            resetUrl,
            requesterContext: summariseRequester(req),
            ttlLabel: '1 hour',
        });
        await dispatchEmail({
            rendered: composed,
            audience: { kind: 'email', email: user.email },
            category: 'account_security',
            eventKind: 'password_reset_requested',
            // Token hash uniquely names THIS reset cycle - re-issuing a new
            // token rotates the key and Resend will send the new email.
            idempotencyKey: `pwreset:${user.id}:${tokenHash.slice(0, 16)}`,
        });

        res.json(successResponse);
    } catch (err) {
        logger.error('[AUTH] forgot-password failed', err instanceof Error ? err : new Error(String(err)));
        res.status(500).json({ success: false, error: 'Failed to process request' });
    }
};

/**
 * GET /api/auth/reset-password/verify?token=...
 * Lets the reset page show a sensible error before the user types their new password.
 */
export const verifyResetToken = async (req: Request, res: Response): Promise<void> => {
    try {
        const rawToken = (req.query.token as string | undefined) || '';
        if (!rawToken || rawToken.length < 20) {
            res.json({ valid: false, reason: 'invalid' });
            return;
        }
        const tokenHash = hashResetToken(rawToken);
        const user = await prisma.user.findUnique({
            where: { reset_token_hash: tokenHash },
            select: { email: true, reset_token_expires_at: true },
        });
        if (!user || !user.reset_token_expires_at) {
            res.json({ valid: false, reason: 'invalid' });
            return;
        }
        if (user.reset_token_expires_at < new Date()) {
            res.json({ valid: false, reason: 'expired' });
            return;
        }
        // Mask the email for display (e.g. "j***@example.com") so a stolen
        // link doesn't disclose the full account address.
        const masked = user.email.replace(/^([^@])[^@]*(@.*)$/, (_m, a, c) => `${a}***${c}`);
        res.json({ valid: true, email_masked: masked });
    } catch (err) {
        logger.error('[AUTH] verifyResetToken failed', err instanceof Error ? err : new Error(String(err)));
        res.status(500).json({ success: false, error: 'Failed to verify token' });
    }
};

/**
 * POST /api/auth/reset-password
 * Body: { token, newPassword }
 */
export const resetPassword = async (req: Request, res: Response): Promise<void> => {
    try {
        const { token, newPassword } = req.body as { token: string; newPassword: string };
        const tokenHash = hashResetToken(token);
        const user = await prisma.user.findUnique({
            where: { reset_token_hash: tokenHash },
            select: { id: true, email: true, reset_token_expires_at: true },
        });
        if (!user || !user.reset_token_expires_at) {
            res.status(400).json({ success: false, error: 'Reset link is invalid or has already been used.' });
            return;
        }
        if (user.reset_token_expires_at < new Date()) {
            res.status(400).json({ success: false, error: 'Reset link has expired. Request a new one.' });
            return;
        }

        const newHash = await bcrypt.hash(newPassword, 10);
        const changedAt = new Date();
        await prisma.user.update({
            where: { id: user.id },
            data: {
                password_hash: newHash,
                password_changed_at: changedAt,     // invalidates any pre-existing JWTs
                reset_token_hash: null,             // single-use - burn it
                reset_token_expires_at: null,
                failed_login_count: 0,              // a successful reset clears any lockout
                locked_until: null,
            },
        });

        // If the user happened to be authenticated in another tab, kill that
        // session too so the new password is effectively a clean slate.
        clearTokenCookie(res);

        // Security notification - confirm the change and surface a recovery
        // path if the user wasn't the one who reset it.
        const userRecord = await prisma.user.findUnique({
            where: { id: user.id },
            select: { name: true, email: true },
        });
        if (userRecord) {
            void dispatchEmail({
                rendered: passwordChangedEmail({
                    name: userRecord.name,
                    changedAt,
                    requesterContext: summariseRequester(req),
                    source: 'reset_link',
                    forgotPasswordUrl: buildFrontendUrl('/forgot-password'),
                }),
                audience: { kind: 'email', email: userRecord.email },
                category: 'account_security',
                eventKind: 'password_changed',
                idempotencyKey: `pwchanged:${user.id}:${changedAt.getTime()}`,
            });
        }

        logger.info('[AUTH] Password reset completed', { userId: user.id });
        res.json({ success: true, message: 'Password reset successfully. Please log in with your new password.' });
    } catch (err) {
        logger.error('[AUTH] resetPassword failed', err instanceof Error ? err : new Error(String(err)));
        res.status(500).json({ success: false, error: 'Failed to reset password' });
    }
};

/**
 * POST /api/auth/verify-email
 * Body: { token }
 *
 * Consumes the emailed verification token: flips email_verified, burns the
 * token, logs the user in (sets the JWT cookie), and fires the welcome email.
 */
export const verifyEmail = async (req: Request, res: Response): Promise<void> => {
    try {
        const { token } = req.body as { token: string };
        if (!token || typeof token !== 'string') {
            res.status(400).json({ success: false, error: 'Verification token is required.' });
            return;
        }

        const tokenHash = hashVerificationToken(token);
        const user = await prisma.user.findUnique({
            where: { verification_token_hash: tokenHash },
            include: { organization: true },
        });

        if (!user || !user.verification_token_expires_at) {
            res.status(400).json({ success: false, error: 'Verification link is invalid or has already been used.' });
            return;
        }
        // Already-verified is a no-op success (e.g. a double-clicked link whose
        // token was already burned would 400 above; this covers re-issued links).
        if (user.verification_token_expires_at < new Date()) {
            res.status(400).json({ success: false, code: 'expired', email: user.email, error: 'Verification link has expired. Request a new one.' });
            return;
        }

        await prisma.user.update({
            where: { id: user.id },
            data: {
                email_verified: true,
                verification_token_hash: null,           // single-use - burn it
                verification_token_expires_at: null,
                last_login_at: new Date(),
            },
        });

        // Log the user straight in - they just proved control of the inbox.
        const jwtToken = generateToken(user);
        setTokenCookie(res, jwtToken);

        // Welcome email now that the account is active. Fire-and-forget.
        void dispatchEmail({
            rendered: welcomeEmail({
                name: user.name,
                organizationName: user.organization.name,
                trialDaysRemaining: 14,
                dashboardUrl: buildFrontendUrl('/dashboard'),
            }),
            audience: { kind: 'email', email: user.email },
            category: 'account_security',
            eventKind: 'welcome',
            idempotencyKey: `welcome:${user.id}`,
        });

        logger.info('[AUTH] Email verified', { userId: user.id, email: user.email });
        res.json({
            success: true,
            token: jwtToken,
            user: {
                id: user.id,
                email: user.email,
                name: user.name,
                role: user.role,
                organization: { id: user.organization.id, name: user.organization.name, slug: user.organization.slug },
            },
        });
    } catch (err) {
        logger.error('[AUTH] verifyEmail failed', err instanceof Error ? err : new Error(String(err)));
        res.status(500).json({ success: false, error: 'Failed to verify email' });
    }
};

/**
 * POST /api/auth/resend-verification
 * Body: { email }
 *
 * Re-issues a fresh verification token + email for an unverified agency user.
 * Anti-enumeration: always returns the same generic success.
 */
export const resendVerification = async (req: Request, res: Response): Promise<void> => {
    try {
        const { email } = req.body as { email: string };
        const emailLower = (email || '').toLowerCase().trim();

        const successResponse = {
            success: true,
            message: 'If an unverified account with that email exists, we have sent a new verification link.',
        };

        const user = await prisma.user.findFirst({
            where: { email: emailLower, scoped_organization_id: null },
            select: { id: true, email: true, name: true, email_verified: true },
        });

        // Only re-issue for an existing, still-unverified account. Every other
        // case returns the same response so we don't leak account state.
        if (!user || user.email_verified) {
            res.json(successResponse);
            return;
        }

        const rawToken = crypto.randomBytes(VERIFICATION_TOKEN_BYTES).toString('hex');
        const tokenHash = hashVerificationToken(rawToken);
        const expiresAt = new Date(Date.now() + VERIFICATION_TOKEN_TTL_MS);

        await prisma.user.update({
            where: { id: user.id },
            data: { verification_token_hash: tokenHash, verification_token_expires_at: expiresAt },
        });

        const verifyUrl = buildVerifyUrl(rawToken);
        if (process.env.RESEND_API_KEY) {
            void dispatchEmail({
                rendered: verifyEmailTemplate({
                    name: user.name,
                    verifyUrl,
                    expiresInHours: VERIFICATION_TOKEN_TTL_MS / (60 * 60 * 1000),
                }),
                audience: { kind: 'email', email: user.email },
                category: 'account_security',
                eventKind: 'verify_email',
                idempotencyKey: `verify-email:${user.id}:${tokenHash.slice(0, 12)}`,
            });
        } else {
            logger.warn('[AUTH] RESEND_API_KEY not set - resend verification link:', { verifyUrl });
        }

        logger.info('[AUTH] Verification email re-issued', { userId: user.id });
        res.json(successResponse);
    } catch (err) {
        logger.error('[AUTH] resendVerification failed', err instanceof Error ? err : new Error(String(err)));
        res.status(500).json({ success: false, error: 'Failed to resend verification email' });
    }
};

/**
 * Public endpoint - returns the current legal-doc versions so the signup form
 * can pin them to the submission and the re-acceptance modal can label what
 * the user is accepting. No authentication required.
 */
export const getLegalVersions = async (_req: Request, res: Response): Promise<void> => {
    res.json({
        tos: TOS_VERSION,
        privacy: PRIVACY_VERSION,
        tos_path: TOS_PATH,
        privacy_path: PRIVACY_PATH,
    });
};

/**
 * Resolution endpoint for the re-acceptance modal triggered by the
 * requireFreshConsent middleware. The authenticated user submits the version
 * strings displayed in the modal; we validate they match current and record
 * one or two new Consent rows.
 */
export const acceptCurrentTerms = async (req: Request, res: Response): Promise<void> => {
    try {
        const userId = req.orgContext?.userId;
        if (!userId) {
            res.status(401).json({ success: false, error: 'Authentication required' });
            return;
        }

        const acceptedTos = req.body?.acceptedTosVersion;
        const acceptedPrivacy = req.body?.acceptedPrivacyVersion;

        if (acceptedTos && acceptedTos !== TOS_VERSION) {
            res.status(400).json({
                success: false,
                error: 'Submitted ToS version is stale. Please refresh and accept the current version.',
                required_tos_version: TOS_VERSION,
            });
            return;
        }
        if (acceptedPrivacy && acceptedPrivacy !== PRIVACY_VERSION) {
            res.status(400).json({
                success: false,
                error: 'Submitted Privacy Policy version is stale. Please refresh and accept the current version.',
                required_privacy_version: PRIVACY_VERSION,
            });
            return;
        }

        // Identity snapshot for the consent record.
        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: { email: true, name: true, organization_id: true },
        });
        if (!user) {
            res.status(404).json({ success: false, error: 'User not found' });
            return;
        }

        const ipAddress = extractClientIp(req);
        const userAgent = extractUserAgent(req);
        const recorded: string[] = [];

        if (acceptedTos === TOS_VERSION) {
            await recordConsent({
                consentType: 'tos',
                documentVersion: TOS_VERSION,
                channel: 'reacceptance_modal',
                userId,
                organizationId: user.organization_id,
                userEmailSnapshot: user.email,
                userNameSnapshot: user.name,
                ipAddress,
                userAgent,
                metadata: { documentPath: TOS_PATH },
            });
            recorded.push('tos');
        }
        if (acceptedPrivacy === PRIVACY_VERSION) {
            await recordConsent({
                consentType: 'privacy',
                documentVersion: PRIVACY_VERSION,
                channel: 'reacceptance_modal',
                userId,
                organizationId: user.organization_id,
                userEmailSnapshot: user.email,
                userNameSnapshot: user.name,
                ipAddress,
                userAgent,
                metadata: { documentPath: PRIVACY_PATH },
            });
            recorded.push('privacy');
        }

        if (recorded.length === 0) {
            res.status(400).json({
                success: false,
                error: 'Submit acceptedTosVersion and/or acceptedPrivacyVersion matching the current legal versions.',
            });
            return;
        }

        res.json({ success: true, recorded });
    } catch (err: any) {
        logger.error('[AUTH] acceptCurrentTerms failed', err);
        res.status(500).json({ success: false, error: 'Failed to record acceptance' });
    }
};
