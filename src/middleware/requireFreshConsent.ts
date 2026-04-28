/**
 * Require Fresh Consent Middleware
 *
 * Blocks authenticated requests when the user has not accepted the current
 * Terms of Service or Privacy Policy version. Returns HTTP 412 (Precondition
 * Failed) with a structured payload the frontend uses to render a blocking
 * re-acceptance modal.
 *
 * Required for GDPR Art. 7(3): "the data subject shall have the right to
 * withdraw his or her consent at any time" — which we honor by treating each
 * version bump as a fresh consent ask, never inferring acceptance of a new
 * version from acceptance of an old one.
 *
 * Skip-paths cover routes the modal needs to call to resolve itself (the
 * accept-terms endpoint, logout, version probe), plus health/auth endpoints
 * that pre-date authentication.
 */

import type { Request, Response, NextFunction } from 'express';
import { logger } from '../services/observabilityService';
import { checkPendingTermsConsent, getCurrentVersions } from '../services/consentService';

// Paths the modal itself depends on. These must NOT be blocked or the
// frontend can't resolve the 412 state.
const SKIP_PATH_PREFIXES = [
    '/auth/login',
    '/auth/register',
    '/auth/refresh',
    '/auth/logout',
    '/auth/legal-versions',
    '/auth/accept-current-terms',  // the resolution endpoint itself
    '/auth/google',
    '/auth/onboarding',
    '/health',
    '/billing/polar-webhook',
    '/ingest/clay',
    '/sequencer/accounts/google/callback',
    '/sequencer/accounts/microsoft/callback',
    '/oauth/callback/postmaster',
    '/consent/cookies',
    // GET /user/me is allowed pre-acceptance so the dashboard shell can render
    // before the modal fires; everything else is gated.
];

export const requireFreshConsent = (req: Request, res: Response, next: NextFunction): void => {
    (async () => {
        try {
            // Bypass for skip-paths
            if (SKIP_PATH_PREFIXES.some(p => req.path.startsWith(p))) return next();

            // GET /user/me is the one allowed authenticated read pre-acceptance.
            if (req.path === '/user/me' && req.method === 'GET') return next();

            // No userId → no enforcement (extractOrgContext upstream handles auth).
            // Dev fallback / API-key flows have no userId; we only enforce against
            // human users with JWT identity.
            const userId = req.orgContext?.userId;
            if (!userId) return next();

            const { tosOk, privacyOk } = await checkPendingTermsConsent(userId);
            if (tosOk && privacyOk) return next();

            const versions = getCurrentVersions();
            const missing: string[] = [];
            if (!tosOk) missing.push('tos');
            if (!privacyOk) missing.push('privacy');

            res.status(412).json({
                error: 'Consent required',
                message: 'Our Terms or Privacy Policy has been updated. Please review and accept to continue.',
                requires_consent_update: true,
                missing,
                current_versions: { tos: versions.tos, privacy: versions.privacy },
            });
        } catch (err) {
            logger.error(
                '[CONSENT-GATE] check failed',
                err instanceof Error ? err : new Error(String(err)),
            );
            // Fail-open on infra errors: better to admit a request than lock
            // out every user if Postgres hiccups. The endpoint will still
            // record consent on next successful submission.
            next();
        }
    })();
};
