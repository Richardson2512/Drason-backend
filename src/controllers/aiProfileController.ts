/**
 * AI Profile Controller
 *
 * Manages the organization's cached BusinessProfile — the context every
 * copy-generation call feeds into OpenAI. One profile per org.
 */

import { Request, Response } from 'express';
import { prisma } from '../index';
import { logger } from '../services/observabilityService';
import { getOrgId } from '../middleware/orgContext';
import {
    extractAndCacheProfile,
    getCachedProfile,
    getConfiguredModel,
    patchCachedProfile,
    ProfilePatchError,
    type BusinessProfileV1,
} from '../services/aiCopywritingService';
import { enqueueExtraction, getJobStatus } from '../services/aiProfileExtractionQueue';
import { getOpenAIStats } from '../services/openaiClient';

const MAX_URLS_PER_PROFILE = 5;

// ────────────────────────────────────────────────────────────────────
// GET /api/ai/profile
// ────────────────────────────────────────────────────────────────────

export const getProfile = async (req: Request, res: Response): Promise<Response> => {
    const orgId = getOrgId(req);
    try {
        const row = await prisma.businessProfile.findUnique({ where: { organization_id: orgId } });
        if (!row) {
            return res.status(404).json({ success: false, error: 'No business profile yet. POST /api/ai/profile to create one.' });
        }
        return res.json({
            success: true,
            data: {
                source_url: row.source_url,
                profile: row.profile_json,
                extracted_at: row.extracted_at,
                updated_at: row.updated_at,
                model_used: row.model_used,
                scraped_chars: row.scraped_chars,
            },
        });
    } catch (err) {
        logger.error('[AI_PROFILE] getProfile failed', err instanceof Error ? err : new Error(String(err)));
        return res.status(500).json({ success: false, error: 'Failed to load profile' });
    }
};

// ────────────────────────────────────────────────────────────────────
// POST /api/ai/profile  { url } or { urls: string[] }
//
// Create (or re-create) the profile from one OR multiple URLs. The
// extractor synthesizes across all sources (homepage + pricing +
// case-study, etc.). Single-URL form is kept for back-compat.
// ────────────────────────────────────────────────────────────────────

const urlRegex = /^https?:\/\/[^\s/$.?#].[^\s]*$/i;

function normalizeUrl(raw: string): string | null {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const withScheme = trimmed.startsWith('http') ? trimmed : `https://${trimmed}`;
    return urlRegex.test(withScheme) ? withScheme : null;
}

export const createProfile = async (req: Request, res: Response): Promise<Response> => {
    const orgId = getOrgId(req);
    const body = req.body || {};

    // Accept either { url } (legacy) or { urls: [] } (multi-source).
    const rawList: unknown[] =
        Array.isArray(body.urls) ? body.urls :
        typeof body.url === 'string' ? [body.url] :
        [];

    if (rawList.length === 0) {
        return res.status(400).json({ success: false, error: 'url or urls[] is required' });
    }
    if (rawList.length > MAX_URLS_PER_PROFILE) {
        return res.status(400).json({ success: false, error: `At most ${MAX_URLS_PER_PROFILE} URLs per profile` });
    }

    const normalized: string[] = [];
    for (const u of rawList) {
        if (typeof u !== 'string') {
            return res.status(400).json({ success: false, error: 'Each entry in urls[] must be a string' });
        }
        const n = normalizeUrl(u);
        if (!n) {
            return res.status(400).json({ success: false, error: `Invalid URL: ${u}` });
        }
        normalized.push(n);
    }
    // Dedup while preserving order (the first URL still wins source_url).
    const deduped = Array.from(new Set(normalized));

    try {
        const profile = await extractAndCacheProfile(orgId, deduped);
        return res.status(201).json({
            success: true,
            data: {
                source_url: deduped[0],
                source_urls: deduped,
                profile,
                model_used: getConfiguredModel(),
            },
        });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error('[AI_PROFILE] createProfile failed', err instanceof Error ? err : new Error(msg), { orgId, urls: deduped });
        // Surface the real failure reason to the UI so the user can act on it
        const userFacing =
            msg.includes('OPENAI_API_KEY') ? 'AI is not configured on this server. Contact an admin.' :
            msg.includes('Jina Reader') || msg.includes('No source URL was reachable') ? 'We could not read those URLs. Check them and try again.' :
            msg.includes('invalid JSON') ? 'AI returned an unparseable profile. Try again.' :
            'Failed to build profile';
        return res.status(502).json({ success: false, error: userFacing });
    }
};

// ────────────────────────────────────────────────────────────────────
// POST /api/ai/profile/jobs  { url } or { urls: string[] }
//
// Async variant of createProfile. Validates the URL list, enqueues a
// BullMQ extraction job, returns 202 with the job id. Frontend polls
// GET /api/ai/profile/jobs/:id until state is 'completed' or 'failed'.
//
// Same dedup semantics as the queue: if there's already an active job
// for this org, the existing job id is returned (no duplicate work).
// ────────────────────────────────────────────────────────────────────

export const queueProfile = async (req: Request, res: Response): Promise<Response> => {
    const orgId = getOrgId(req);
    const body = req.body || {};

    const rawList: unknown[] =
        Array.isArray(body.urls) ? body.urls :
        typeof body.url === 'string' ? [body.url] :
        [];

    if (rawList.length === 0) {
        return res.status(400).json({ success: false, error: 'url or urls[] is required' });
    }
    if (rawList.length > MAX_URLS_PER_PROFILE) {
        return res.status(400).json({ success: false, error: `At most ${MAX_URLS_PER_PROFILE} URLs per profile` });
    }

    const normalized: string[] = [];
    for (const u of rawList) {
        if (typeof u !== 'string') {
            return res.status(400).json({ success: false, error: 'Each entry in urls[] must be a string' });
        }
        const n = normalizeUrl(u);
        if (!n) {
            return res.status(400).json({ success: false, error: `Invalid URL: ${u}` });
        }
        normalized.push(n);
    }
    const deduped = Array.from(new Set(normalized));

    try {
        const jobId = await enqueueExtraction({ organizationId: orgId, urls: deduped });
        return res.status(202).json({
            success: true,
            data: {
                job_id: jobId,
                source_urls: deduped,
                status_url: `/api/ai/profile/jobs/${jobId}`,
            },
        });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error('[AI_PROFILE] queueProfile failed', err instanceof Error ? err : new Error(msg));
        const userFacing = msg.includes('REDIS_URL') ? 'Async extraction is unavailable on this server (no Redis).' : 'Failed to queue extraction';
        return res.status(503).json({ success: false, error: userFacing });
    }
};

// ────────────────────────────────────────────────────────────────────
// GET /api/ai/profile/jobs/:id
//
// Org-scoped status read. Returns 404 if the job id doesn't exist OR
// belongs to another org (intentionally indistinguishable to avoid
// leaking job-id space across tenants).
// ────────────────────────────────────────────────────────────────────

export const getProfileJob = async (req: Request, res: Response): Promise<Response> => {
    const orgId = getOrgId(req);
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ success: false, error: 'Job id required' });

    try {
        const status = await getJobStatus(id, orgId);
        if (!status) return res.status(404).json({ success: false, error: 'Job not found' });
        return res.json({ success: true, data: status });
    } catch (err) {
        logger.error('[AI_PROFILE] getProfileJob failed', err instanceof Error ? err : new Error(String(err)));
        return res.status(500).json({ success: false, error: 'Failed to read job status' });
    }
};

// ────────────────────────────────────────────────────────────────────
// PATCH /api/ai/profile  { ...partial BusinessProfileV1 }
//
// Manual edit. Accept any subset of {company, offering, icp, value_prop,
// voice, sample_openers}; deep-merge into the cached row. Lets the
// operator refine fields the AI got wrong without re-scraping.
// ────────────────────────────────────────────────────────────────────

export const patchProfile = async (req: Request, res: Response): Promise<Response> => {
    const orgId = getOrgId(req);
    const patch = (req.body || {}) as Partial<BusinessProfileV1>;
    try {
        const merged = await patchCachedProfile(orgId, patch);
        return res.json({ success: true, data: { profile: merged } });
    } catch (err) {
        if (err instanceof ProfilePatchError) {
            return res.status(400).json({ success: false, error: err.message });
        }
        logger.error('[AI_PROFILE] patchProfile failed', err instanceof Error ? err : new Error(String(err)));
        return res.status(500).json({ success: false, error: 'Failed to patch profile' });
    }
};

// ────────────────────────────────────────────────────────────────────
// POST /api/ai/profile/refresh
// Re-scrape and re-extract, reusing the current source_url.
// ────────────────────────────────────────────────────────────────────

export const refreshProfile = async (req: Request, res: Response): Promise<Response> => {
    const orgId = getOrgId(req);
    try {
        const existing = await prisma.businessProfile.findUnique({ where: { organization_id: orgId } });
        if (!existing) {
            return res.status(404).json({ success: false, error: 'No profile to refresh. Create one first.' });
        }
        const profile = await extractAndCacheProfile(orgId, existing.source_url);
        return res.json({ success: true, data: { source_url: existing.source_url, profile } });
    } catch (err) {
        logger.error('[AI_PROFILE] refreshProfile failed', err instanceof Error ? err : new Error(String(err)));
        return res.status(502).json({ success: false, error: 'Failed to refresh profile' });
    }
};

// ────────────────────────────────────────────────────────────────────
// DELETE /api/ai/profile
// ────────────────────────────────────────────────────────────────────

export const deleteProfile = async (req: Request, res: Response): Promise<Response> => {
    const orgId = getOrgId(req);
    try {
        await prisma.businessProfile.deleteMany({ where: { organization_id: orgId } });
        return res.json({ success: true });
    } catch (err) {
        logger.error('[AI_PROFILE] deleteProfile failed', err instanceof Error ? err : new Error(String(err)));
        return res.status(500).json({ success: false, error: 'Failed to delete profile' });
    }
};

// ────────────────────────────────────────────────────────────────────
// GET /api/ai/status
//
// Diagnostic endpoint — returns whether OPENAI_API_KEY is configured and
// which model is currently active. Not currently consumed by any UI; kept
// available for ops debugging (curl from Railway shell, runbooks, future
// admin/health surface). Cheap to leave in place — leaks no secrets.
//
// Audit trail: 2026-04-30 audit verified no FE caller; intentionally retained
// per ops-runbook usage pattern.
// ────────────────────────────────────────────────────────────────────

export const getStatus = async (_req: Request, res: Response): Promise<Response> => {
    const configured = Boolean(process.env.OPENAI_API_KEY);
    const concurrency = getOpenAIStats();
    return res.json({
        success: true,
        data: {
            configured,
            model: getConfiguredModel(),
            redis: Boolean(process.env.REDIS_URL),
            concurrency, // { inFlight, waiting, maxConcurrent }
        },
    });
};
