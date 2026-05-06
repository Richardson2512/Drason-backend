/**
 * Agency Controller — read endpoints for the workspaces feature.
 *
 * Phase 1 scope: read-only. The endpoints in this file populate the
 * frontend's fleet-overview, sidebar workspace switcher, and workspace
 * detail page with real data, replacing the localStorage mock.
 *
 * Authorization model:
 *   - Agency owner (User.is_agency_owner = true): can see every Organization
 *     under their Account.
 *   - Client user (User.scoped_organization_id != null): can only see their
 *     one scoped workspace.
 *   - Default solo user (no account_id, no agency): sees their own org only.
 *     Backfills via the data migration produced an Account for these too,
 *     so the agency-owner path covers them.
 *
 * Mutations (create / rename / delete / invite) land in Phase 2.
 */

import { Request, Response } from 'express';
import { prisma } from '../index';
import { logger } from '../services/observabilityService';
import { generateToken, setTokenCookie } from '../services/tokenService';

interface AgencyAccessContext {
    accountId: string | null;
    userId: string;
    /** The org the user is currently authenticated against (from JWT). */
    jwtOrgId: string | null;
    isAgencyOwner: boolean;
    scopedOrganizationId: string | null;
}

/**
 * Resolve which Account/scope the requesting user has access to. Returns
 * null if the user can't be loaded — caller responds with 401.
 */
async function resolveAgencyContext(req: Request): Promise<AgencyAccessContext | null> {
    const userId = req.orgContext?.userId;
    if (!userId) return null;
    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
            id: true,
            account_id: true,
            is_agency_owner: true,
            scoped_organization_id: true,
        },
    });
    if (!user) return null;
    return {
        accountId: user.account_id,
        userId: user.id,
        jwtOrgId: req.orgContext?.organizationId ?? null,
        isAgencyOwner: user.is_agency_owner,
        scopedOrganizationId: user.scoped_organization_id,
    };
}

/**
 * Canonical access check for "can this caller act on this organization?".
 *
 * Three regimes:
 *   1. Hard-locked client (scoped_organization_id != NULL):
 *      access only their one scoped org.
 *   2. Account-bound user (account_id != NULL):
 *      access any org under the same Account.
 *   3. Legacy unmigrated user (both NULL):
 *      access only the org their JWT was issued for. We never grant access
 *      to other NULL-account orgs — that was the cross-tenant hole the
 *      audit caught.
 *
 * Returns true on success, false on denied / not-found.
 */
async function checkOrgAccess(ctx: AgencyAccessContext, orgId: string): Promise<boolean> {
    const org = await prisma.organization.findUnique({
        where: { id: orgId },
        select: { account_id: true },
    });
    if (!org) return false;

    if (ctx.scopedOrganizationId) {
        return ctx.scopedOrganizationId === orgId;
    }
    if (ctx.accountId) {
        return org.account_id === ctx.accountId;
    }
    // Legacy fallback: only their JWT-bound org.
    return !!(ctx.jwtOrgId && ctx.jwtOrgId === orgId);
}

interface WorkspaceCard {
    id: string;
    name: string;
    slug: string;
    clientCompany: string | null;
    isSeed: boolean;
    health: 'healthy' | 'warning' | 'paused';
    mailboxCount: number;
    activeCampaigns: number;
    sends30d: number;
    bounceRate: number;
    replyRate: number;
    clientLoginCount: number;
    createdAt: string;
}

const SINCE_30D_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Compute a workspace card's denormalized stats for fleet/list display.
 * Each call hits the DB ~5x — fine for v1, batch via Promise.all when the
 * fleet grows past ~20 workspaces.
 */
async function buildWorkspaceCard(orgId: string): Promise<WorkspaceCard | null> {
    const since = new Date(Date.now() - SINCE_30D_MS);

    const org = await prisma.organization.findUnique({
        where: { id: orgId },
        select: {
            id: true,
            name: true,
            slug: true,
            client_company_name: true,
            is_seed: true,
            created_at: true,
        },
    });
    if (!org) return null;

    const [mailboxes, activeCampaigns, sends30d, bounces30d, clientLoginCount] = await Promise.all([
        prisma.mailbox.findMany({
            where: { organization_id: orgId },
            select: { status: true },
        }),
        prisma.campaign.count({
            where: { organization_id: orgId, status: 'active' },
        }),
        prisma.sendEvent.count({
            where: { organization_id: orgId, sent_at: { gte: since } },
        }),
        prisma.bounceEvent.count({
            where: { organization_id: orgId, bounced_at: { gte: since } },
        }),
        // Count actual CLIENT memberships only — exclude the agency owner's
        // auto-granted '*' membership. Clients get explicit capability lists,
        // never the wildcard.
        prisma.workspaceMembership.count({
            where: {
                organization_id: orgId,
                NOT: { capabilities: { has: '*' } },
            },
        }),
    ]);

    // Health derivation: if any mailbox is paused → paused.
    // Otherwise if any is in warning/quarantine/cooling → warning.
    // Otherwise healthy.
    let health: WorkspaceCard['health'] = 'healthy';
    if (mailboxes.some((m) => m.status === 'paused')) {
        health = 'paused';
    } else if (mailboxes.some((m) => m.status === 'warning' || m.status === 'quarantine')) {
        health = 'warning';
    }

    return {
        id: org.id,
        name: org.name,
        slug: org.slug,
        clientCompany: org.client_company_name,
        isSeed: org.is_seed,
        health,
        mailboxCount: mailboxes.length,
        activeCampaigns,
        sends30d,
        bounceRate: sends30d > 0 ? bounces30d / sends30d : 0,
        // ReplyEvent is computed elsewhere; default to 0 for now to keep this
        // endpoint cheap. Phase 3 polish: actual rolling reply rate.
        replyRate: 0,
        clientLoginCount,
        createdAt: org.created_at.toISOString(),
    };
}

/**
 * GET /api/agency/workspaces
 * List workspaces visible to the requesting user.
 */
export const listWorkspaces = async (req: Request, res: Response): Promise<void> => {
    try {
        const ctx = await resolveAgencyContext(req);
        if (!ctx) {
            res.status(401).json({ success: false, error: 'Not authenticated' });
            return;
        }

        // Determine which Org IDs the user can see.
        let orgIds: string[] = [];
        if (ctx.scopedOrganizationId) {
            // Hard-locked client user — single workspace only.
            orgIds = [ctx.scopedOrganizationId];
        } else if (ctx.accountId) {
            const orgs = await prisma.organization.findMany({
                where: { account_id: ctx.accountId },
                select: { id: true },
                orderBy: { created_at: 'asc' },
            });
            orgIds = orgs.map((o) => o.id);
        } else {
            // No account_id (legacy user not yet migrated). Fall back to the
            // user's organization_id from JWT context.
            const fallbackOrgId = req.orgContext?.organizationId;
            if (fallbackOrgId) orgIds = [fallbackOrgId];
        }

        const cards = await Promise.all(orgIds.map((id) => buildWorkspaceCard(id)));
        const workspaces = cards.filter((c): c is WorkspaceCard => c !== null);

        res.json({ success: true, data: workspaces });
    } catch (e: any) {
        logger.error('[AGENCY] listWorkspaces failed', e);
        res.status(500).json({ success: false, error: 'Failed to load workspaces' });
    }
};

/**
 * GET /api/agency/workspaces/:id
 * Single workspace detail. Returns 404 if not in the user's account.
 */
export const getWorkspace = async (req: Request, res: Response): Promise<void> => {
    try {
        const ctx = await resolveAgencyContext(req);
        if (!ctx) {
            res.status(401).json({ success: false, error: 'Not authenticated' });
            return;
        }
        const id = String(req.params.id);

        const access = await checkOrgAccess(ctx, id);
        if (!access) {
            res.status(404).json({ success: false, error: 'Workspace not found' });
            return;
        }

        const card = await buildWorkspaceCard(id);
        if (!card) {
            res.status(404).json({ success: false, error: 'Workspace not found' });
            return;
        }

        res.json({ success: true, data: card });
    } catch (e: any) {
        logger.error('[AGENCY] getWorkspace failed', e);
        res.status(500).json({ success: false, error: 'Failed to load workspace' });
    }
};

/**
 * Generate a URL-safe workspace slug from a free-text name. Adds a numeric
 * suffix (-2, -3, …) until globally unique. Slug uniqueness is global at
 * the DB level (Organization.slug @unique), so we must check globally — a
 * per-account check would happily return a candidate that the create() then
 * 500s on. Falls back to a UUID-derived slug if collision count exceeds 50
 * (defensive — should never trigger).
 */
async function uniqueSlug(name: string): Promise<string> {
    const base = name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60) || 'workspace';

    for (let i = 0; i < 50; i++) {
        const candidate = i === 0 ? base : `${base}-${i + 1}`;
        const existing = await prisma.organization.findFirst({
            where: { slug: candidate },
            select: { id: true },
        });
        if (!existing) return candidate;
    }
    // Defensive fallback — append a base36 timestamp to guarantee uniqueness.
    return `${base}-${Date.now().toString(36)}`;
}

/**
 * POST /api/agency/switch-workspace
 * Body: { workspaceId: string }
 *
 * Re-issue the requesting user's JWT with `orgId` / `activeOrganizationId`
 * pointing at the requested workspace. Updates the httpOnly cookie. After
 * this returns 200, the frontend should invalidate its DashboardContext
 * cache and re-fetch — every subsequent API call now scopes to the new org.
 *
 * Authorization:
 *   - Agency owner: target org must belong to their Account.
 *   - Client (scoped_organization_id != null): can only switch to their
 *     scoped org. Any other target → 403.
 */
export const switchWorkspace = async (req: Request, res: Response): Promise<void> => {
    try {
        const ctx = await resolveAgencyContext(req);
        if (!ctx) {
            res.status(401).json({ success: false, error: 'Not authenticated' });
            return;
        }
        const { workspaceId } = req.body as { workspaceId?: unknown };
        const targetId = typeof workspaceId === 'string' ? workspaceId : '';
        if (!targetId) {
            res.status(400).json({ success: false, error: 'workspaceId is required' });
            return;
        }

        const access = await checkOrgAccess(ctx, targetId);
        if (!access) {
            // Use 403 over 404 here because the user is authenticated and
            // possibly clicked a stale workspace link — the actionable error
            // is "you don't have access", not "doesn't exist".
            res.status(403).json({ success: false, error: 'You do not have access to that workspace' });
            return;
        }

        const targetOrg = await prisma.organization.findUnique({
            where: { id: targetId },
            select: { id: true, name: true, slug: true },
        });
        if (!targetOrg) {
            // Race: passed access check, then deleted. Treat as not-found.
            res.status(404).json({ success: false, error: 'Workspace not found' });
            return;
        }

        // Re-issue the JWT AND persist organization_id on the User row in the
        // same transaction. The JWT is what middleware reads on every request,
        // but any service that does `user.organization_id` lookups would
        // otherwise see the stale value. Keep them in sync.
        const updatedUser = await prisma.user.update({
            where: { id: ctx.userId },
            data: { organization_id: targetOrg.id },
            select: { id: true, email: true, role: true },
        });

        const newToken = generateToken({
            id: updatedUser.id,
            email: updatedUser.email,
            role: updatedUser.role,
            organization_id: targetOrg.id,
            account_id: ctx.accountId,
            is_agency_owner: ctx.isAgencyOwner,
            scoped_organization_id: ctx.scopedOrganizationId,
        });
        setTokenCookie(res, newToken);

        logger.info(`[AGENCY] User ${updatedUser.email} switched to workspace ${targetOrg.slug}`);

        res.json({
            success: true,
            data: {
                token: newToken,
                workspace: {
                    id: targetOrg.id,
                    name: targetOrg.name,
                    slug: targetOrg.slug,
                },
            },
        });
    } catch (e: any) {
        logger.error('[AGENCY] switchWorkspace failed', e);
        res.status(500).json({ success: false, error: 'Failed to switch workspace' });
    }
};

/**
 * POST /api/agency/workspaces
 * Body: { name: string, clientCompany?: string, slug?: string }
 *
 * Creates a new Organization (=workspace) under the requesting agency
 * owner's Account. Only agency owners can call this — clients are blocked.
 *
 * The new workspace inherits the Account's primary org's `subscription_tier`
 * for downstream limit checks (carries over from the seed Org).
 */
export const createWorkspace = async (req: Request, res: Response): Promise<void> => {
    try {
        const ctx = await resolveAgencyContext(req);
        if (!ctx) {
            res.status(401).json({ success: false, error: 'Not authenticated' });
            return;
        }
        if (!ctx.isAgencyOwner) {
            res.status(403).json({ success: false, error: 'Only agency owners can create workspaces' });
            return;
        }
        if (!ctx.accountId) {
            res.status(400).json({ success: false, error: 'No agency account configured' });
            return;
        }

        const body = req.body as { name?: unknown; clientCompany?: unknown; slug?: unknown };
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        const clientCompany = typeof body.clientCompany === 'string' ? body.clientCompany.trim() : '';
        const slugInput = typeof body.slug === 'string' ? body.slug.trim() : '';

        if (!name) {
            res.status(400).json({ success: false, error: 'Workspace name is required' });
            return;
        }
        if (name.length > 100) {
            res.status(400).json({ success: false, error: 'Workspace name too long (max 100 chars)' });
            return;
        }

        // Inherit subscription_tier from the seed Org of this Account so
        // downstream tier checks still resolve correctly.
        const seed = await prisma.organization.findFirst({
            where: { account_id: ctx.accountId, is_seed: true },
            select: { subscription_tier: true, system_mode: true, mailing_address: true },
        });

        const slug = slugInput
            ? await uniqueSlug(slugInput)
            : await uniqueSlug(name);

        const created = await prisma.organization.create({
            data: {
                name,
                slug,
                account_id: ctx.accountId,
                is_seed: false,
                client_company_name: clientCompany || null,
                subscription_tier: seed?.subscription_tier ?? 'trial',
                system_mode: seed?.system_mode ?? 'observe',
                mailing_address: seed?.mailing_address ?? null,
                assessment_completed: true, // new workspaces start clean — no assessment gate
            },
            select: {
                id: true, name: true, slug: true, client_company_name: true,
                is_seed: true, created_at: true,
            },
        });

        // Auto-grant the agency owner full membership in the new workspace.
        await prisma.workspaceMembership.create({
            data: {
                organization_id: created.id,
                user_id: ctx.userId,
                capabilities: ['*'],
                status: 'active',
            },
        });

        const card = await buildWorkspaceCard(created.id);
        res.status(201).json({ success: true, data: card });
    } catch (e: any) {
        logger.error('[AGENCY] createWorkspace failed', e);
        res.status(500).json({ success: false, error: 'Failed to create workspace' });
    }
};

/**
 * PATCH /api/agency/workspaces/:id
 * Body: { name?: string, clientCompany?: string, slug?: string }
 *
 * Rename / re-brand a workspace. Slug edits go through the same uniqueness
 * check as creation. Agency-owner only.
 */
export const updateWorkspace = async (req: Request, res: Response): Promise<void> => {
    try {
        const ctx = await resolveAgencyContext(req);
        if (!ctx) {
            res.status(401).json({ success: false, error: 'Not authenticated' });
            return;
        }
        if (!ctx.isAgencyOwner) {
            res.status(403).json({ success: false, error: 'Only agency owners can update workspaces' });
            return;
        }
        const id = String(req.params.id);
        const access = await checkOrgAccess(ctx, id);
        if (!access) {
            res.status(404).json({ success: false, error: 'Workspace not found' });
            return;
        }
        const target = await prisma.organization.findUnique({
            where: { id },
            select: { slug: true },
        });
        if (!target) {
            res.status(404).json({ success: false, error: 'Workspace not found' });
            return;
        }

        const body = req.body as { name?: unknown; clientCompany?: unknown; slug?: unknown };
        const data: { name?: string; client_company_name?: string | null; slug?: string } = {};

        if (typeof body.name === 'string') {
            const trimmed = body.name.trim();
            if (!trimmed) {
                res.status(400).json({ success: false, error: 'Workspace name cannot be empty' });
                return;
            }
            if (trimmed.length > 100) {
                res.status(400).json({ success: false, error: 'Workspace name too long' });
                return;
            }
            data.name = trimmed;
        }
        if (typeof body.clientCompany === 'string') {
            data.client_company_name = body.clientCompany.trim() || null;
        }
        if (typeof body.slug === 'string') {
            const newSlug = body.slug.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
            if (!newSlug) {
                res.status(400).json({ success: false, error: 'Slug cannot be empty' });
                return;
            }
            if (newSlug !== target.slug) {
                const conflict = await prisma.organization.findFirst({
                    where: { slug: newSlug, NOT: { id } },
                    select: { id: true },
                });
                if (conflict) {
                    res.status(409).json({ success: false, error: 'That slug is already in use' });
                    return;
                }
                data.slug = newSlug;
            }
        }

        if (Object.keys(data).length === 0) {
            res.status(400).json({ success: false, error: 'No changes provided' });
            return;
        }

        await prisma.organization.update({ where: { id }, data });
        const card = await buildWorkspaceCard(id);
        res.json({ success: true, data: card });
    } catch (e: any) {
        logger.error('[AGENCY] updateWorkspace failed', e);
        res.status(500).json({ success: false, error: 'Failed to update workspace' });
    }
};

/**
 * DELETE /api/agency/workspaces/:id
 *
 * Permanently delete a workspace and cascade all child resources via the
 * existing FK ON DELETE CASCADE rules (mailboxes, campaigns, leads, etc.).
 * Agency-owner only. Seed workspace cannot be deleted.
 */
export const deleteWorkspace = async (req: Request, res: Response): Promise<void> => {
    try {
        const ctx = await resolveAgencyContext(req);
        if (!ctx) {
            res.status(401).json({ success: false, error: 'Not authenticated' });
            return;
        }
        if (!ctx.isAgencyOwner) {
            res.status(403).json({ success: false, error: 'Only agency owners can delete workspaces' });
            return;
        }
        const id = String(req.params.id);
        const access = await checkOrgAccess(ctx, id);
        if (!access) {
            res.status(404).json({ success: false, error: 'Workspace not found' });
            return;
        }
        const target = await prisma.organization.findUnique({
            where: { id },
            select: { is_seed: true, name: true },
        });
        if (!target) {
            res.status(404).json({ success: false, error: 'Workspace not found' });
            return;
        }
        if (target.is_seed) {
            res.status(400).json({ success: false, error: "The seed workspace can't be deleted" });
            return;
        }

        await prisma.organization.delete({ where: { id } });
        logger.info(`[AGENCY] Workspace deleted: ${target.name} (${id}) by ${ctx.userId}`);
        res.json({ success: true, data: { id, deleted: true } });
    } catch (e: any) {
        logger.error('[AGENCY] deleteWorkspace failed', e);
        res.status(500).json({ success: false, error: 'Failed to delete workspace' });
    }
};

/**
 * GET /api/agency/fleet-stats
 * Aggregate stats across all visible workspaces. Used by the fleet-overview
 * stat-card row at the top of /dashboard/agency.
 */
export const getFleetStats = async (req: Request, res: Response): Promise<void> => {
    try {
        const ctx = await resolveAgencyContext(req);
        if (!ctx) {
            res.status(401).json({ success: false, error: 'Not authenticated' });
            return;
        }

        let orgIds: string[] = [];
        if (ctx.scopedOrganizationId) {
            orgIds = [ctx.scopedOrganizationId];
        } else if (ctx.accountId) {
            const orgs = await prisma.organization.findMany({
                where: { account_id: ctx.accountId },
                select: { id: true },
            });
            orgIds = orgs.map((o) => o.id);
        } else if (req.orgContext?.organizationId) {
            orgIds = [req.orgContext.organizationId];
        }

        if (orgIds.length === 0) {
            res.json({
                success: true,
                data: {
                    workspaceCount: 0,
                    healthyCount: 0,
                    warningCount: 0,
                    pausedCount: 0,
                    totalMailboxes: 0,
                    totalSends30d: 0,
                    weightedBounceRate: 0,
                    weightedReplyRate: 0,
                },
            });
            return;
        }

        const cards = (await Promise.all(orgIds.map((id) => buildWorkspaceCard(id))))
            .filter((c): c is WorkspaceCard => c !== null);

        const totalSends = cards.reduce((s, c) => s + c.sends30d, 0);
        const totalMailboxes = cards.reduce((s, c) => s + c.mailboxCount, 0);
        const weightedBounceRate = totalSends > 0
            ? cards.reduce((s, c) => s + c.bounceRate * c.sends30d, 0) / totalSends
            : 0;
        const weightedReplyRate = totalSends > 0
            ? cards.reduce((s, c) => s + c.replyRate * c.sends30d, 0) / totalSends
            : 0;

        res.json({
            success: true,
            data: {
                workspaceCount: cards.length,
                healthyCount: cards.filter((c) => c.health === 'healthy').length,
                warningCount: cards.filter((c) => c.health === 'warning').length,
                pausedCount: cards.filter((c) => c.health === 'paused').length,
                totalMailboxes,
                totalSends30d: totalSends,
                weightedBounceRate,
                weightedReplyRate,
            },
        });
    } catch (e: any) {
        logger.error('[AGENCY] getFleetStats failed', e);
        res.status(500).json({ success: false, error: 'Failed to load fleet stats' });
    }
};
