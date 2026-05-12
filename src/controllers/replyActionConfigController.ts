/**
 * Reply-action configuration — read + write the org's mapping from
 * reply quality classes to automatic actions. See replyActionService for
 * the action kinds and the auto-applied defaults.
 */

import { Request, Response } from 'express';
import { getOrgId } from '../middleware/orgContext';
import { listRules, upsertRule } from '../services/replyActionService';
import { logger } from '../services/observabilityService';

const VALID_CLASSES = ['positive', 'qualified', 'objection', 'referral', 'soft_no', 'hard_no', 'angry', 'auto', 'unclassified'];
const VALID_ACTIONS = ['suppress', 'pause_lead', 'alert'];

export const getRules = async (req: Request, res: Response): Promise<Response> => {
    const orgId = getOrgId(req);
    try {
        const rules = await listRules(orgId);
        return res.json({ success: true, data: rules });
    } catch (err) {
        logger.error('[REPLY_ACTIONS] list failed', err instanceof Error ? err : new Error(String(err)));
        return res.status(500).json({ success: false, error: 'Failed to load rules' });
    }
};

export const putRule = async (req: Request, res: Response): Promise<Response> => {
    const orgId = getOrgId(req);
    const body = req.body || {};
    const replyClass = String(body.reply_class || '').toLowerCase();
    const actionKind = String(body.action_kind || '').toLowerCase();
    const enabled = Boolean(body.enabled);

    if (!VALID_CLASSES.includes(replyClass)) {
        return res.status(400).json({ success: false, error: `reply_class must be one of ${VALID_CLASSES.join(', ')}` });
    }
    if (!VALID_ACTIONS.includes(actionKind)) {
        return res.status(400).json({ success: false, error: `action_kind must be one of ${VALID_ACTIONS.join(', ')}` });
    }

    try {
        await upsertRule({ organizationId: orgId, replyClass, actionKind, enabled });
        return res.json({ success: true });
    } catch (err) {
        logger.error('[REPLY_ACTIONS] upsert failed', err instanceof Error ? err : new Error(String(err)));
        return res.status(500).json({ success: false, error: 'Failed to save rule' });
    }
};
