/**
 * Migration controller — wraps migrationFromSmartleadService.
 *
 * Feature-flag gated. The service can be invoked any time, but the routes
 * are only mounted when MIGRATION_TOOL_ENABLED is set so the wizard URL
 * can't be discovered before you're ready to run it on real customer data.
 */

import { Request, Response } from 'express';
import { getOrgId } from '../middleware/orgContext';
import { logger } from '../services/observabilityService';
import * as svc from '../services/migrationFromSmartleadService';

export const isEnabled = (): boolean => process.env.MIGRATION_TOOL_ENABLED === 'true';

const requireEnabled = (res: Response): boolean => {
    if (!isEnabled()) {
        res.status(404).json({ success: false, error: 'Migration tool is disabled' });
        return false;
    }
    return true;
};

export const previewMigration = async (req: Request, res: Response) => {
    if (!requireEnabled(res)) return;
    try {
        const orgId = getOrgId(req);
        const data = await svc.preview(orgId);
        res.json({ success: true, data });
    } catch (err: any) {
        logger.error('[MIGRATION] preview failed', err);
        res.status(500).json({ success: false, error: err.message || 'Preview failed' });
    }
};

export const connectMailbox = async (req: Request, res: Response) => {
    if (!requireEnabled(res)) return;
    try {
        const orgId = getOrgId(req);
        const result = await svc.connectMailbox(orgId, req.body || {});
        if (!result.success) return res.status(400).json(result);
        res.json(result);
    } catch (err: any) {
        logger.error('[MIGRATION] connectMailbox failed', err);
        res.status(500).json({ success: false, error: err.message || 'Connect failed' });
    }
};

export const finalizeCampaign = async (req: Request, res: Response) => {
    if (!requireEnabled(res)) return;
    try {
        const orgId = getOrgId(req);
        const result = await svc.finalizeCampaign(orgId, req.body || {});
        if (!result.success) return res.status(400).json(result);
        res.json(result);
    } catch (err: any) {
        logger.error('[MIGRATION] finalizeCampaign failed', err);
        res.status(500).json({ success: false, error: err.message || 'Finalize failed' });
    }
};

export const finalizeOrg = async (req: Request, res: Response) => {
    if (!requireEnabled(res)) return;
    try {
        const orgId = getOrgId(req);
        const summary = await svc.finalizeOrg(orgId);
        res.json({ success: true, summary });
    } catch (err: any) {
        logger.error('[MIGRATION] finalizeOrg failed', err);
        res.status(500).json({ success: false, error: err.message || 'Finalize failed' });
    }
};

/** GET /api/migration/from-smartlead/feature — returns whether the tool is on. */
export const featureFlag = async (_req: Request, res: Response) => {
    res.json({ enabled: isEnabled() });
};
