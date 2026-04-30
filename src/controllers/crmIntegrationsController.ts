/**
 * CRM integrations controller — Phase 1 read-only surface.
 *
 * Drives the /dashboard/integrations/crm UI:
 *   GET    /api/integrations/crm/connections          — list all connections + counts
 *   GET    /api/integrations/crm/connections/:id      — one connection detail (sync history)
 *   POST   /api/integrations/crm/connections/:id/disconnect
 *
 * Connect / OAuth callback / start-sync / field-mapping endpoints are
 * provider-specific and ship in Phase 2 (HubSpot) and Phase 3
 * (Salesforce). This controller stays provider-blind.
 */

import type { Request, Response } from 'express';
import { logger } from '../services/observabilityService';
import {
    listConnectionsForOrg,
    getConnection,
    disconnect,
    getActivityPushSummary,
    listRecentSyncJobs,
} from '../services/crm/connectionService';

/**
 * GET /api/integrations/crm/connections
 *
 * Returns one row per (org, provider) — even providers the user hasn't
 * connected yet are surfaced as `status: 'not_connected'` so the UI can
 * render a single grid of cards consistently.
 */
export async function listConnections(req: Request, res: Response): Promise<Response> {
    if (!req.orgContext) {
        return res.status(401).json({ success: false, error: 'Login required' });
    }

    const orgId = req.orgContext.organizationId;
    const connections = await listConnectionsForOrg(orgId);

    // Enrich with activity-push counts so the UI doesn't need a second round-trip.
    const enriched = await Promise.all(connections.map(async c => {
        const summary = await getActivityPushSummary(c.id);
        return {
            id: c.id,
            provider: c.provider,
            status: c.status,
            external_account_name: c.externalAccountName,
            external_account_id: c.externalAccountId,
            instance_url: c.instanceUrl,
            scopes: c.scopes,
            connected_at: c.connectedAt.toISOString(),
            last_sync_at: c.lastSyncAt ? c.lastSyncAt.toISOString() : null,
            last_error: c.lastError,
            disconnected_at: c.disconnectedAt ? c.disconnectedAt.toISOString() : null,
            activity_push: summary,
        };
    }));

    // Surface placeholder rows for providers the user has never connected
    // so the UI's card grid is stable.
    const knownProviders = new Set(enriched.map(c => c.provider));
    for (const provider of ['hubspot', 'salesforce'] as const) {
        if (!knownProviders.has(provider)) {
            enriched.push({
                id: '',
                provider,
                status: 'not_connected' as any,
                external_account_name: null,
                external_account_id: null,
                instance_url: null,
                scopes: [],
                connected_at: '',
                last_sync_at: null,
                last_error: null,
                disconnected_at: null,
                activity_push: { pending: 0, pushed: 0, failed: 0, skipped: 0 },
            });
        }
    }

    return res.json({ success: true, data: enriched });
}

/**
 * GET /api/integrations/crm/connections/:id
 *
 * Detail view: connection metadata + recent sync jobs.
 */
export async function getConnectionDetail(req: Request, res: Response): Promise<Response> {
    if (!req.orgContext) {
        return res.status(401).json({ success: false, error: 'Login required' });
    }

    const orgId = req.orgContext.organizationId;
    const id = req.params.id as string;
    const connection = await getConnection(id, orgId);
    if (!connection) {
        return res.status(404).json({ success: false, error: 'CRM connection not found' });
    }

    const [summary, recentJobs] = await Promise.all([
        getActivityPushSummary(connection.id),
        listRecentSyncJobs(connection.id, 25),
    ]);

    return res.json({
        success: true,
        data: {
            id: connection.id,
            provider: connection.provider,
            status: connection.status,
            external_account_name: connection.externalAccountName,
            external_account_id: connection.externalAccountId,
            instance_url: connection.instanceUrl,
            scopes: connection.scopes,
            connected_at: connection.connectedAt.toISOString(),
            last_sync_at: connection.lastSyncAt ? connection.lastSyncAt.toISOString() : null,
            last_error: connection.lastError,
            disconnected_at: connection.disconnectedAt ? connection.disconnectedAt.toISOString() : null,
            activity_push: summary,
            recent_sync_jobs: recentJobs.map(j => ({
                id: j.id,
                type: j.type,
                state: j.state,
                total_records: j.total_records,
                records_processed: j.records_processed,
                records_created: j.records_created,
                records_updated: j.records_updated,
                records_failed: j.records_failed,
                started_at: j.started_at ? j.started_at.toISOString() : null,
                finished_at: j.finished_at ? j.finished_at.toISOString() : null,
                error_message: j.error_message,
                created_at: j.created_at.toISOString(),
            })),
        },
    });
}

/**
 * POST /api/integrations/crm/connections/:id/disconnect
 *
 * User-initiated disconnect. Soft-deletes the connection, wipes
 * encrypted tokens, cancels pending activity pushes.
 */
export async function disconnectConnection(req: Request, res: Response): Promise<Response> {
    if (!req.orgContext) {
        return res.status(401).json({ success: false, error: 'Login required' });
    }

    const orgId = req.orgContext.organizationId;
    const id = req.params.id as string;

    const existing = await getConnection(id, orgId);
    if (!existing) {
        return res.status(404).json({ success: false, error: 'CRM connection not found' });
    }

    await disconnect(id, orgId);
    logger.info('[CRM] connection disconnected by user', {
        connectionId: id,
        provider: existing.provider,
        userId: req.orgContext.userId,
    });

    return res.json({ success: true, data: { disconnected: true } });
}
