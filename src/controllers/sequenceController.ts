/**
 * Sequence controller — REST surface for saved sequences + AI generator.
 *
 *   GET    /api/sequencer/sequences             — list all (light shape)
 *   GET    /api/sequencer/sequences/:id         — full shape (with steps)
 *   POST   /api/sequencer/sequences             — create from hand-authored steps
 *   PATCH  /api/sequencer/sequences/:id         — update (steps replace-all)
 *   DELETE /api/sequencer/sequences/:id
 *   POST   /api/sequencer/sequences/:id/duplicate
 *   POST   /api/sequencer/sequences/generate    — AI-assisted draft (returns
 *                                                 result without persisting;
 *                                                 the UI POSTs the result to
 *                                                 /sequences if the user keeps it)
 */

import { Request, Response } from 'express';
import { getOrgId } from '../middleware/orgContext';
import { logger } from '../services/observabilityService';
import {
    listSequences, getSequence, createSequence, updateSequence,
    deleteSequence, duplicateSequence, generateSequenceWithAi,
} from '../services/sequenceService';

export const list = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const data = await listSequences(orgId);
        return res.json({ success: true, data });
    } catch (err) {
        logger.error('[SEQUENCES] list failed', err instanceof Error ? err : new Error(String(err)));
        return res.status(500).json({ success: false, error: 'Failed to list sequences' });
    }
};

export const get = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const data = await getSequence(orgId, String(req.params.id));
        if (!data) return res.status(404).json({ success: false, error: 'Sequence not found' });
        return res.json({ success: true, data });
    } catch (err) {
        logger.error('[SEQUENCES] get failed', err instanceof Error ? err : new Error(String(err)));
        return res.status(500).json({ success: false, error: 'Failed to load sequence' });
    }
};

export const create = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const data = await createSequence(orgId, req.body || {});
        return res.status(201).json({ success: true, data });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return res.status(400).json({ success: false, error: msg });
    }
};

export const update = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const data = await updateSequence(orgId, String(req.params.id), req.body || {});
        if (!data) return res.status(404).json({ success: false, error: 'Sequence not found' });
        return res.json({ success: true, data });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return res.status(400).json({ success: false, error: msg });
    }
};

export const remove = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const ok = await deleteSequence(orgId, String(req.params.id));
        if (!ok) return res.status(404).json({ success: false, error: 'Sequence not found' });
        return res.json({ success: true });
    } catch (err) {
        logger.error('[SEQUENCES] delete failed', err instanceof Error ? err : new Error(String(err)));
        return res.status(500).json({ success: false, error: 'Failed to delete sequence' });
    }
};

export const duplicate = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const data = await duplicateSequence(orgId, String(req.params.id));
        if (!data) return res.status(404).json({ success: false, error: 'Sequence not found' });
        return res.status(201).json({ success: true, data });
    } catch (err) {
        logger.error('[SEQUENCES] duplicate failed', err instanceof Error ? err : new Error(String(err)));
        return res.status(500).json({ success: false, error: 'Failed to duplicate sequence' });
    }
};

export const generate = async (req: Request, res: Response): Promise<Response> => {
    try {
        // Tier check — gate the AI generator behind the same eligibility
        // as Super Sender so trial users don't burn Gemini budget on it.
        const body = req.body || {};
        const urls = Array.isArray(body.urls) ? body.urls.filter((u: unknown) => typeof u === 'string') : [];
        const customInstructions = typeof body.customInstructions === 'string' ? body.customInstructions : '';
        const stepCount = typeof body.stepCount === 'number' ? body.stepCount : 3;
        const tone = ['casual', 'neutral', 'professional', 'direct'].includes(body.tone) ? body.tone : 'neutral';
        const audience = typeof body.audience === 'string' ? body.audience : undefined;

        const result = await generateSequenceWithAi({ urls, customInstructions, stepCount, tone, audience });
        return res.json({ success: true, data: result });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn('[SEQUENCES] generate failed', { err: msg });
        return res.status(400).json({ success: false, error: msg });
    }
};
