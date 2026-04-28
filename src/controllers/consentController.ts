/**
 * Consent Controller
 *
 * Public + authenticated endpoints for consent operations beyond the auth flow:
 *   POST /api/consent/cookies   — anonymous-friendly cookie banner submission
 *   GET  /api/consent/mine      — list of authenticated user's consent records
 *   POST /api/consent/withdraw  — withdraw a revocable consent (cookies, marketing, OAuth, import-key)
 */

import type { Request, Response } from 'express';
import { logger } from '../services/observabilityService';
import {
    recordConsentFromRequest,
    listConsentsForUser,
    withdrawConsent,
    type ConsentType,
} from '../services/consentService';
import { COOKIE_POLICY_VERSION } from '../constants/legalDocVersions';

/**
 * Cookie banner submission — works without authentication so visitors browsing
 * the marketing site can record analytics-cookie preference before signing up.
 * If the user is later authenticated and we have their userId in orgContext,
 * the consent row gets attached to them.
 */
export const recordCookieConsent = async (req: Request, res: Response): Promise<void> => {
    try {
        const { categories, accepted } = (req.body || {}) as {
            categories?: { analytics?: boolean; functional?: boolean };
            accepted?: 'all' | 'reject_all' | 'custom';
        };

        if (!categories || typeof categories !== 'object') {
            res.status(400).json({ success: false, error: 'categories object is required' });
            return;
        }

        const userId = req.orgContext?.userId || null;
        const orgId = req.orgContext?.organizationId || null;

        // We write up to two rows so the audit trail is per-category. Both
        // categories are recorded regardless of accept/reject so we can prove
        // the user explicitly chose the negative as well.
        const writes: Promise<unknown>[] = [];

        writes.push(
            recordConsentFromRequest(req, {
                consentType: 'cookies_analytics',
                documentVersion: COOKIE_POLICY_VERSION,
                channel: 'cookie_banner',
                userId,
                organizationId: orgId,
                metadata: {
                    accepted: !!categories.analytics,
                    bannerChoice: accepted || 'custom',
                },
            }),
        );
        writes.push(
            recordConsentFromRequest(req, {
                consentType: 'cookies_functional',
                documentVersion: COOKIE_POLICY_VERSION,
                channel: 'cookie_banner',
                userId,
                organizationId: orgId,
                metadata: {
                    accepted: !!categories.functional,
                    bannerChoice: accepted || 'custom',
                },
            }),
        );

        await Promise.all(writes);

        res.json({ success: true, version: COOKIE_POLICY_VERSION });
    } catch (err: any) {
        logger.error('[CONSENT] cookie banner record failed', err);
        res.status(500).json({ success: false, error: 'Failed to record cookie consent' });
    }
};

/**
 * GET /api/consent/mine — authenticated user's full consent history (DSAR audit).
 */
export const listMyConsents = async (req: Request, res: Response): Promise<void> => {
    try {
        const userId = req.orgContext?.userId;
        if (!userId) {
            res.status(401).json({ success: false, error: 'Authentication required' });
            return;
        }
        const rows = await listConsentsForUser(userId);
        res.json({ success: true, consents: rows });
    } catch (err: any) {
        logger.error('[CONSENT] listMyConsents failed', err);
        res.status(500).json({ success: false, error: 'Failed to list consents' });
    }
};

/**
 * POST /api/consent/withdraw — withdraw a previously-granted revocable consent.
 * Body: { consentId, reason? }
 *
 * Only revocable types may be withdrawn; ToS / Privacy acceptance is not
 * withdrawable while the user remains a customer (they would need to delete
 * their account instead).
 */
const REVOCABLE_TYPES: ConsentType[] = [
    'marketing',
    'cookies_analytics',
    'cookies_functional',
    'oauth_gmail',
    'oauth_microsoft',
    'oauth_postmaster',
    'import_key',
];

export const withdrawMyConsent = async (req: Request, res: Response): Promise<void> => {
    try {
        const userId = req.orgContext?.userId;
        if (!userId) {
            res.status(401).json({ success: false, error: 'Authentication required' });
            return;
        }
        const { consentId, reason } = (req.body || {}) as { consentId?: string; reason?: string };
        if (!consentId) {
            res.status(400).json({ success: false, error: 'consentId is required' });
            return;
        }

        // Defense in depth: re-list the user's consents and confirm the target
        // is theirs + revocable.
        const rows = await listConsentsForUser(userId);
        const target = rows.find(r => r.id === consentId);
        if (!target) {
            res.status(404).json({ success: false, error: 'Consent record not found' });
            return;
        }
        if (!REVOCABLE_TYPES.includes(target.consent_type as ConsentType)) {
            res.status(400).json({
                success: false,
                error: `Consent type "${target.consent_type}" is not withdrawable. To revoke, delete your account instead.`,
            });
            return;
        }

        const result = await withdrawConsent(consentId, userId, reason || null);
        res.json({ success: result.withdrawn });
    } catch (err: any) {
        logger.error('[CONSENT] withdrawMyConsent failed', err);
        res.status(500).json({ success: false, error: 'Failed to withdraw consent' });
    }
};
