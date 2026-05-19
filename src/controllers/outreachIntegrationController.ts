/**
 * Outreach.io integration controller.
 *
 *   GET  /api/integrations/outreach/authorize        - kicks off OAuth
 *   GET  /api/integrations/outreach/callback         - OAuth redirect target
 *   GET  /api/integrations/outreach/connection       - current connection info
 *   POST /api/integrations/outreach/disconnect       - revoke + wipe tokens
 *   GET  /api/integrations/outreach/sequences        - list user's sequences
 *   POST /api/integrations/outreach/sequences        - create a new (empty) sequence
 *   GET  /api/integrations/outreach/mailboxes        - list user's mailboxes
 *   POST /api/integrations/outreach/exports          - enqueue an export job
 *   GET  /api/integrations/outreach/exports/:id      - job status
 */

import type { Request, Response } from 'express';
import { prisma } from '../prisma';
import { logger } from '../services/observabilityService';
import {
    envGuard,
    exchangeCodeForTokens,
    generateAuthUrl,
    signState,
    verifyState,
} from '../services/outreach/oauthService';
import {
    upsertOutreachConnection,
    getActiveOutreachConnection,
    getOutreachConnection,
    disconnectOutreach,
    updateRefreshedTokens,
    listRecentExportJobs,
} from '../services/outreach/connectionService';
import { OutreachClient } from '../services/outreach/client';
import { isHardSuppressed } from '../services/leadContactabilityService';

const FRONTEND_BASE = process.env.FRONTEND_URL || 'http://localhost:3000';
const MAX_EXPORT_LEADS = 5_000; // hard cap per export to keep jobs tractable

function dashboardRedirect(path: string): string {
    return `${FRONTEND_BASE}${path}`;
}

// ── OAuth ────────────────────────────────────────────────────────────

export async function authorize(req: Request, res: Response): Promise<Response | void> {
    if (!req.orgContext?.organizationId || !req.orgContext.userId) {
        return res.status(401).json({ success: false, error: 'Login required' });
    }
    const env = envGuard();
    if (!env.ok) {
        return res.status(503).json({ success: false, error: env.reason });
    }
    const state = signState({
        organizationId: req.orgContext.organizationId,
        userId: req.orgContext.userId,
        source: 'dashboard',
    });
    const url = generateAuthUrl({ state });
    return res.redirect(url);
}

export async function callback(req: Request, res: Response): Promise<Response | void> {
    const env = envGuard();
    if (!env.ok) {
        return res.status(503).json({ success: false, error: env.reason });
    }

    const code = String(req.query.code ?? '');
    const stateParam = String(req.query.state ?? '');
    const errorParam = req.query.error;
    if (errorParam) {
        return res.redirect(dashboardRedirect(`/dashboard/integrations/outreach?error=${encodeURIComponent(String(errorParam))}`));
    }
    if (!code || !stateParam) {
        return res.redirect(dashboardRedirect('/dashboard/integrations/outreach?error=missing_params'));
    }

    const state = verifyState(stateParam);
    if (!state) {
        return res.redirect(dashboardRedirect('/dashboard/integrations/outreach?error=invalid_state'));
    }

    let tokens;
    try {
        tokens = await exchangeCodeForTokens(code);
    } catch (err) {
        logger.warn('[OUTREACH] callback token exchange failed', { msg: (err as Error).message });
        return res.redirect(dashboardRedirect('/dashboard/integrations/outreach?error=token_exchange_failed'));
    }

    // Best-effort whoami so we can show "connected as you@your.co" in the dashboard.
    let userId: string | null = null;
    let userEmail: string | null = null;
    try {
        const probe = new OutreachClient({
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token,
        });
        const info = await probe.whoami();
        userId = info.userId;
        userEmail = info.userEmail;
    } catch (err) {
        logger.warn('[OUTREACH] whoami failed at connect', { msg: (err as Error).message });
    }

    await upsertOutreachConnection({
        organizationId: state.organizationId,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        tokenExpiresAt: tokens.expires_at,
        scopes: tokens.scopes ?? undefined,
        outreachUserId: userId,
        outreachUserEmail: userEmail,
        connectedByUserId: state.userId,
    });

    return res.redirect(dashboardRedirect('/dashboard/integrations/outreach?status=connected'));
}

// ── Connection state ─────────────────────────────────────────────────

export async function getConnection(req: Request, res: Response): Promise<Response> {
    if (!req.orgContext?.organizationId) {
        return res.status(401).json({ success: false, error: 'Login required' });
    }
    const orgId = req.orgContext.organizationId;
    const conn = await prisma.outreachConnection.findUnique({
        where: { organization_id: orgId },
    });
    if (!conn) {
        return res.json({ success: true, data: null });
    }

    const recentJobs = await listRecentExportJobs(conn.id, 25);

    return res.json({
        success: true,
        data: {
            id: conn.id,
            status: conn.status,
            outreach_user_email: conn.outreach_user_email,
            outreach_user_id: conn.outreach_user_id,
            outreach_org_name: conn.outreach_org_name,
            connected_at: conn.connected_at.toISOString(),
            last_validated_at: conn.last_validated_at ? conn.last_validated_at.toISOString() : null,
            last_used_at: conn.last_used_at ? conn.last_used_at.toISOString() : null,
            last_error: conn.last_error,
            disconnected_at: conn.disconnected_at ? conn.disconnected_at.toISOString() : null,
            recent_exports: recentJobs.map(j => ({
                id: j.id,
                source_kind: j.source_kind,
                source_label: j.source_label,
                sequence_id: j.sequence_id,
                sequence_name: j.sequence_name,
                created_sequence: j.created_sequence,
                state: j.state,
                total: j.total,
                total_processed: j.total_processed,
                total_prospects_created: j.total_prospects_created,
                total_prospects_updated: j.total_prospects_updated,
                total_added_to_sequence: j.total_added_to_sequence,
                total_skipped: j.total_skipped,
                total_failed: j.total_failed,
                started_at: j.started_at ? j.started_at.toISOString() : null,
                finished_at: j.finished_at ? j.finished_at.toISOString() : null,
                error_message: j.error_message,
                created_at: j.created_at.toISOString(),
            })),
        },
    });
}

export async function disconnect(req: Request, res: Response): Promise<Response> {
    if (!req.orgContext?.organizationId) {
        return res.status(401).json({ success: false, error: 'Login required' });
    }
    const orgId = req.orgContext.organizationId;
    const conn = await prisma.outreachConnection.findUnique({ where: { organization_id: orgId } });
    if (!conn) {
        return res.status(404).json({ success: false, error: 'No Outreach connection' });
    }
    await disconnectOutreach(conn.id, orgId);
    return res.json({ success: true, data: { disconnected: true } });
}

// ── Helpers ──────────────────────────────────────────────────────────

async function makeClient(orgId: string): Promise<OutreachClient | { error: string; status: number }> {
    const conn = await getActiveOutreachConnection(orgId);
    if (!conn) return { error: 'Connect Outreach first.', status: 409 };
    return new OutreachClient({
        accessToken: conn.accessToken,
        refreshToken: conn.refreshToken,
        onTokensRefreshed: async (fresh) => {
            await updateRefreshedTokens(conn.id, {
                accessToken: fresh.access_token,
                refreshToken: fresh.refresh_token,
                tokenExpiresAt: fresh.expires_at,
            });
        },
    });
}

// ── Sequences ────────────────────────────────────────────────────────

export async function listSequences(req: Request, res: Response): Promise<Response> {
    if (!req.orgContext?.organizationId) {
        return res.status(401).json({ success: false, error: 'Login required' });
    }
    const c = await makeClient(req.orgContext.organizationId);
    if ('error' in c) return res.status(c.status).json({ success: false, error: c.error });

    try {
        const cursor = req.query.cursor ? String(req.query.cursor) : null;
        const { items, nextCursor } = await c.listSequences({ cursor });
        return res.json({ success: true, data: { items, next_cursor: nextCursor } });
    } catch (err) {
        const msg = (err as Error).message?.slice(0, 300);
        logger.warn('[OUTREACH] listSequences failed', { msg });
        return res.status(502).json({ success: false, error: msg || 'Failed to list sequences' });
    }
}

export async function createSequence(req: Request, res: Response): Promise<Response> {
    if (!req.orgContext?.organizationId) {
        return res.status(401).json({ success: false, error: 'Login required' });
    }
    const c = await makeClient(req.orgContext.organizationId);
    if ('error' in c) return res.status(c.status).json({ success: false, error: c.error });

    const name = String((req.body ?? {}).name ?? '').trim();
    const shareTypeIn = (req.body ?? {}).share_type;
    const shareType: 'private' | 'read_only' | 'shared' =
        shareTypeIn === 'private' || shareTypeIn === 'read_only' || shareTypeIn === 'shared'
            ? shareTypeIn
            : 'shared';
    if (!name) {
        return res.status(400).json({ success: false, error: 'name is required' });
    }

    try {
        const seq = await c.createSequence({ name, shareType });
        return res.json({ success: true, data: seq });
    } catch (err) {
        const msg = (err as Error).message?.slice(0, 300);
        logger.warn('[OUTREACH] createSequence failed', { msg });
        return res.status(502).json({ success: false, error: msg || 'Failed to create sequence' });
    }
}

// ── Mailboxes ────────────────────────────────────────────────────────

export async function listMailboxes(req: Request, res: Response): Promise<Response> {
    if (!req.orgContext?.organizationId) {
        return res.status(401).json({ success: false, error: 'Login required' });
    }
    const c = await makeClient(req.orgContext.organizationId);
    if ('error' in c) return res.status(c.status).json({ success: false, error: c.error });

    try {
        const items = await c.listOwnedMailboxes();
        return res.json({ success: true, data: items });
    } catch (err) {
        const msg = (err as Error).message?.slice(0, 300);
        logger.warn('[OUTREACH] listMailboxes failed', { msg });
        return res.status(502).json({ success: false, error: msg || 'Failed to list mailboxes' });
    }
}

// ── Export jobs ──────────────────────────────────────────────────────

export async function startExport(req: Request, res: Response): Promise<Response> {
    if (!req.orgContext?.organizationId) {
        return res.status(401).json({ success: false, error: 'Login required' });
    }
    const orgId = req.orgContext.organizationId;
    const conn = await getActiveOutreachConnection(orgId);
    if (!conn) {
        return res.status(409).json({ success: false, error: 'Connect Outreach first.' });
    }

    const {
        prospect_ids,
        sequence_id,
        sequence_name,
        created_sequence,
        mailbox_id,
        source_kind,
        source_label,
    } = (req.body ?? {}) as {
        prospect_ids?: string[];
        sequence_id?: string;
        sequence_name?: string;
        created_sequence?: boolean;
        mailbox_id?: string;
        source_kind?: string;
        source_label?: string;
    };

    if (!Array.isArray(prospect_ids) || prospect_ids.length === 0) {
        return res.status(400).json({ success: false, error: 'prospect_ids is required' });
    }
    if (prospect_ids.length > MAX_EXPORT_LEADS) {
        return res.status(400).json({ success: false, error: `Cannot export more than ${MAX_EXPORT_LEADS} prospects at once` });
    }
    if (!sequence_id) {
        return res.status(400).json({ success: false, error: 'sequence_id is required' });
    }
    if (!mailbox_id) {
        return res.status(400).json({ success: false, error: 'mailbox_id is required' });
    }
    if (!source_kind) {
        return res.status(400).json({ success: false, error: 'source_kind is required' });
    }

    // Defensive: clamp prospect_ids to CampaignLead rows owned by campaigns
    // in this org, THEN drop hard-suppressed prospects (bounced /
    // unsubscribed / GDPR-erased) via the SHARED contactability predicate.
    // Authoritative, stale-client-proof gate: an unreachable person never
    // gets pushed into a sales-engagement sequence even if the cold-call
    // page was loaded before their state changed.
    const ownedRows = await prisma.campaignLead.findMany({
        where: {
            id: { in: prospect_ids },
            campaign: { organization_id: orgId },
        },
        select: { id: true, status: true, bounced_at: true, unsubscribed_at: true, email: true },
    });
    if (ownedRows.length === 0) {
        return res.status(400).json({ success: false, error: 'No matching prospects in this workspace' });
    }
    const contactable = ownedRows.filter(r => !isHardSuppressed(r));
    const ownedIds = contactable.map(r => r.id);
    const suppressedCount = ownedRows.length - contactable.length;
    if (ownedIds.length === 0) {
        return res.status(400).json({
            success: false,
            error: `All ${ownedRows.length} selected prospect(s) are unreachable (bounced, unsubscribed, or erased) and were skipped.`,
        });
    }

    const job = await prisma.outreachExportJob.create({
        data: {
            outreach_connection_id: conn.id,
            organization_id: orgId,
            source_kind,
            source_label: source_label ?? null,
            prospect_ids: ownedIds,
            sequence_id,
            sequence_name: sequence_name ?? null,
            created_sequence: !!created_sequence,
            add_to_mailbox_id: mailbox_id,
            total: ownedIds.length,
            state: 'pending',
            triggered_by_user_id: req.orgContext.userId ?? null,
        },
    });

    logger.info('[OUTREACH] export enqueued', {
        orgId,
        jobId: job.id,
        prospectCount: ownedIds.length,
        suppressedSkipped: suppressedCount,
        sequenceId: sequence_id,
        sourceKind: source_kind,
    });

    return res.json({ success: true, data: { export_job_id: job.id } });
}

export async function getExportJob(req: Request, res: Response): Promise<Response> {
    if (!req.orgContext?.organizationId) {
        return res.status(401).json({ success: false, error: 'Login required' });
    }
    const orgId = req.orgContext.organizationId;
    const id = req.params.id as string;

    const job = await prisma.outreachExportJob.findFirst({
        where: { id, organization_id: orgId },
    });
    if (!job) {
        return res.status(404).json({ success: false, error: 'Job not found' });
    }
    return res.json({
        success: true,
        data: {
            id: job.id,
            state: job.state,
            source_kind: job.source_kind,
            source_label: job.source_label,
            sequence_id: job.sequence_id,
            sequence_name: job.sequence_name,
            created_sequence: job.created_sequence,
            total: job.total,
            total_processed: job.total_processed,
            total_prospects_created: job.total_prospects_created,
            total_prospects_updated: job.total_prospects_updated,
            total_added_to_sequence: job.total_added_to_sequence,
            total_skipped: job.total_skipped,
            total_failed: job.total_failed,
            started_at: job.started_at ? job.started_at.toISOString() : null,
            finished_at: job.finished_at ? job.finished_at.toISOString() : null,
            error_message: job.error_message,
            created_at: job.created_at.toISOString(),
        },
    });
}

// Helper for the controller to know the connection-level reference for routes
export { getOutreachConnection };
