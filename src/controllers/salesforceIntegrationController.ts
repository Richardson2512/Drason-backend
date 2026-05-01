/**
 * Salesforce integration controller — production AND sandbox.
 *
 * Endpoints:
 *   GET  /api/integrations/salesforce/authorize?env=production|sandbox
 *   GET  /api/integrations/salesforce/callback
 *   GET  /api/integrations/salesforce/list-views   — list views available on Contact
 *   GET  /api/integrations/salesforce/fields       — describe Contact fields
 *   POST /api/integrations/salesforce/import       — body: { view_id?, soql?, field_mapping? }
 */

import type { Request, Response } from 'express';
import { logger } from '../services/observabilityService';
import {
    detectEnvFromInstanceUrl,
    envGuard,
    fetchAccountInfo,
    SalesforceLoginEnv,
    signState,
    verifyState,
} from '../services/crm/salesforce/oauthService';
import { SalesforceCrmClient } from '../services/crm/salesforce/client';
import { upsertConnection, getConnection } from '../services/crm/connectionService';
import { prisma } from '../index';

const DASHBOARD_RETURN = '/dashboard/integrations/crm';

function getFrontendUrl(): string {
    return (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');
}

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

    const sfEnv: SalesforceLoginEnv = req.query.env === 'sandbox' ? 'sandbox' : 'production';

    const state = signState({
        organizationId: req.orgContext.organizationId,
        userId: req.orgContext.userId,
        env: sfEnv,
        redirectAfterConnect: typeof req.query.next === 'string' ? req.query.next : DASHBOARD_RETURN,
    });

    // Pre-instance client just for the auth-URL helper.
    const client = new SalesforceCrmClient({
        accessToken: '',
        refreshToken: null,
        instanceUrl: 'https://login.salesforce.com', // placeholder; only env matters for URL generation
        env: sfEnv,
    });

    const url = client.generateAuthUrl({ state, redirectUri: process.env.SALESFORCE_REDIRECT_URI! });
    res.redirect(url);
}

export async function callback(req: Request, res: Response): Promise<void> {
    const code = typeof req.query.code === 'string' ? req.query.code : null;
    const state = typeof req.query.state === 'string' ? req.query.state : null;
    const error = typeof req.query.error === 'string' ? req.query.error : null;

    const frontend = getFrontendUrl();
    if (error) {
        res.redirect(`${frontend}${DASHBOARD_RETURN}?error=${encodeURIComponent(error)}`);
        return;
    }
    if (!code || !state) {
        res.redirect(`${frontend}${DASHBOARD_RETURN}?error=missing_code_or_state`);
        return;
    }

    const decoded = verifyState(state);
    if (!decoded) {
        res.redirect(`${frontend}${DASHBOARD_RETURN}?error=invalid_or_expired_state`);
        return;
    }

    try {
        // Build a placeholder client just for the exchange — instanceUrl
        // will be populated from the response and used for everything else.
        const client = new SalesforceCrmClient({
            accessToken: '',
            refreshToken: null,
            instanceUrl: 'https://login.salesforce.com',
            env: decoded.env,
        });
        const tokens = await client.exchangeCodeForTokens({
            code,
            redirectUri: process.env.SALESFORCE_REDIRECT_URI!,
        });

        const instanceUrl = (tokens as any).instance_url as string | undefined;
        if (!instanceUrl) {
            throw new Error('Salesforce did not return instance_url');
        }

        const account = await fetchAccountInfo({
            accessToken: tokens.access_token,
            instanceUrl,
        });

        await upsertConnection({
            organizationId: decoded.organizationId,
            provider: 'salesforce',
            tokens,
            externalAccountId: account.externalAccountId,
            externalAccountName: account.externalAccountName,
            instanceUrl,
            connectedByUserId: decoded.userId,
        });

        logger.info('[SALESFORCE] connected', {
            orgId: decoded.organizationId,
            sfOrgId: account.externalAccountId,
            env: decoded.env,
        });

        const next = decoded.redirectAfterConnect || DASHBOARD_RETURN;
        res.redirect(`${frontend}${next}?connected=salesforce`);
    } catch (err) {
        logger.error('[SALESFORCE] callback failed', err instanceof Error ? err : new Error(String(err)));
        res.redirect(`${frontend}${DASHBOARD_RETURN}?error=salesforce_connect_failed`);
    }
}

type LoadedSf =
    | { kind: 'ok'; connectionId: string; client: SalesforceCrmClient }
    | { kind: 'err'; status: number; message: string };

async function loadSfClientForOrg(req: Request): Promise<LoadedSf> {
    if (!req.orgContext?.organizationId) {
        return { kind: 'err', status: 401, message: 'Login required' };
    }
    const orgId = req.orgContext.organizationId;
    const conn = await prisma.crmConnection.findUnique({
        where: { organization_id_provider: { organization_id: orgId, provider: 'salesforce' } },
    });
    if (!conn || conn.status !== 'active' || !conn.instance_url) {
        return { kind: 'err', status: 404, message: 'No active Salesforce connection' };
    }
    const decrypted = await getConnection(conn.id, orgId);
    if (!decrypted || !decrypted.instanceUrl) {
        return { kind: 'err', status: 404, message: 'Connection vanished' };
    }
    const client = new SalesforceCrmClient({
        accessToken: decrypted.accessToken,
        refreshToken: decrypted.refreshToken,
        instanceUrl: decrypted.instanceUrl,
        env: detectEnvFromInstanceUrl(decrypted.instanceUrl),
        onTokensRefreshed: async (fresh) => {
            const { updateRefreshedTokens } = await import('../services/crm/connectionService');
            await updateRefreshedTokens(decrypted.id, fresh);
        },
    });
    return { kind: 'ok', connectionId: decrypted.id, client };
}

export async function listViews(req: Request, res: Response): Promise<Response> {
    const loaded = await loadSfClientForOrg(req);
    if (loaded.kind === 'err') {
        return res.status(loaded.status).json({ success: false, error: loaded.message });
    }

    try {
        // /sobjects/Contact/listviews
        const innerRes = await fetch(
            `${(loaded.client as any).instanceUrl}/services/data/v60.0/sobjects/Contact/listviews`,
            { headers: { Authorization: `Bearer ${(loaded.client as any).accessToken}` } },
        );
        const data = await innerRes.json().catch(() => ({})) as any;
        const views = Array.isArray(data?.listviews)
            ? data.listviews.map((v: any) => ({
                id: String(v.id),
                name: String(v.label ?? v.developerName ?? '(unnamed list view)'),
                describe_url: v.describeUrl ?? null,
            }))
            : [];
        return res.json({ success: true, data: views });
    } catch (err) {
        logger.error('[SALESFORCE] listViews failed', err instanceof Error ? err : new Error(String(err)));
        return res.status(502).json({ success: false, error: 'Failed to load Salesforce list views' });
    }
}

export async function describeFields(req: Request, res: Response): Promise<Response> {
    const loaded = await loadSfClientForOrg(req);
    if (loaded.kind === 'err') {
        return res.status(loaded.status).json({ success: false, error: loaded.message });
    }
    try {
        const fields = await loaded.client.describeContactFields();
        return res.json({ success: true, data: fields });
    } catch (err) {
        logger.error('[SALESFORCE] describeFields failed', err instanceof Error ? err : new Error(String(err)));
        return res.status(502).json({ success: false, error: 'Failed to describe Contact fields' });
    }
}

export async function startImport(req: Request, res: Response): Promise<Response> {
    const loaded = await loadSfClientForOrg(req);
    if (loaded.kind === 'err') {
        return res.status(loaded.status).json({ success: false, error: loaded.message });
    }

    const orgContext = req.orgContext!;
    const { view_id, soql, field_mapping } = (req.body ?? {}) as {
        view_id?: string;
        soql?: string;
        field_mapping?: Array<{ superkabe_field: string; crm_field: string; direction?: string }>;
    };

    let source: { kind: 'view'; viewId: string } | { kind: 'soql'; query: string } | { kind: 'all' };
    if (view_id && typeof view_id === 'string') source = { kind: 'view', viewId: view_id };
    else if (soql && typeof soql === 'string') source = { kind: 'soql', query: soql };
    else source = { kind: 'all' };

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
            source_filter: source as any,
            triggered_by_user_id: orgContext.userId ?? null,
        },
    });

    logger.info('[SALESFORCE] import enqueued', {
        orgId: orgContext.organizationId,
        source,
        jobId: job.id,
    });

    return res.json({ success: true, data: { sync_job_id: job.id } });
}
