/**
 * Lead-source integrations controller — provider-blind read endpoints.
 *
 *   GET    /api/integrations/lead-sources/connections
 *   GET    /api/integrations/lead-sources/connections/:id
 *   POST   /api/integrations/lead-sources/connections/:id/disconnect
 *
 * Provider-specific connect / import flows live in apolloIntegrationController.ts
 * and (later) zoominfoIntegrationController.ts.
 */

import type { Request, Response } from 'express';
import { logger } from '../services/observabilityService';
import {
    listLeadSourceConnectionsForOrg,
    getLeadSourceConnection,
    disconnectLeadSource,
    listRecentImportJobs,
} from '../services/leadSources/connectionService';

export async function listConnections(req: Request, res: Response): Promise<Response> {
    if (!req.orgContext) {
        return res.status(401).json({ success: false, error: 'Login required' });
    }

    const orgId = req.orgContext.organizationId;
    const connections = await listLeadSourceConnectionsForOrg(orgId);

    const enriched = connections.map(c => ({
        id: c.id,
        provider: c.provider,
        status: c.status,
        external_account_name: c.externalAccountName,
        external_account_id: c.externalAccountId,
        connected_at: c.connectedAt.toISOString(),
        last_validated_at: c.lastValidatedAt ? c.lastValidatedAt.toISOString() : null,
        last_used_at: c.lastUsedAt ? c.lastUsedAt.toISOString() : null,
        last_error: c.lastError,
        disconnected_at: c.disconnectedAt ? c.disconnectedAt.toISOString() : null,
    }));

    // Surface placeholder rows for providers the user has never connected,
    // so the UI's grid is stable.
    const known = new Set(enriched.map(r => r.provider));
    for (const provider of ['apollo', 'zoominfo'] as const) {
        if (!known.has(provider)) {
            enriched.push({
                id: '',
                provider,
                status: 'not_connected' as any,
                external_account_name: null,
                external_account_id: null,
                connected_at: '',
                last_validated_at: null,
                last_used_at: null,
                last_error: null,
                disconnected_at: null,
            });
        }
    }

    return res.json({ success: true, data: enriched });
}

export async function getConnectionDetail(req: Request, res: Response): Promise<Response> {
    if (!req.orgContext) {
        return res.status(401).json({ success: false, error: 'Login required' });
    }
    const orgId = req.orgContext.organizationId;
    const id = req.params.id as string;

    const conn = await getLeadSourceConnection(id, orgId);
    if (!conn) {
        return res.status(404).json({ success: false, error: 'Lead-source connection not found' });
    }

    const recentJobs = await listRecentImportJobs(conn.id, 25);

    return res.json({
        success: true,
        data: {
            id: conn.id,
            provider: conn.provider,
            status: conn.status,
            external_account_name: conn.externalAccountName,
            external_account_id: conn.externalAccountId,
            connected_at: conn.connectedAt.toISOString(),
            last_validated_at: conn.lastValidatedAt ? conn.lastValidatedAt.toISOString() : null,
            last_used_at: conn.lastUsedAt ? conn.lastUsedAt.toISOString() : null,
            last_error: conn.lastError,
            disconnected_at: conn.disconnectedAt ? conn.disconnectedAt.toISOString() : null,
            recent_jobs: recentJobs.map(j => ({
                id: j.id,
                state: j.state,
                source_kind: j.source_kind,
                source_url: j.source_url,
                total_estimated: j.total_estimated,
                total_processed: j.total_processed,
                total_created: j.total_created,
                total_updated: j.total_updated,
                total_skipped: j.total_skipped,
                total_failed: j.total_failed,
                credits_consumed: j.credits_consumed,
                started_at: j.started_at ? j.started_at.toISOString() : null,
                finished_at: j.finished_at ? j.finished_at.toISOString() : null,
                error_message: j.error_message,
                created_at: j.created_at.toISOString(),
            })),
        },
    });
}

export async function disconnectConnection(req: Request, res: Response): Promise<Response> {
    if (!req.orgContext) {
        return res.status(401).json({ success: false, error: 'Login required' });
    }
    const orgId = req.orgContext.organizationId;
    const id = req.params.id as string;

    const existing = await getLeadSourceConnection(id, orgId);
    if (!existing) {
        return res.status(404).json({ success: false, error: 'Lead-source connection not found' });
    }

    await disconnectLeadSource(id, orgId);
    logger.info('[LEAD_SOURCE] connection disconnected by user', {
        connectionId: id,
        provider: existing.provider,
        userId: req.orgContext.userId,
    });

    return res.json({ success: true, data: { disconnected: true } });
}
