/**
 * Capability enforcement middleware.
 *
 * Phase 3 of the workspaces build: clients invited into a workspace via
 * /agency/workspaces/:id/invites get a per-membership capability list
 * (e.g. ['view_campaigns', 'view_analytics', 'reply_to_messages']). Without
 * this middleware those capabilities exist only as bookkeeping — a client
 * with read-only caps could still call POST /campaigns/:id/launch and the
 * route would happily run.
 *
 * Decision tree on every gated request:
 *   1. Agency owner (User.is_agency_owner = true) → permit. Agency owners
 *      have an implicit '*' on every workspace under their account.
 *   2. Legacy single-tenant user (account_id IS NULL AND scoped_organization_id IS NULL)
 *      → permit. Capability gating is a multi-tenant feature; we don't
 *      retroactively gate routes for legacy users that pre-date the model.
 *   3. Otherwise look up WorkspaceMembership(user, active org). If absent
 *      OR status != 'active' → 403. If capabilities contains '*' or the
 *      required capability → permit. Else → 403.
 *
 * Performance: each gated request adds one DB read (membership). For routes
 * called many times per request this can be cached on req via a parent
 * resolver, but Phase 3 v1 keeps it simple — the existing orgContext
 * middleware already does similar lookups on every authed request.
 */

import { Request, Response, NextFunction } from 'express';
import { prisma } from '../prisma';
import { logger } from '../services/observabilityService';

export const CAPABILITY_KEYS = [
    'view_campaigns',
    'view_analytics',
    'view_leads',
    'view_unibox',
    'reply_to_messages',
    'launch_pause_campaigns',
    'create_campaigns',
    'edit_sequences',
    'add_leads',
    'remove_leads',
    'connect_mailboxes',
    'connect_domains',
    'run_assessment',
    'access_integrations',
] as const;

export type Capability = typeof CAPABILITY_KEYS[number];

/**
 * Build a middleware that requires the named capability on the active workspace.
 *
 * Usage:
 *   router.post('/campaigns/:id/launch', requireCapability('launch_pause_campaigns'), handler);
 */
export function requireCapability(cap: Capability) {
    return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const userId = req.orgContext?.userId;
            const orgId = req.orgContext?.organizationId;
            if (!userId || !orgId) {
                res.status(401).json({ success: false, error: 'Not authenticated' });
                return;
            }

            const user = await prisma.user.findUnique({
                where: { id: userId },
                select: {
                    is_agency_owner: true,
                    scoped_organization_id: true,
                    account_id: true,
                },
            });
            if (!user) {
                res.status(401).json({ success: false, error: 'User not found' });
                return;
            }

            // Fast-path: agency owners have implicit '*' across their account.
            if (user.is_agency_owner) {
                return next();
            }

            // Legacy single-tenant fallback. A user with neither account_id
            // nor scoped_organization_id pre-dates the workspaces feature
            // and was never assigned a membership. Don't retroactively
            // 403 them — they are the seed admin of an unmigrated org.
            if (!user.account_id && !user.scoped_organization_id) {
                return next();
            }

            const membership = await prisma.workspaceMembership.findFirst({
                where: {
                    user_id: userId,
                    organization_id: orgId,
                    status: 'active',
                },
                select: { capabilities: true },
            });
            if (!membership) {
                logger.warn('[CAPABILITY] Denied — no active membership', { userId, orgId, cap });
                res.status(403).json({
                    success: false,
                    error: 'You do not have access to this workspace',
                });
                return;
            }

            if (membership.capabilities.includes('*') || membership.capabilities.includes(cap)) {
                return next();
            }

            logger.warn('[CAPABILITY] Denied — missing capability', { userId, orgId, cap, has: membership.capabilities });
            res.status(403).json({
                success: false,
                error: `You don't have permission to perform this action.`,
                requiredCapability: cap,
            });
        } catch (err: any) {
            logger.error('[CAPABILITY] middleware error', err);
            res.status(500).json({ success: false, error: 'Permission check failed' });
        }
    };
}

/**
 * Restricts a route to agency owners only. Used for operator/admin actions
 * that aren't represented in the capability model (org settings, healing
 * intervention overrides, etc.) — these should never be reachable by a
 * scoped client even with '*' membership.
 *
 * Behavior:
 *   - Agency owners (User.is_agency_owner = true) → permit.
 *   - Legacy single-tenant users (no account_id, no scoped_org) → permit
 *     so we don't break self-serve users on unmigrated orgs.
 *   - Everyone else → 403.
 */
export async function requireAgencyOwner(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
        const userId = req.orgContext?.userId;
        if (!userId) {
            res.status(401).json({ success: false, error: 'Not authenticated' });
            return;
        }
        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: { is_agency_owner: true, account_id: true, scoped_organization_id: true },
        });
        if (!user) {
            res.status(401).json({ success: false, error: 'User not found' });
            return;
        }
        if (user.is_agency_owner) return next();
        if (!user.account_id && !user.scoped_organization_id) return next();
        logger.warn('[CAPABILITY] requireAgencyOwner denied', { userId });
        res.status(403).json({ success: false, error: 'This action is restricted to agency owners.' });
    } catch (err: any) {
        logger.error('[CAPABILITY] requireAgencyOwner error', err);
        res.status(500).json({ success: false, error: 'Permission check failed' });
    }
}

/**
 * Resolve the capabilities the requesting user has on their active workspace.
 * Used by /api/user/me so the frontend can hide write controls the user
 * doesn't have permission to use.
 *
 * Returns ['*'] for agency owners and legacy fallback users (mirroring the
 * fast-path above), the membership's capability list otherwise, or [] if
 * no active membership exists.
 */
export async function resolveCapabilities(userId: string, orgId: string): Promise<string[]> {
    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
            is_agency_owner: true,
            scoped_organization_id: true,
            account_id: true,
        },
    });
    if (!user) return [];
    if (user.is_agency_owner) return ['*'];
    if (!user.account_id && !user.scoped_organization_id) return ['*'];

    const membership = await prisma.workspaceMembership.findFirst({
        where: { user_id: userId, organization_id: orgId, status: 'active' },
        select: { capabilities: true },
    });
    return membership?.capabilities ?? [];
}
