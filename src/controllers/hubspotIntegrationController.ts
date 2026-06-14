/**
 * HubSpot integration controller.
 *
 * Endpoints:
 *   GET    /api/integrations/hubspot/authorize       - kicks off OAuth (signs state, redirects to HubSpot)
 *   GET    /api/integrations/hubspot/callback        - exchanges code, persists connection, redirects to dashboard
 *   GET    /api/integrations/hubspot/lists           - paginated list of HubSpot v3 lists for the import picker
 *   GET    /api/integrations/hubspot/fields          - describe contact fields (for field-mapping UI)
 *   POST   /api/integrations/hubspot/import          - body: { list_id, field_mapping } → enqueues CrmSyncJob
 */

import type { Request, Response } from 'express';
import { logger } from '../services/observabilityService';
import {
    envGuard,
    fetchAccountInfo,
    signState,
    verifyState,
} from '../services/crm/hubspot/oauthService';
import { HubSpotCrmClient } from '../services/crm/hubspot/client';
import { upsertConnection, getConnection } from '../services/crm/connectionService';
import { prisma } from '../index';

const HUBSPOT_DASHBOARD_RETURN = '/dashboard/integrations/crm';

function getFrontendUrl(): string {
    return (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');
}

/**
 * GET /api/integrations/hubspot/authorize
 * Requires login. Signs a CSRF state JWT and redirects to HubSpot's
 * consent screen. After consent, HubSpot redirects to /callback below.
 */
export async function authorize(req: Request, res: Response): Promise<void> {
    const env = envGuard();
    if (!env.ok) {
        res.status(503).json({ success: false, error: env.reason });
        return;
    }

    if (!req.orgContext?.organizationId || !req.orgContext?.userId) {
        res.status(401).json({ success: false, error: 'Login required' });
        return;
    }

    const state = signState({
        organizationId: req.orgContext.organizationId,
        userId: req.orgContext.userId,
        redirectAfterConnect: typeof req.query.next === 'string' ? req.query.next : HUBSPOT_DASHBOARD_RETURN,
    });

    const client = new HubSpotCrmClient({ accessToken: '', refreshToken: null });
    const url = client.generateAuthUrl({ state, redirectUri: process.env.HUBSPOT_REDIRECT_URI! });
    res.redirect(url);
}

/**
 * GET /api/integrations/hubspot/callback?code=…&state=…
 * Public path (no extractOrgContext) - auth is reconstructed from the
 * state JWT. Exchanges the code for tokens, persists the CrmConnection,
 * then redirects the user back to the dashboard.
 */
export async function callback(req: Request, res: Response): Promise<void> {
    const code = typeof req.query.code === 'string' ? req.query.code : null;
    const state = typeof req.query.state === 'string' ? req.query.state : null;
    const error = typeof req.query.error === 'string' ? req.query.error : null;

    const frontend = getFrontendUrl();

    if (error) {
        // User denied or HubSpot rejected. Bounce back with an error message.
        res.redirect(`${frontend}${HUBSPOT_DASHBOARD_RETURN}?error=${encodeURIComponent(error)}`);
        return;
    }

    if (!code || !state) {
        res.redirect(`${frontend}${HUBSPOT_DASHBOARD_RETURN}?error=missing_code_or_state`);
        return;
    }

    const decoded = verifyState(state);
    if (!decoded) {
        res.redirect(`${frontend}${HUBSPOT_DASHBOARD_RETURN}?error=invalid_or_expired_state`);
        return;
    }

    try {
        const client = new HubSpotCrmClient({ accessToken: '', refreshToken: null });
        const tokens = await client.exchangeCodeForTokens({
            code,
            redirectUri: process.env.HUBSPOT_REDIRECT_URI!,
        });
        const account = await fetchAccountInfo(tokens.access_token);

        await upsertConnection({
            organizationId: decoded.organizationId,
            provider: 'hubspot',
            tokens,
            externalAccountId: account.externalAccountId,
            externalAccountName: account.externalAccountName,
            connectedByUserId: decoded.userId,
        });

        logger.info('[HUBSPOT] connected', {
            orgId: decoded.organizationId,
            portalId: account.externalAccountId,
        });

        const next = decoded.redirectAfterConnect || HUBSPOT_DASHBOARD_RETURN;
        res.redirect(`${frontend}${next}?connected=hubspot`);
    } catch (err) {
        logger.error('[HUBSPOT] callback failed', err instanceof Error ? err : new Error(String(err)));
        res.redirect(`${frontend}${HUBSPOT_DASHBOARD_RETURN}?error=hubspot_connect_failed`);
    }
}

type LoadedHubSpot =
    | { kind: 'ok'; connectionId: string; client: HubSpotCrmClient }
    | { kind: 'err'; status: number; message: string };

async function loadHubSpotClientForOrg(req: Request): Promise<LoadedHubSpot> {
    if (!req.orgContext?.organizationId) {
        return { kind: 'err', status: 401, message: 'Login required' };
    }
    const orgId = req.orgContext.organizationId;

    // One-per-org HubSpot connection.
    const conn = await prisma.crmConnection.findUnique({
        where: { organization_id_provider: { organization_id: orgId, provider: 'hubspot' } },
    });
    if (!conn || conn.status !== 'active') {
        return { kind: 'err', status: 404, message: 'No active HubSpot connection' };
    }

    const decrypted = await getConnection(conn.id, orgId);
    if (!decrypted) return { kind: 'err', status: 404, message: 'Connection vanished' };

    const client = new HubSpotCrmClient({
        accessToken: decrypted.accessToken,
        refreshToken: decrypted.refreshToken,
        onTokensRefreshed: async (fresh) => {
            const { updateRefreshedTokens } = await import('../services/crm/connectionService');
            await updateRefreshedTokens(decrypted.id, fresh);
        },
    });
    return { kind: 'ok', connectionId: decrypted.id, client };
}

/** GET /api/integrations/hubspot/lists - surface HubSpot v3 lists for the import picker. */
export async function listLists(req: Request, res: Response): Promise<Response> {
    const loaded = await loadHubSpotClientForOrg(req);
    if (loaded.kind === 'err') {
        return res.status(loaded.status).json({ success: false, error: loaded.message });
    }
    // HubSpot v3 lists API: /crm/v3/lists/search
    // Wrap raw API call here since it isn't in the CrmClient interface.
    try {
        const data = await fetch(
            'https://api.hubapi.com/crm/v3/lists/search',
            {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${(loaded.client as any).accessToken}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ count: 50, listIds: [] }),
            },
        ).then(r => r.json());

        const lists = Array.isArray(data?.lists)
            ? data.lists.map((l: any) => ({
                id: String(l.listId ?? l.list_id ?? ''),
                name: String(l.name ?? '(unnamed list)'),
                size: Number(l.additionalProperties?.hs_list_size ?? 0),
                processing_type: l.processingType ?? null,
            }))
            : [];

        return res.json({ success: true, data: lists });
    } catch (err) {
        logger.error('[HUBSPOT] listLists failed', err instanceof Error ? err : new Error(String(err)));
        return res.status(502).json({ success: false, error: 'Failed to load HubSpot lists' });
    }
}

/** GET /api/integrations/hubspot/fields - describe contact fields. */
export async function describeFields(req: Request, res: Response): Promise<Response> {
    const loaded = await loadHubSpotClientForOrg(req);
    if (loaded.kind === 'err') {
        return res.status(loaded.status).json({ success: false, error: loaded.message });
    }
    try {
        const fields = await loaded.client.describeContactFields();
        return res.json({ success: true, data: fields });
    } catch (err) {
        logger.error('[HUBSPOT] describeFields failed', err instanceof Error ? err : new Error(String(err)));
        return res.status(502).json({ success: false, error: 'Failed to describe HubSpot fields' });
    }
}

/**
 * POST /api/integrations/hubspot/import
 * Body: { list_id: string, field_mapping?: Array<{ superkabe_field, crm_field, direction? }> }
 * Returns: { sync_job_id }
 *
 * Persists the field mapping (replacing any prior import-direction
 * rows for this connection), creates a CrmSyncJob in pending state.
 * The contact-import worker picks it up.
 */
export async function startImport(req: Request, res: Response): Promise<Response> {
    const loaded = await loadHubSpotClientForOrg(req);
    if (loaded.kind === 'err') {
        return res.status(loaded.status).json({ success: false, error: loaded.message });
    }

    const orgContext = req.orgContext!;
    const { list_id, field_mapping } = (req.body ?? {}) as {
        list_id?: string;
        field_mapping?: Array<{ superkabe_field: string; crm_field: string; direction?: string }>;
    };

    if (!list_id || typeof list_id !== 'string') {
        return res.status(400).json({ success: false, error: 'list_id is required' });
    }

    // Replace existing import-direction mappings for this connection so the
    // wizard's "save" semantics are obvious.
    if (Array.isArray(field_mapping)) {
        await prisma.crmFieldMapping.deleteMany({
            where: { crm_connection_id: loaded.connectionId, direction: 'import' },
        });
        for (const m of field_mapping) {
            if (!m?.superkabe_field || !m?.crm_field) continue;
            await prisma.crmFieldMapping.create({
                data: {
                    crm_connection_id: loaded.connectionId,
                    superkabe_field: m.superkabe_field,
                    crm_field: m.crm_field,
                    direction: m.direction || 'import',
                },
            });
        }
    }

    const job = await prisma.crmSyncJob.create({
        data: {
            crm_connection_id: loaded.connectionId,
            type: 'initial_import',
            state: 'pending',
            source_filter: { kind: 'list', listId: list_id } as any,
            triggered_by_user_id: orgContext.userId ?? null,
        },
    });

    logger.info('[HUBSPOT] import enqueued', {
        orgId: orgContext.organizationId,
        listId: list_id,
        jobId: job.id,
    });

    return res.json({ success: true, data: { sync_job_id: job.id } });
}
