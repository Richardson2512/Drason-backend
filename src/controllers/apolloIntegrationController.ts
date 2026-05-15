/**
 * Apollo integration controller (Phase 5).
 *
 * Endpoints:
 *   POST  /api/integrations/apollo/connect     - validate API key + persist
 *   POST  /api/integrations/apollo/parse-url   - preview parsed filters + count
 *   POST  /api/integrations/apollo/import      - enqueue an import job
 *   GET   /api/integrations/apollo/jobs/:id    - job status (polled by UI)
 *
 * Disconnect lives on the provider-blind /api/integrations/lead-sources/...
 * routes since it doesn't need Apollo-specific knowledge.
 */

import type { Request, Response } from 'express';
import { prisma } from '../prisma';
import { logger } from '../services/observabilityService';
import { ApolloLeadSourceClient } from '../services/leadSources/apollo/client';
import { parseApolloUrl, summarizeFilter } from '../services/leadSources/apollo/urlParser';
import {
    upsertLeadSourceConnection,
    getLeadSourceConnectionByProvider,
} from '../services/leadSources/connectionService';
import { LeadSourceError } from '../services/leadSources/types';

/**
 * POST /api/integrations/apollo/connect
 * Body: { api_key: string }
 * Validates the key against Apollo, persists the connection, returns
 * the dashboard-shaped connection summary.
 */
export async function connect(req: Request, res: Response): Promise<Response> {
    if (!req.orgContext?.organizationId) {
        return res.status(401).json({ success: false, error: 'Login required' });
    }

    const apiKey = String((req.body ?? {}).api_key ?? '').trim();
    if (!apiKey) {
        return res.status(400).json({ success: false, error: 'api_key is required' });
    }

    const client = new ApolloLeadSourceClient({ apiKey });

    let info;
    try {
        info = await client.validateConnection();
    } catch (err) {
        const code = err instanceof LeadSourceError ? err.providerCode : undefined;
        const msg = err instanceof Error ? err.message : 'Apollo validation failed';
        logger.warn('[APOLLO] validate failed', { code, msg: msg.slice(0, 200) });
        return res.status(400).json({ success: false, error: msg, code });
    }

    const conn = await upsertLeadSourceConnection({
        organizationId: req.orgContext.organizationId,
        provider: 'apollo',
        apiKey,
        externalAccountId: info.externalAccountId,
        externalAccountName: info.externalAccountName,
        connectedByUserId: req.orgContext.userId,
    });

    logger.info('[APOLLO] connected', {
        orgId: req.orgContext.organizationId,
        externalAccountId: info.externalAccountId,
    });

    return res.json({
        success: true,
        data: {
            id: conn.id,
            provider: conn.provider,
            status: conn.status,
            external_account_name: info.externalAccountName,
            external_account_id: info.externalAccountId,
            credits_remaining: info.creditsRemaining,
            credits_limit: info.creditsLimit,
        },
    });
}

/**
 * POST /api/integrations/apollo/parse-url
 * Body: { url: string }
 * Parses the URL the user pasted, surfaces a human-readable summary of
 * filters, and runs a 1-record search to estimate the result count.
 * No credits consumed (search-only - credits only flow through
 * bulk_match during the actual import).
 */
export async function parseUrl(req: Request, res: Response): Promise<Response> {
    if (!req.orgContext?.organizationId) {
        return res.status(401).json({ success: false, error: 'Login required' });
    }

    const url = String((req.body ?? {}).url ?? '').trim();
    if (!url) {
        return res.status(400).json({ success: false, error: 'url is required' });
    }

    const filter = parseApolloUrl(url);
    if (!filter) {
        return res.status(400).json({
            success: false,
            error: "We couldn't parse that URL. Make sure it's a copy of an Apollo people-search, saved-search, or saved-list URL.",
        });
    }

    // Need an active connection to call estimateContactCount.
    const conn = await getLeadSourceConnectionByProvider(req.orgContext.organizationId, 'apollo');
    if (!conn) {
        return res.status(409).json({
            success: false,
            error: 'Connect Apollo first.',
        });
    }

    const client = new ApolloLeadSourceClient({ apiKey: conn.apiKey });
    let estimate: number | null = null;
    try {
        estimate = await client.estimateContactCount(filter);
    } catch (err) {
        // Non-fatal - caller can still kick off the import without an estimate.
        logger.warn('[APOLLO] estimate failed', {
            err: (err as Error).message?.slice(0, 200),
        });
    }

    return res.json({
        success: true,
        data: {
            kind: filter.kind,
            summary: summarizeFilter(filter),
            estimated_count: estimate,
            // Echo the parsed structure so the UI can show what we'll send
            parsed: filter,
        },
    });
}

/**
 * POST /api/integrations/apollo/import
 * Body: {
 *   url: string,                       // Apollo URL to replay
 *   target_campaign_id?: string,       // optional: enroll into this campaign
 *   reveal_personal_emails?: boolean,  // default true; consumes credits
 *   cap?: number,                      // hard cap on contacts to import
 * }
 * Returns: { import_job_id }
 */
export async function startImport(req: Request, res: Response): Promise<Response> {
    if (!req.orgContext?.organizationId) {
        return res.status(401).json({ success: false, error: 'Login required' });
    }
    const orgId = req.orgContext.organizationId;

    const conn = await getLeadSourceConnectionByProvider(orgId, 'apollo');
    if (!conn) {
        return res.status(409).json({ success: false, error: 'Connect Apollo first.' });
    }

    const { url, target_campaign_id, reveal_personal_emails, cap } = (req.body ?? {}) as {
        url?: string;
        target_campaign_id?: string;
        reveal_personal_emails?: boolean;
        cap?: number;
    };

    if (!url || typeof url !== 'string') {
        return res.status(400).json({ success: false, error: 'url is required' });
    }

    const filter = parseApolloUrl(url);
    if (!filter) {
        return res.status(400).json({
            success: false,
            error: "We couldn't parse that URL. Make sure it's an Apollo people-search, saved-search, or saved-list URL.",
        });
    }

    // Hard-cap defensive - Apollo's own ceiling is 50K per search
    const safeCap = typeof cap === 'number' && cap > 0 ? Math.min(cap, 50_000) : null;

    const job = await prisma.leadSourceImportJob.create({
        data: {
            lead_source_connection_id: conn.id,
            organization_id: orgId,
            source_url: url,
            parsed_filters: filter as any,
            source_kind: filter.kind,
            source_external_id:
                filter.kind === 'saved_list' ? filter.listId
                    : filter.kind === 'saved_search' ? filter.searchId
                        : null,
            target_campaign_id: target_campaign_id ?? null,
            reveal_personal_emails: reveal_personal_emails ?? true,
            cap: safeCap,
            state: 'pending',
            triggered_by_user_id: req.orgContext.userId ?? null,
        },
    });

    logger.info('[APOLLO] import enqueued', {
        orgId,
        jobId: job.id,
        kind: filter.kind,
        cap: safeCap,
    });

    return res.json({ success: true, data: { import_job_id: job.id } });
}

/**
 * GET /api/integrations/apollo/jobs/:id
 * Returns status + counters so the dashboard can poll for progress.
 */
export async function getJobStatus(req: Request, res: Response): Promise<Response> {
    if (!req.orgContext?.organizationId) {
        return res.status(401).json({ success: false, error: 'Login required' });
    }
    const orgId = req.orgContext.organizationId;
    const id = req.params.id as string;

    const job = await prisma.leadSourceImportJob.findFirst({
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
            target_campaign_id: job.target_campaign_id,
            total_estimated: job.total_estimated,
            total_processed: job.total_processed,
            total_created: job.total_created,
            total_updated: job.total_updated,
            total_skipped: job.total_skipped,
            total_failed: job.total_failed,
            credits_consumed: job.credits_consumed,
            page: job.page,
            started_at: job.started_at ? job.started_at.toISOString() : null,
            finished_at: job.finished_at ? job.finished_at.toISOString() : null,
            error_message: job.error_message,
            created_at: job.created_at.toISOString(),
        },
    });
}
