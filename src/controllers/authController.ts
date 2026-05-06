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
import { accountLockedEmail } from '../services/emailTemplates/accountLocked';
import { passwordChangedEmail } from '../services/emailTemplates/passwordChanged';
import { summariseRequester, buildFrontendUrl } from '../services/emailTemplates/requesterContext';
import { uniqueSlug } from '../utils/slug';

// JWT_SECRET is validated at startup in index.ts — crashes if missing in production.
// In development, a dev-only fallback is used.
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
 * Set auth token as httpOnly server-side cookie + return in body for backward compat.
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
 * Generate a JWT for a user.
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

export const login = async (req: Request, res: Response) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ success: false, error: 'Email and password are required' });
        }

        const user = await prisma.user.findUnique({
            where: { email },
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
                // Fire-and-forget security notification. Don't await — the
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
            // Legal-doc consent (required) — frontend submits the version
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
        // is missing or stale — under GDPR Art. 7(1) we must demonstrate
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

        const existingUser = await prisma.user.findUnique({ where: { email } });
        if (existingUser) {
            return res.status(400).json({ success: false, error: 'Email already registered' });
        }

        // Two people from the same company are intentionally allowed to each
        // hold a fully independent account under the same company name —
        // e.g. two Scale-tier subscriptions for double the monthly send
        // budget. Each becomes a separate Organization with its own trial,
        // billing, mailboxes, leads, etc. The internal `slug` auto-suffixes
        // on collision (acme, acme-2, acme-3, …); the human-visible `name`
        // stays as the user typed it for both. Scopes to every tier
        // including trial — no gating.
        const slug = await uniqueSlug(organizationName);

        const salt = await bcrypt.genSalt(10);
        const passwordHash = await bcrypt.hash(password, salt);

        // Transaction to create Org + User
        const result = await prisma.$transaction(async (tx) => {
            const trialStartedAt = new Date();
            const trialEndsAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000); // 14 days from now

            // Signup always starts as trial — paid tiers require checkout
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
                    organization_id: org.id
                }
            });

            return { org, user };
        });

        // Record consent grants — two append-only rows, forensically self-contained
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
                '[REGISTER] Consent recording failed after signup — manual remediation required',
                consentErr instanceof Error ? consentErr : new Error(String(consentErr)),
                { userId: result.user.id, orgId: result.org.id },
            );
        }

        const token = generateToken({ ...result.user, organization_id: result.org.id });

        logger.info('User registered', { userId: result.user.id, email: result.user.email });

        // Welcome email — fire-and-forget so it doesn't block the response.
        // Idempotency on user.id ensures a retry of the (already-rare) double-
        // submit doesn't double-send.
        void dispatchEmail({
            rendered: welcomeEmail({
                name: result.user.name,
                organizationName: result.org.name,
                trialDaysRemaining: 14,
                dashboardUrl: buildFrontendUrl('/dashboard'),
            }),
            audience: { kind: 'email', email: result.user.email },
            category: 'account_security',
            eventKind: 'welcome',
            idempotencyKey: `welcome:${result.user.id}`,
        });

        // Set httpOnly cookie server-side
        setTokenCookie(res, token);

        res.status(201).json({
            token,
            user: {
                id: result.user.id,
                email: result.user.email,
                name: result.user.name,
                role: result.user.role,
                organization: {
                    id: result.org.id,
                    name: result.org.name,
                    slug: result.org.slug
                }
            }
        });

    } catch (error: any) {
        logger.error('Registration error', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
};

/**
 * Refresh token — issues a new JWT if the current one is still valid.
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
                res.clearCookie('token', { path: '/' });
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
 * Logout — clears the auth cookie.
 */
export const logout = async (_req: Request, res: Response) => {
    res.clearCookie('token', { path: '/' });
    res.json({ success: true, data: { message: 'Logged out successfully' } });
};

// ─── Password reset ────────────────────────────────────────────────────────
//
// Flow:
//   1. POST /api/auth/forgot-password { email }
//      → generates a 32-byte random token, stores SHA-256(token) on the user
//        with a 1-hour expiry, emails the raw token in a reset URL.
//      → ALWAYS returns 200 success — anti-enumeration. The response is the
//        same whether or not the email exists in the system.
//   2. GET /api/auth/reset-password/verify?token=...
//      → checks token validity so the reset page can render or show an
//        expired-link error before the user types a new password.
//   3. POST /api/auth/reset-password { token, newPassword }
//      → updates password_hash, bumps password_changed_at (which invalidates
//        any pre-existing JWTs via the orgContext middleware check), clears
//        the reset_token columns. Returns 200 on success.

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;            // 1 hour
const RESET_TOKEN_BYTES = 32;                         // 256 bits — 64 hex chars

function hashResetToken(rawToken: string): string {
    return crypto.createHash('sha256').update(rawToken).digest('hex');
}

function buildResetUrl(rawToken: string): string {
    const base = process.env.FRONTEND_URL || 'http://localhost:3000';
    const url = new URL('/reset-password', base);
    url.searchParams.set('token', rawToken);
    return url.toString();
}


/**
 * POST /api/auth/forgot-password
 * Body: { email }
 * Always 200 — does not leak whether the email exists.
 */
export const forgotPassword = async (req: Request, res: Response): Promise<void> => {
    try {
        const { email } = req.body as { email: string };
        const emailLower = email.toLowerCase().trim();
        const user = await prisma.user.findUnique({
            where: { email: emailLower },
            select: { id: true, email: true, name: true, password_hash: true },
        });

        // Anti-enumeration: same response shape regardless of outcome.
        const successResponse = {
            success: true,
            message: 'If an account with that email exists, we have sent a password reset link.',
        };

        if (!user) {
            logger.info('[AUTH] forgot-password for unknown email — returning generic success', { email: emailLower });
            res.json(successResponse);
            return;
        }

        // OAuth-only accounts have no password to reset; behave the same to the caller
        // but skip the email send so we don't suggest a flow that won't work.
        if (!user.password_hash) {
            logger.info('[AUTH] forgot-password for OAuth-only user — skipping email', { userId: user.id });
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
            // Token hash uniquely names THIS reset cycle — re-issuing a new
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
                reset_token_hash: null,             // single-use — burn it
                reset_token_expires_at: null,
                failed_login_count: 0,              // a successful reset clears any lockout
                locked_until: null,
            },
        });

        // If the user happened to be authenticated in another tab, kill that
        // session too so the new password is effectively a clean slate.
        res.clearCookie('token', { path: '/' });

        // Security notification — confirm the change and surface a recovery
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
 * Public endpoint — returns the current legal-doc versions so the signup form
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
