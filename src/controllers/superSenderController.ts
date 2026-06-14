/**
 * Super Sender controller - REST surface for the dedicated-IP feature.
 *
 *   GET    /api/super-sender                 - list IPs in this account + summary
 *   POST   /api/super-sender/checkout        - create Polar checkout (qty + workspaces)
 *   POST   /api/super-sender/:id/assign      - assign a pool IP to a workspace
 *   POST   /api/super-sender/:id/unassign    - return an IP to the pool
 *
 * Tier and capability gates:
 *   - All endpoints require auth (extractOrgContext).
 *   - Mutating endpoints require the agency owner. Non-owner users in the
 *     account see the page but can't buy or reassign.
 */

import { Request, Response } from 'express';
import { prisma } from '../index';
import { logger } from '../services/observabilityService';
import { getOrgId } from '../middleware/orgContext';
import {
    createSuperSenderCheckout,
    assignIpToWorkspace,
    unassignIp,
    pauseIp,
    resumeIp,
    listAccountIps,
    accountHasAnyIp,
    workspacesWithIp,
    canPurchaseSuperSender,
    AllocationError,
    SUPER_SENDER_PRICE_USD,
    REASSIGN_COOLDOWN_HOURS,
} from '../services/superSenderService';
import { isMailboxSesEligible } from '../services/superSenderRouting';

async function resolveAccountContext(orgId: string): Promise<{
    accountId: string;
    isAgencyOwner: boolean;
    agencyModeEnabled: boolean;
} | null> {
    const org = await prisma.organization.findUnique({
        where: { id: orgId },
        select: {
            account_id: true,
            account: { select: { id: true, agency_mode_enabled: true, owner_user_id: true } },
        },
    });
    if (!org?.account || !org.account_id) return null;
    return {
        accountId: org.account_id,
        // Owner check is read at the user layer where the request lives.
        // This boolean is set in the controller below from req.user.id.
        isAgencyOwner: false,
        agencyModeEnabled: org.account.agency_mode_enabled,
    };
}

async function isAgencyOwner(req: Request, accountId: string): Promise<boolean> {
    const userId = req.orgContext?.userId;
    if (!userId) return false;
    const account = await prisma.account.findUnique({
        where: { id: accountId },
        select: { owner_user_id: true },
    });
    return Boolean(account && account.owner_user_id === userId);
}

// ────────────────────────────────────────────────────────────────────
// GET /api/super-sender
// Returns: {
//   summary: { has_any_ip, agency_mode, can_purchase, price_per_ip_usd, reassign_cooldown_hours },
//   ips: DedicatedIpView[],
//   workspaces: { id, name, slug, has_ip }[],   // for the picker modal
// }
// ────────────────────────────────────────────────────────────────────

export const getSuperSenderOverview = async (req: Request, res: Response): Promise<Response> => {
    const orgId = getOrgId(req);
    const ctx = await resolveAccountContext(orgId);
    if (!ctx) {
        // No agency Account context - single-org user. Synthesize a
        // single-workspace view using their Organization as both the
        // "account" and the only "workspace".
        const eligibility = await canPurchaseSuperSender(orgId);
        const org = await prisma.organization.findUnique({
            where: { id: orgId },
            select: { id: true, name: true, slug: true },
        });
        return res.json({
            success: true,
            data: {
                summary: {
                    has_any_ip: false,
                    agency_mode: false,
                    can_purchase: eligibility.ok,
                    purchase_blocked_reason: eligibility.ok ? null : eligibility.reason,
                    price_per_ip_usd: SUPER_SENDER_PRICE_USD,
                    reassign_cooldown_hours: REASSIGN_COOLDOWN_HOURS,
                },
                ips: [],
                workspaces: org ? [{ id: org.id, name: org.name, slug: org.slug, has_ip: false }] : [],
            },
        });
    }

    const [ips, allWorkspaces, allocatedSet, eligibility, hasAny] = await Promise.all([
        listAccountIps(ctx.accountId),
        prisma.organization.findMany({
            where: { account_id: ctx.accountId },
            select: { id: true, name: true, slug: true },
            orderBy: { created_at: 'asc' },
        }),
        workspacesWithIp(ctx.accountId),
        canPurchaseSuperSender(orgId),
        accountHasAnyIp(ctx.accountId),
    ]);

    const allocated = new Set(allocatedSet);
    const workspaces = allWorkspaces.map(w => ({
        id: w.id,
        name: w.name,
        slug: w.slug,
        has_ip: allocated.has(w.id),
    }));

    return res.json({
        success: true,
        data: {
            summary: {
                has_any_ip: hasAny,
                agency_mode: ctx.agencyModeEnabled,
                can_purchase: eligibility.ok,
                purchase_blocked_reason: eligibility.ok ? null : eligibility.reason,
                price_per_ip_usd: SUPER_SENDER_PRICE_USD,
                reassign_cooldown_hours: REASSIGN_COOLDOWN_HOURS,
            },
            ips,
            workspaces,
        },
    });
};

// ────────────────────────────────────────────────────────────────────
// POST /api/super-sender/checkout
// Body: { quantity: number, workspace_ids?: string[] }
// ────────────────────────────────────────────────────────────────────

export const createCheckout = async (req: Request, res: Response): Promise<Response> => {
    const orgId = getOrgId(req);
    const ctx = await resolveAccountContext(orgId);
    if (ctx && !(await isAgencyOwner(req, ctx.accountId))) {
        return res.status(403).json({ success: false, error: 'Only the agency owner can purchase Super Sender.' });
    }

    const body = req.body || {};
    const quantity = Number(body.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 50) {
        return res.status(400).json({ success: false, error: 'quantity must be an integer between 1 and 50' });
    }
    const workspaceIds: string[] = Array.isArray(body.workspace_ids)
        ? body.workspace_ids.filter((s: unknown) => typeof s === 'string')
        : [];
    if (workspaceIds.length > 0 && workspaceIds.length !== quantity) {
        return res.status(400).json({ success: false, error: 'workspace_ids length must equal quantity' });
    }

    const userId = req.orgContext?.userId;
    if (!userId) {
        return res.status(401).json({ success: false, error: 'Authentication required' });
    }

    try {
        const result = await createSuperSenderCheckout({ orgId, userId, quantity, workspaceIds });
        return res.json({ success: true, data: result });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error('[SUPER_SENDER] checkout failed', err instanceof Error ? err : new Error(msg), { orgId });
        return res.status(400).json({ success: false, error: msg });
    }
};

// ────────────────────────────────────────────────────────────────────
// POST /api/super-sender/:id/assign     Body: { workspace_id }
// POST /api/super-sender/:id/unassign
// ────────────────────────────────────────────────────────────────────

function mapAllocationError(err: AllocationError, res: Response): Response {
    const status =
        err.code === 'NOT_FOUND' ? 404 :
        err.code === 'CROSS_TENANT' ? 403 :
        err.code === 'COOLDOWN' ? 409 :
        400;
    return res.status(status).json({ success: false, error: err.message, code: err.code });
}

export const assignIp = async (req: Request, res: Response): Promise<Response> => {
    const orgId = getOrgId(req);
    const ctx = await resolveAccountContext(orgId);
    if (!ctx) return res.status(404).json({ success: false, error: 'No account context' });
    if (!(await isAgencyOwner(req, ctx.accountId))) {
        return res.status(403).json({ success: false, error: 'Only the agency owner can assign IPs.' });
    }

    const ipId = String(req.params.id || '').trim();
    const workspaceId = String((req.body || {}).workspace_id || '').trim();
    if (!ipId || !workspaceId) {
        return res.status(400).json({ success: false, error: 'id and workspace_id are required' });
    }

    try {
        await assignIpToWorkspace({ ipId, workspaceId, accountId: ctx.accountId });
        return res.json({ success: true });
    } catch (err) {
        if (err instanceof AllocationError) return mapAllocationError(err, res);
        const msg = err instanceof Error ? err.message : String(err);
        logger.error('[SUPER_SENDER] assign failed', err instanceof Error ? err : new Error(msg));
        return res.status(500).json({ success: false, error: 'Failed to assign IP' });
    }
};

export const unassign = async (req: Request, res: Response): Promise<Response> => {
    const orgId = getOrgId(req);
    const ctx = await resolveAccountContext(orgId);
    if (!ctx) return res.status(404).json({ success: false, error: 'No account context' });
    if (!(await isAgencyOwner(req, ctx.accountId))) {
        return res.status(403).json({ success: false, error: 'Only the agency owner can unassign IPs.' });
    }

    const ipId = String(req.params.id || '').trim();
    if (!ipId) return res.status(400).json({ success: false, error: 'id is required' });

    try {
        await unassignIp({ ipId, accountId: ctx.accountId });
        return res.json({ success: true });
    } catch (err) {
        if (err instanceof AllocationError) return mapAllocationError(err, res);
        const msg = err instanceof Error ? err.message : String(err);
        logger.error('[SUPER_SENDER] unassign failed', err instanceof Error ? err : new Error(msg));
        return res.status(500).json({ success: false, error: 'Failed to unassign IP' });
    }
};

// ────────────────────────────────────────────────────────────────────
// POST /api/super-sender/:id/pause       Body: { reason? }
// POST /api/super-sender/:id/resume
//
// Manual operator controls - clears paused_reason on resume. Auto-pause
// (set by the SES SNS handler) is also clearable via /resume; the
// operator owns the override.
// ────────────────────────────────────────────────────────────────────

export const pauseHandler = async (req: Request, res: Response): Promise<Response> => {
    const orgId = getOrgId(req);
    const ctx = await resolveAccountContext(orgId);
    if (!ctx) return res.status(404).json({ success: false, error: 'No account context' });
    if (!(await isAgencyOwner(req, ctx.accountId))) {
        return res.status(403).json({ success: false, error: 'Only the agency owner can pause IPs.' });
    }
    const ipId = String(req.params.id || '').trim();
    if (!ipId) return res.status(400).json({ success: false, error: 'id is required' });
    const reason = typeof (req.body || {}).reason === 'string' ? String((req.body || {}).reason).slice(0, 256) : undefined;
    try {
        await pauseIp({ ipId, accountId: ctx.accountId, reason });
        return res.json({ success: true });
    } catch (err) {
        if (err instanceof AllocationError) return mapAllocationError(err, res);
        const msg = err instanceof Error ? err.message : String(err);
        logger.error('[SUPER_SENDER] pause failed', err instanceof Error ? err : new Error(msg));
        return res.status(500).json({ success: false, error: 'Failed to pause IP' });
    }
};

export const resumeHandler = async (req: Request, res: Response): Promise<Response> => {
    const orgId = getOrgId(req);
    const ctx = await resolveAccountContext(orgId);
    if (!ctx) return res.status(404).json({ success: false, error: 'No account context' });
    if (!(await isAgencyOwner(req, ctx.accountId))) {
        return res.status(403).json({ success: false, error: 'Only the agency owner can resume IPs.' });
    }
    const ipId = String(req.params.id || '').trim();
    if (!ipId) return res.status(400).json({ success: false, error: 'id is required' });
    try {
        await resumeIp({ ipId, accountId: ctx.accountId });
        return res.json({ success: true });
    } catch (err) {
        if (err instanceof AllocationError) return mapAllocationError(err, res);
        const msg = err instanceof Error ? err.message : String(err);
        logger.error('[SUPER_SENDER] resume failed', err instanceof Error ? err : new Error(msg));
        return res.status(500).json({ success: false, error: 'Failed to resume IP' });
    }
};

// ────────────────────────────────────────────────────────────────────
// GET /api/super-sender/:id/mailboxes
//
// Per-IP eligibility view: lists every mailbox in the assigned workspace
// flagged as `routes_through_ip` (SMTP) vs `native_only` (Gmail/Outlook
// OAuth). The card UI uses this so the user knows exactly which of their
// mailboxes will benefit from the dedicated IP.
// ────────────────────────────────────────────────────────────────────

export const getMailboxRouting = async (req: Request, res: Response): Promise<Response> => {
    const orgId = getOrgId(req);
    const ctx = await resolveAccountContext(orgId);
    if (!ctx) return res.status(404).json({ success: false, error: 'No account context' });

    const ipId = String(req.params.id || '').trim();
    if (!ipId) return res.status(400).json({ success: false, error: 'id is required' });

    const ip = await prisma.dedicatedIp.findFirst({
        where: { id: ipId, account_id: ctx.accountId },
        select: { id: true, organization_id: true, state: true, paused_reason: true },
    });
    if (!ip) return res.status(404).json({ success: false, error: 'IP not found' });
    if (!ip.organization_id) {
        return res.json({ success: true, data: { eligible: [], native_only: [] } });
    }

    const accounts = await prisma.connectedAccount.findMany({
        where: { organization_id: ip.organization_id },
        select: { id: true, email: true, provider: true, connection_status: true },
        orderBy: { email: 'asc' },
    });

    const eligible: typeof accounts = [];
    const nativeOnly: typeof accounts = [];
    for (const a of accounts) {
        if (isMailboxSesEligible(a.provider) && a.connection_status === 'active') eligible.push(a);
        else nativeOnly.push(a);
    }

    return res.json({
        success: true,
        data: {
            ip_state: ip.state,
            ip_paused: !!ip.paused_reason,
            eligible: eligible.map(a => ({ id: a.id, email: a.email, provider: a.provider })),
            native_only: nativeOnly.map(a => ({ id: a.id, email: a.email, provider: a.provider, status: a.connection_status })),
        },
    });
};
