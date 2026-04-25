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
} from '../services/aiCopywritingService';

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
// POST /api/ai/profile  { url }
// Create (or re-create) the profile from a URL.
// ────────────────────────────────────────────────────────────────────

const urlRegex = /^https?:\/\/[^\s/$.?#].[^\s]*$/i;

export const createProfile = async (req: Request, res: Response): Promise<Response> => {
    const orgId = getOrgId(req);
    const { url } = req.body || {};

    if (!url || typeof url !== 'string') {
        return res.status(400).json({ success: false, error: 'url is required' });
    }
    const normalized = url.startsWith('http') ? url : `https://${url}`;
    if (!urlRegex.test(normalized)) {
        return res.status(400).json({ success: false, error: 'url is not a valid http(s) URL' });
    }

    try {
        const profile = await extractAndCacheProfile(orgId, normalized);
        return res.status(201).json({
            success: true,
            data: {
                source_url: normalized,
                profile,
                model_used: getConfiguredModel(),
            },
        });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error('[AI_PROFILE] createProfile failed', err instanceof Error ? err : new Error(msg), { orgId, url: normalized });
        // Surface the real failure reason to the UI so the user can act on it
        const userFacing =
            msg.includes('OPENAI_API_KEY') ? 'AI is not configured on this server. Contact an admin.' :
            msg.includes('Jina Reader') ? 'We could not read that website. Check the URL and try again.' :
            msg.includes('invalid JSON') ? 'AI returned an unparseable profile. Try again.' :
            'Failed to build profile';
        return res.status(502).json({ success: false, error: userFacing });
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
// Quick "is AI configured & reachable" probe for the UI.
// ────────────────────────────────────────────────────────────────────

export const getStatus = async (_req: Request, res: Response): Promise<Response> => {
    const configured = Boolean(process.env.OPENAI_API_KEY);
    return res.json({
        success: true,
        data: { configured, model: getConfiguredModel() },
    });
};
