/**
 * Consent Service
 *
 * Append-only consent audit trail for GDPR Art. 7(1), DPDP § 6, PDPA Consent
 * Obligation, and CCPA right-to-know. Every grant or withdrawal creates a new
 * row; we never delete or update an existing record's consent identity. A
 * withdrawal sets `withdrawn_at` on the original row.
 *
 * Identity snapshot: we store user email + name verbatim at the moment of
 * consent. This means even after a User row is erased (right of erasure under
 * GDPR Art. 17), the consent record remains a valid audit artifact — we can
 * still answer "who agreed to what, when?" without resurrecting deleted PII.
 *
 * Forensics: IP + user-agent are captured from the request. They survive User
 * deletion the same way.
 */

import type { Request } from 'express';
import { prisma } from '../index';
import { logger } from './observabilityService';
import { TOS_VERSION, PRIVACY_VERSION, COOKIE_POLICY_VERSION } from '../constants/legalDocVersions';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type ConsentType =
    | 'tos'
    | 'privacy'
    | 'marketing'
    | 'cookies_analytics'
    | 'cookies_functional'
    | 'oauth_gmail'
    | 'oauth_microsoft'
    | 'oauth_postmaster'
    | 'import_key'
    | 'dpa';

export type ConsentChannel =
    | 'signup'
    | 'reacceptance_modal'
    | 'cookie_banner'
    | 'oauth_callback'
    | 'wizard_step'
    | 'api';

export interface ConsentInput {
    consentType: ConsentType;
    documentVersion: string;
    channel: ConsentChannel;
    userId?: string | null;
    organizationId?: string | null;
    /** Captured at consent time so the record is intelligible after User erasure. */
    userEmailSnapshot?: string | null;
    userNameSnapshot?: string | null;
    ipAddress?: string | null;
    userAgent?: string | null;
    documentHash?: string | null;
    /** OAuth scopes, cookie categories, document URL, etc. */
    metadata?: Record<string, unknown> | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Forensics helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Best-effort client IP extraction. Honors X-Forwarded-For (the first hop) when
 * Express trust-proxy is set; otherwise falls back to req.ip / socket.
 */
export const extractClientIp = (req: Request): string | null => {
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff.length > 0) {
        return xff.split(',')[0]!.trim();
    }
    if (Array.isArray(xff) && xff.length > 0) {
        return xff[0]!.split(',')[0]!.trim();
    }
    return req.ip || req.socket?.remoteAddress || null;
};

export const extractUserAgent = (req: Request): string | null => {
    const ua = req.headers['user-agent'];
    return typeof ua === 'string' ? ua.slice(0, 500) : null;
};

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Record a consent grant. Idempotent only by virtue of being append-only —
 * calling twice creates two rows (which is fine; both are valid evidence the
 * user re-affirmed).
 */
export const recordConsent = async (input: ConsentInput): Promise<{ id: string; acceptedAt: Date }> => {
    const created = await prisma.consent.create({
        data: {
            organization_id: input.organizationId || null,
            user_id: input.userId || null,
            user_email_snapshot: input.userEmailSnapshot || null,
            user_name_snapshot: input.userNameSnapshot || null,
            consent_type: input.consentType,
            document_version: input.documentVersion,
            document_hash: input.documentHash || null,
            channel: input.channel,
            ip_address: input.ipAddress || null,
            user_agent: input.userAgent || null,
            metadata: (input.metadata as object) || undefined,
        },
        select: { id: true, accepted_at: true },
    });

    logger.info('[CONSENT] Recorded', {
        id: created.id,
        userId: input.userId,
        orgId: input.organizationId,
        type: input.consentType,
        version: input.documentVersion,
        channel: input.channel,
    });

    return { id: created.id, acceptedAt: created.accepted_at };
};

/**
 * Convenience wrapper: extract IP+UA from the request automatically.
 */
export const recordConsentFromRequest = async (
    req: Request,
    input: Omit<ConsentInput, 'ipAddress' | 'userAgent'>,
): Promise<{ id: string; acceptedAt: Date }> => {
    return recordConsent({
        ...input,
        ipAddress: extractClientIp(req),
        userAgent: extractUserAgent(req),
    });
};

/**
 * Has this user given valid (non-withdrawn) consent for the given type at the
 * specified document version? Used by `requireFreshConsent` middleware to
 * decide whether a re-acceptance modal needs to fire.
 */
export const hasValidConsent = async (
    userId: string,
    consentType: ConsentType,
    requiredVersion: string,
): Promise<boolean> => {
    const found = await prisma.consent.findFirst({
        where: {
            user_id: userId,
            consent_type: consentType,
            document_version: requiredVersion,
            withdrawn_at: null,
        },
        select: { id: true },
    });
    return !!found;
};

/**
 * Withdraw a previously-granted consent. Does NOT delete the original row —
 * it sets withdrawn_at + reason so the audit trail captures the full lifecycle.
 */
export const withdrawConsent = async (
    consentId: string,
    userId: string,
    reason: string | null = null,
): Promise<{ withdrawn: boolean }> => {
    const existing = await prisma.consent.findUnique({
        where: { id: consentId },
        select: { user_id: true, withdrawn_at: true, consent_type: true },
    });
    if (!existing || existing.user_id !== userId) {
        return { withdrawn: false };
    }
    if (existing.withdrawn_at) {
        return { withdrawn: true }; // already withdrawn, idempotent
    }

    await prisma.consent.update({
        where: { id: consentId },
        data: {
            withdrawn_at: new Date(),
            withdrawn_reason: reason,
        },
    });

    logger.info('[CONSENT] Withdrawn', { id: consentId, userId, type: existing.consent_type });
    return { withdrawn: true };
};

/**
 * List all consent records for a user (for DSAR + customer-facing audit page).
 */
export const listConsentsForUser = async (userId: string) => {
    return prisma.consent.findMany({
        where: { user_id: userId },
        orderBy: { accepted_at: 'desc' },
        select: {
            id: true,
            consent_type: true,
            document_version: true,
            accepted_at: true,
            channel: true,
            ip_address: true,
            user_agent: true,
            withdrawn_at: true,
            withdrawn_reason: true,
            metadata: true,
        },
    });
};

/**
 * Current legal-document versions — exposed for the frontend so signup can
 * submit them verbatim and so the re-acceptance modal can label what's new.
 */
export const getCurrentVersions = () => ({
    tos: TOS_VERSION,
    privacy: PRIVACY_VERSION,
    cookies: COOKIE_POLICY_VERSION,
});

/**
 * Check if a user needs to re-accept ToS or Privacy. Returns the missing
 * consent types so the UI can show specific copy ("you'll need to re-accept
 * the Privacy Policy" vs both).
 */
export const checkPendingTermsConsent = async (
    userId: string,
): Promise<{ tosOk: boolean; privacyOk: boolean }> => {
    const [tosOk, privacyOk] = await Promise.all([
        hasValidConsent(userId, 'tos', TOS_VERSION),
        hasValidConsent(userId, 'privacy', PRIVACY_VERSION),
    ]);
    return { tosOk, privacyOk };
};
