/**
 * JustCall.io integration controller.
 *
 *   POST /api/integrations/justcall/connect            — paste & validate API key + secret
 *   GET  /api/integrations/justcall/connection         — current connection info
 *   POST /api/integrations/justcall/disconnect         — wipe stored credentials
 *   GET  /api/integrations/justcall/campaigns          — list sales-dialer campaigns
 *   POST /api/integrations/justcall/campaigns          — create a fresh campaign
 *   POST /api/integrations/justcall/exports            — enqueue an export job
 *   GET  /api/integrations/justcall/exports/:id        — job status
 *
 * Differs from OutreachIntegrationController only where JustCall genuinely
 * differs: there's no OAuth dance (so no /authorize or /callback), and the
 * push target is a sales_dialer campaign (not a sequence/mailbox pair).
 */

import type { Request, Response } from 'express';
import { prisma } from '../index';
import { logger } from '../services/observabilityService';
import {
    upsertJustCallConnection,
    getActiveJustCallConnection,
    disconnectJustCall,
    listRecentJustCallExportJobs,
} from '../services/justcall/connectionService';
import { JustCallClient } from '../services/justcall/client';
import { JustCallError } from '../services/justcall/types';

const MAX_EXPORT_LEADS = 5_000; // matches Outreach — keeps a single job tractable

// ── Connect ───────────────────────────────────────────────────────────

export async function connect(req: Request, res: Response): Promise<Response> {
    if (!req.orgContext?.organizationId || !req.orgContext.userId) {
        return res.status(401).json({ success: false, error: 'Login required' });
    }

    const apiKey = String((req.body ?? {}).api_key ?? '').trim();
    const apiSecret = String((req.body ?? {}).api_secret ?? '').trim();
    if (!apiKey || !apiSecret) {
        return res.status(400).json({ success: false, error: 'api_key and api_secret are required' });
    }

    // Validate the credentials by hitting /users. If the pair is bad,
    // the client throws JustCallError(unauthorized) — we surface that
    // as a 400 to keep the dashboard's error UX consistent.
    let info;
    try {
        const probe = new JustCallClient({ apiKey, apiSecret });
        info = await probe.whoami();
    } catch (err) {
        if (err instanceof JustCallError && err.providerCode === 'unauthorized') {
            return res.status(400).json({
                success: false,
                error: 'JustCall rejected those credentials. Re-copy the key and secret from JustCall → Settings → Developer → API.',
            });
        }
        const msg = err instanceof Error ? err.message?.slice(0, 300) : 'Unknown error';
        logger.warn('[JUSTCALL] connect probe failed', { msg });
        return res.status(502).json({ success: false, error: msg || 'JustCall is unreachable' });
    }

    const conn = await upsertJustCallConnection({
        organizationId: req.orgContext.organizationId,
        apiKey,
        apiSecret,
        justCallUserId: info.userId,
        justCallUserEmail: info.userEmail,
        justCallAccountName: info.accountName,
        connectedByUserId: req.orgContext.userId,
    });

    return res.json({
        success: true,
        data: {
            id: conn.id,
            justcall_user_email: conn.justCallUserEmail,
            justcall_user_id: conn.justCallUserId,
            justcall_account_name: conn.justCallAccountName,
            status: conn.status,
            connected_at: conn.connectedAt.toISOString(),
        },
    });
}

// ── Connection state ──────────────────────────────────────────────────

export async function getConnection(req: Request, res: Response): Promise<Response> {
    if (!req.orgContext?.organizationId) {
        return res.status(401).json({ success: false, error: 'Login required' });
    }
    const orgId = req.orgContext.organizationId;
    const conn = await prisma.justCallConnection.findUnique({ where: { organization_id: orgId } });
    if (!conn) {
        return res.json({ success: true, data: null });
    }

    const recentJobs = await listRecentJustCallExportJobs(conn.id, 25);

    return res.json({
        success: true,
        data: {
            id: conn.id,
            status: conn.status,
            justcall_user_email: conn.justcall_user_email,
            justcall_user_id: conn.justcall_user_id,
            justcall_account_name: conn.justcall_account_name,
            connected_at: conn.connected_at.toISOString(),
            last_validated_at: conn.last_validated_at ? conn.last_validated_at.toISOString() : null,
            last_used_at: conn.last_used_at ? conn.last_used_at.toISOString() : null,
            last_error: conn.last_error,
            disconnected_at: conn.disconnected_at ? conn.disconnected_at.toISOString() : null,
            recent_exports: recentJobs.map(j => ({
                id: j.id,
                source_kind: j.source_kind,
                source_label: j.source_label,
                campaign_id: j.campaign_id,
                campaign_name: j.campaign_name,
                created_campaign: j.created_campaign,
                state: j.state,
                total: j.total,
                total_processed: j.total_processed,
                total_added: j.total_added,
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
    const conn = await prisma.justCallConnection.findUnique({ where: { organization_id: orgId } });
    if (!conn) {
        return res.status(404).json({ success: false, error: 'No JustCall connection' });
    }
    await disconnectJustCall(conn.id, orgId);
    return res.json({ success: true, data: { disconnected: true } });
}

// ── Helpers ───────────────────────────────────────────────────────────

async function makeClient(orgId: string): Promise<JustCallClient | { error: string; status: number }> {
    const conn = await getActiveJustCallConnection(orgId);
    if (!conn) return { error: 'Connect JustCall first.', status: 409 };
    return new JustCallClient({ apiKey: conn.apiKey, apiSecret: conn.apiSecret });
}

// ── Campaigns ─────────────────────────────────────────────────────────

export async function listCampaigns(req: Request, res: Response): Promise<Response> {
    if (!req.orgContext?.organizationId) {
        return res.status(401).json({ success: false, error: 'Login required' });
    }
    const c = await makeClient(req.orgContext.organizationId);
    if ('error' in c) return res.status(c.status).json({ success: false, error: c.error });

    try {
        const items = await c.listCampaigns();
        return res.json({ success: true, data: { items } });
    } catch (err) {
        const msg = err instanceof Error ? err.message?.slice(0, 300) : 'Unknown error';
        logger.warn('[JUSTCALL] listCampaigns failed', { msg });
        return res.status(502).json({ success: false, error: msg || 'Failed to list campaigns' });
    }
}

export async function createCampaign(req: Request, res: Response): Promise<Response> {
    if (!req.orgContext?.organizationId) {
        return res.status(401).json({ success: false, error: 'Login required' });
    }
    const c = await makeClient(req.orgContext.organizationId);
    if ('error' in c) return res.status(c.status).json({ success: false, error: c.error });

    const name = String((req.body ?? {}).name ?? '').trim();
    const countryCode = String((req.body ?? {}).country_code ?? '').trim().toUpperCase();
    if (!name) {
        return res.status(400).json({ success: false, error: 'name is required' });
    }
    if (!countryCode || countryCode.length < 2 || countryCode.length > 3) {
        return res.status(400).json({ success: false, error: 'country_code must be a 2- or 3-letter ISO code' });
    }

    try {
        const summary = await c.createCampaign({ name, countryCode });
        return res.json({ success: true, data: summary });
    } catch (err) {
        const msg = err instanceof Error ? err.message?.slice(0, 300) : 'Unknown error';
        logger.warn('[JUSTCALL] createCampaign failed', { msg });
        return res.status(502).json({ success: false, error: msg || 'Failed to create campaign' });
    }
}

// ── Export jobs ───────────────────────────────────────────────────────

export async function startExport(req: Request, res: Response): Promise<Response> {
    if (!req.orgContext?.organizationId) {
        return res.status(401).json({ success: false, error: 'Login required' });
    }
    const orgId = req.orgContext.organizationId;
    const conn = await getActiveJustCallConnection(orgId);
    if (!conn) {
        return res.status(409).json({ success: false, error: 'Connect JustCall first.' });
    }

    const {
        prospect_ids,
        campaign_id,
        campaign_name,
        created_campaign,
        source_kind,
        source_label,
    } = (req.body ?? {}) as {
        prospect_ids?: string[];
        campaign_id?: string;
        campaign_name?: string;
        created_campaign?: boolean;
        source_kind?: string;
        source_label?: string;
    };

    if (!Array.isArray(prospect_ids) || prospect_ids.length === 0) {
        return res.status(400).json({ success: false, error: 'prospect_ids is required' });
    }
    if (prospect_ids.length > MAX_EXPORT_LEADS) {
        return res.status(400).json({ success: false, error: `Cannot export more than ${MAX_EXPORT_LEADS} prospects at once` });
    }
    if (!campaign_id) {
        return res.status(400).json({ success: false, error: 'campaign_id is required' });
    }
    if (!source_kind) {
        return res.status(400).json({ success: false, error: 'source_kind is required' });
    }

    // Defensive: clamp to CampaignLead rows actually owned by this org.
    const ownedRows = await prisma.campaignLead.findMany({
        where: {
            id: { in: prospect_ids },
            campaign: { organization_id: orgId },
        },
        select: { id: true },
    });
    const ownedIds = ownedRows.map(r => r.id);
    if (ownedIds.length === 0) {
        return res.status(400).json({ success: false, error: 'No matching prospects in this workspace' });
    }

    const job = await prisma.justCallExportJob.create({
        data: {
            justcall_connection_id: conn.id,
            organization_id: orgId,
            source_kind,
            source_label: source_label ?? null,
            prospect_ids: ownedIds,
            campaign_id: String(campaign_id),
            campaign_name: campaign_name ?? null,
            created_campaign: !!created_campaign,
            total: ownedIds.length,
            state: 'pending',
            triggered_by_user_id: req.orgContext.userId ?? null,
        },
    });

    logger.info('[JUSTCALL] export enqueued', {
        orgId,
        jobId: job.id,
        prospectCount: ownedIds.length,
        campaignId: campaign_id,
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

    const job = await prisma.justCallExportJob.findFirst({
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
            campaign_id: job.campaign_id,
            campaign_name: job.campaign_name,
            created_campaign: job.created_campaign,
            total: job.total,
            total_processed: job.total_processed,
            total_added: job.total_added,
            total_skipped: job.total_skipped,
            total_failed: job.total_failed,
            started_at: job.started_at ? job.started_at.toISOString() : null,
            finished_at: job.finished_at ? job.finished_at.toISOString() : null,
            error_message: job.error_message,
            created_at: job.created_at.toISOString(),
        },
    });
}
