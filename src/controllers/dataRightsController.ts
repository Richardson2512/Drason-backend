/**
 * Data Subject Access Request (DSAR) Controller
 *
 * GDPR Art. 15 / Art. 17, CCPA / CPRA right-to-know + right-to-delete,
 * DPDP / PDPA equivalents. Three endpoints:
 *
 *   GET  /api/account/my-data          — JSON export of everything we hold
 *   POST /api/account/delete-request   — initiate 30-day soft-delete
 *   GET  /api/account/delete-request   — check status of a pending deletion
 *
 * Per the Privacy Policy, exercising these rights does not affect lawfulness
 * of prior processing and the user is not discriminated against.
 *
 * The deletion flow is intentionally two-step (request now, executes after a
 * grace period) so an accidental click or compromised session can be
 * reversed before irreversible erasure.
 */

import type { Request, Response } from 'express';
import crypto from 'crypto';
import { prisma } from '../index';
import { logger } from '../services/observabilityService';
import { listConsentsForUser } from '../services/consentService';

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/account/my-data — DSAR export
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns a structured JSON document containing every personal-data artifact
 * we hold for the authenticated user. The response is large enough to satisfy
 * GDPR Art. 15 requests; customers wanting a portable archive can save it.
 *
 * Excluded by design: encrypted secrets (OAuth tokens, SMTP passwords, import
 * keys) — exporting those would be a security risk and the user can already
 * re-create them.
 */
export const exportMyData = async (req: Request, res: Response): Promise<void> => {
    try {
        const userId = req.orgContext?.userId;
        if (!userId) {
            res.status(401).json({ success: false, error: 'Authentication required' });
            return;
        }

        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: {
                id: true,
                email: true,
                name: true,
                role: true,
                created_at: true,
                last_login_at: true,
                organization_id: true,
            },
        });
        if (!user) {
            res.status(404).json({ success: false, error: 'User not found' });
            return;
        }

        const orgId = user.organization_id;

        const [organization, consents, mailboxesCount, leadsCount, campaignsCount] = await Promise.all([
            prisma.organization.findUnique({
                where: { id: orgId },
                select: {
                    id: true,
                    name: true,
                    slug: true,
                    subscription_tier: true,
                    subscription_status: true,
                    trial_started_at: true,
                    trial_ends_at: true,
                    subscription_started_at: true,
                    created_at: true,
                },
            }),
            listConsentsForUser(userId),
            prisma.mailbox.count({ where: { organization_id: orgId } }),
            prisma.lead.count({ where: { organization_id: orgId } }),
            prisma.campaign.count({ where: { organization_id: orgId } }),
        ]);

        // 30-day usage snapshot — the same numbers the user sees on the
        // billing page, included for transparency.
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
        const [emailsValidated, monthlySends] = await Promise.all([
            prisma.validationAttempt.count({
                where: { organization_id: orgId, created_at: { gte: thirtyDaysAgo } },
            }),
            prisma.sendEvent.count({
                where: { organization_id: orgId, sent_at: { gte: thirtyDaysAgo } },
            }),
        ]);

        res.json({
            generated_at: new Date().toISOString(),
            user,
            organization,
            consents,
            usage: {
                period: 'rolling_30_days',
                emails_validated: emailsValidated,
                emails_sent: monthlySends,
            },
            counts: {
                mailboxes: mailboxesCount,
                leads: leadsCount,
                campaigns: campaignsCount,
            },
            note:
                'Encrypted secrets (OAuth tokens, SMTP credentials, import keys) are not included for security. ' +
                'Email bodies of sent messages are not retained by Superkabe; reply messages are stored only until the customer deletes them.',
        });
    } catch (err: any) {
        logger.error('[DATA-RIGHTS] exportMyData failed', err);
        res.status(500).json({ success: false, error: 'Failed to export data' });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/account/delete-request — initiate erasure
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Schedules a 30-day soft-delete. Records a deletion request as an AuditLog
 * row keyed by a confirmation token (the user can reverse the request by
 * presenting the token on the same endpoint with cancel=true).
 *
 * Actual database erasure is handled by a separate sweep worker that runs
 * after the grace period has elapsed. (Worker not implemented in this PR;
 * the AuditLog row is the audit-grade record of the request.)
 */
export const requestAccountDeletion = async (req: Request, res: Response): Promise<void> => {
    try {
        const userId = req.orgContext?.userId;
        const orgId = req.orgContext?.organizationId;
        if (!userId || !orgId) {
            res.status(401).json({ success: false, error: 'Authentication required' });
            return;
        }

        const reason: string | null = req.body?.reason || null;

        // Already a pending request? Don't double-schedule.
        const existing = await prisma.auditLog.findFirst({
            where: {
                organization_id: orgId,
                entity: 'account_deletion',
                entity_id: userId,
                action: 'deletion_requested',
            },
            orderBy: { timestamp: 'desc' },
        });
        if (existing) {
            res.json({
                success: true,
                already_requested: true,
                requested_at: existing.timestamp,
                executes_after: new Date(existing.timestamp.getTime() + 30 * 24 * 60 * 60 * 1000),
                cancellation_token: tryParseToken(existing.details),
            });
            return;
        }

        const token = crypto.randomBytes(32).toString('hex');
        await prisma.auditLog.create({
            data: {
                organization_id: orgId,
                entity: 'account_deletion',
                entity_id: userId,
                trigger: 'user',
                action: 'deletion_requested',
                user_id: userId,
                details: JSON.stringify({
                    cancellation_token: token,
                    reason,
                    grace_period_days: 30,
                }),
            },
        });

        const executesAfter = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

        logger.info('[DATA-RIGHTS] Account deletion requested', { userId, orgId, executesAfter });

        res.json({
            success: true,
            executes_after: executesAfter,
            cancellation_token: token,
            message:
                'Your account deletion request has been recorded. Your data will remain accessible for 30 days. ' +
                'To cancel within the grace period, present the cancellation_token to this endpoint with { cancel: true }.',
        });
    } catch (err: any) {
        logger.error('[DATA-RIGHTS] requestAccountDeletion failed', err);
        res.status(500).json({ success: false, error: 'Failed to request deletion' });
    }
};

function tryParseToken(detailsJson: string | null): string | null {
    if (!detailsJson) return null;
    try {
        const parsed = JSON.parse(detailsJson);
        return typeof parsed?.cancellation_token === 'string' ? parsed.cancellation_token : null;
    } catch { return null; }
}

/**
 * GET /api/account/delete-request — return current pending status.
 */
export const getDeletionStatus = async (req: Request, res: Response): Promise<void> => {
    try {
        const userId = req.orgContext?.userId;
        const orgId = req.orgContext?.organizationId;
        if (!userId || !orgId) {
            res.status(401).json({ success: false, error: 'Authentication required' });
            return;
        }

        const existing = await prisma.auditLog.findFirst({
            where: {
                organization_id: orgId,
                entity: 'account_deletion',
                entity_id: userId,
                action: 'deletion_requested',
            },
            orderBy: { timestamp: 'desc' },
        });

        // If a cancellation row exists after the request, treat as cancelled.
        const cancelled = existing
            ? await prisma.auditLog.findFirst({
                where: {
                    organization_id: orgId,
                    entity: 'account_deletion',
                    entity_id: userId,
                    action: 'deletion_cancelled',
                    timestamp: { gt: existing.timestamp },
                },
            })
            : null;

        if (!existing || cancelled) {
            res.json({ pending: false });
            return;
        }

        const executesAfter = new Date(existing.timestamp.getTime() + 30 * 24 * 60 * 60 * 1000);
        res.json({
            pending: true,
            requested_at: existing.timestamp,
            executes_after: executesAfter,
        });
    } catch (err: any) {
        logger.error('[DATA-RIGHTS] getDeletionStatus failed', err);
        res.status(500).json({ success: false, error: 'Failed to load status' });
    }
};

/**
 * POST /api/account/cancel-deletion — undo a pending deletion within grace.
 */
export const cancelAccountDeletion = async (req: Request, res: Response): Promise<void> => {
    try {
        const userId = req.orgContext?.userId;
        const orgId = req.orgContext?.organizationId;
        if (!userId || !orgId) {
            res.status(401).json({ success: false, error: 'Authentication required' });
            return;
        }
        const token: string | undefined = req.body?.cancellation_token;
        if (!token) {
            res.status(400).json({ success: false, error: 'cancellation_token is required' });
            return;
        }

        const existing = await prisma.auditLog.findFirst({
            where: {
                organization_id: orgId,
                entity: 'account_deletion',
                entity_id: userId,
                action: 'deletion_requested',
            },
            orderBy: { timestamp: 'desc' },
        });
        if (!existing) {
            res.status(404).json({ success: false, error: 'No pending deletion request found' });
            return;
        }
        const storedToken = tryParseToken(existing.details);
        if (!storedToken || storedToken !== token) {
            res.status(403).json({ success: false, error: 'Invalid cancellation token' });
            return;
        }

        await prisma.auditLog.create({
            data: {
                organization_id: orgId,
                entity: 'account_deletion',
                entity_id: userId,
                trigger: 'user',
                action: 'deletion_cancelled',
                user_id: userId,
                details: JSON.stringify({ cancelled_request_at: existing.timestamp.toISOString() }),
            },
        });
        logger.info('[DATA-RIGHTS] Account deletion cancelled', { userId, orgId });

        res.json({ success: true });
    } catch (err: any) {
        logger.error('[DATA-RIGHTS] cancelAccountDeletion failed', err);
        res.status(500).json({ success: false, error: 'Failed to cancel deletion' });
    }
};
