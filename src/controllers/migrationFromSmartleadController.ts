/**
 * Smartlead one-time-import controller.
 *
 * All routes feature-flagged behind MIGRATION_TOOL_ENABLED so the wizard
 * URL can't be discovered before the team is ready to run real imports.
 *
 * Endpoints:
 *   GET  /api/migration/from-smartlead/feature        - feature flag probe
 *   GET  /api/migration/from-smartlead/key-status     - is a key on file? expiry?
 *   POST /api/migration/from-smartlead/validate-key   - probe key against Smartlead
 *   POST /api/migration/from-smartlead/store-key      - encrypt + persist (72h ceiling)
 *   POST /api/migration/from-smartlead/discard-key    - immediate wipe
 *   POST /api/migration/from-smartlead/preview        - read-only summary
 *   POST /api/migration/from-smartlead/start          - kick off ImportJob (async)
 *   GET  /api/migration/from-smartlead/status         - latest ImportJob progress
 */

import { Request, Response } from 'express';
import { getOrgId } from '../middleware/orgContext';
import { logger } from '../services/observabilityService';
import * as smartlead from '../services/smartleadClient';
import * as importJob from '../services/importJobService';
import * as importer from '../services/smartleadImportService';
import { prisma } from '../index';
import { recordConsentFromRequest } from '../services/consentService';

export const isEnabled = (): boolean => process.env.MIGRATION_TOOL_ENABLED === 'true';

const requireEnabled = (res: Response): boolean => {
    if (!isEnabled()) {
        res.status(404).json({ success: false, error: 'Migration tool is disabled' });
        return false;
    }
    return true;
};

// ─────────────────────────────────────────────────────────────────────────────
// Feature flag + key status (no-op when disabled)
// ─────────────────────────────────────────────────────────────────────────────

export const featureFlag = async (_req: Request, res: Response): Promise<void> => {
    res.json({ enabled: isEnabled() });
};

export const keyStatus = async (req: Request, res: Response): Promise<void> => {
    if (!requireEnabled(res)) return;
    try {
        const orgId = getOrgId(req);
        const status = await importJob.getKeyStatus(orgId);
        res.json({ success: true, ...status });
    } catch (err: any) {
        logger.error('[MIGRATION] keyStatus failed', err);
        res.status(500).json({ success: false, error: err.message || 'keyStatus failed' });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// Key lifecycle
// ─────────────────────────────────────────────────────────────────────────────

export const validateKey = async (req: Request, res: Response): Promise<void> => {
    if (!requireEnabled(res)) return;
    const apiKey: string = (req.body?.apiKey || '').toString().trim();
    if (!apiKey) {
        res.status(400).json({ success: false, error: 'apiKey is required' });
        return;
    }
    try {
        const ok = await smartlead.validateKey(apiKey);
        if (!ok) {
            res.status(401).json({ success: false, error: 'Invalid Smartlead API key' });
            return;
        }
        res.json({ success: true });
    } catch (err: any) {
        // Distinguish infra failure from auth failure — wizard surfaces "Smartlead unavailable".
        logger.error('[MIGRATION] validateKey infra error', err);
        res.status(503).json({
            success: false,
            error: 'Could not reach Smartlead — try again in a few minutes',
        });
    }
};

export const storeKey = async (req: Request, res: Response): Promise<void> => {
    if (!requireEnabled(res)) return;
    const apiKey: string = (req.body?.apiKey || '').toString().trim();
    const platform: string = (req.body?.platform || 'smartlead').toString();
    const acknowledged: boolean = !!req.body?.acknowledged;
    if (!apiKey) {
        res.status(400).json({ success: false, error: 'apiKey is required' });
        return;
    }
    if (platform !== 'smartlead') {
        res.status(400).json({ success: false, error: 'Only smartlead is supported today' });
        return;
    }
    // Required: customer must explicitly authorize Superkabe to act on their
    // behalf with this key (call source-platform APIs, pause campaigns, fetch
    // leads). Recorded as a Consent row for the audit trail.
    if (!acknowledged) {
        res.status(400).json({
            success: false,
            error: 'You must acknowledge that Superkabe will act on your behalf with this API key (pause campaigns, fetch data) before we can store it.',
        });
        return;
    }
    try {
        const orgId = getOrgId(req);
        // Re-validate before storing — never persist a bad key.
        const ok = await smartlead.validateKey(apiKey);
        if (!ok) {
            res.status(401).json({ success: false, error: 'Invalid Smartlead API key' });
            return;
        }
        const { expiresAt } = await importJob.setImportKey(orgId, 'smartlead', apiKey);

        // Record import-key authorization consent for audit.
        try {
            const userId = req.orgContext?.userId || null;
            const user = userId
                ? await prisma.user.findUnique({
                    where: { id: userId },
                    select: { email: true, name: true },
                })
                : null;
            await recordConsentFromRequest(req, {
                consentType: 'import_key',
                documentVersion: 'import_authorization_v1',
                channel: 'wizard_step',
                userId,
                organizationId: orgId,
                userEmailSnapshot: user?.email || null,
                userNameSnapshot: user?.name || null,
                metadata: {
                    platform,
                    expires_at: expiresAt.toISOString(),
                    actions_authorized: ['read_campaigns', 'read_leads', 'read_email_accounts', 'pause_campaigns'],
                },
            });
        } catch (consentErr) {
            logger.error(
                '[MIGRATION] import-key consent record failed — manual remediation required',
                consentErr instanceof Error ? consentErr : new Error(String(consentErr)),
                { orgId },
            );
        }

        res.json({ success: true, expiresAt });
    } catch (err: any) {
        logger.error('[MIGRATION] storeKey failed', err);
        res.status(500).json({ success: false, error: err.message || 'storeKey failed' });
    }
};

export const discardKey = async (req: Request, res: Response): Promise<void> => {
    if (!requireEnabled(res)) return;
    try {
        const orgId = getOrgId(req);
        await importJob.discardKeyNow(orgId, (req as any).user?.id);
        res.json({ success: true });
    } catch (err: any) {
        logger.error('[MIGRATION] discardKey failed', err);
        res.status(500).json({ success: false, error: err.message || 'discardKey failed' });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// Preview + run
// ─────────────────────────────────────────────────────────────────────────────

export const preview = async (req: Request, res: Response): Promise<void> => {
    if (!requireEnabled(res)) return;
    try {
        const orgId = getOrgId(req);
        const data = await importer.previewImport(orgId);
        res.json({ success: true, data });
    } catch (err: any) {
        logger.error('[MIGRATION] preview failed', err);
        res.status(500).json({ success: false, error: err.message || 'preview failed' });
    }
};

export const start = async (req: Request, res: Response): Promise<void> => {
    if (!requireEnabled(res)) return;
    try {
        const orgId = getOrgId(req);

        // Customer-chosen import strategy (read from wizard step 2).
        // Default conservative if missing — never silently aggressive.
        const rawMode = String(req.body?.mode || 'conservative').toLowerCase();
        const mode: 'conservative' | 'aggressive' =
            rawMode === 'aggressive' ? 'aggressive' : 'conservative';
        const includeRecentContacts = !!req.body?.includeRecentContacts && mode === 'aggressive';

        // Guard against concurrent imports — if a job is already running for
        // this org, return its id rather than starting a parallel one.
        const latest = await importJob.getLatestImportJob(orgId);
        if (latest && (latest.status === 'pending' || latest.status === 'running' || latest.status === 'paused_source')) {
            res.json({ success: true, jobId: latest.id, alreadyRunning: true });
            return;
        }

        const job = await importJob.createImportJob(orgId, 'smartlead', {
            mode,
            includeRecentContacts,
        });

        // Fire-and-forget: import runs in the background; client polls /status.
        // Errors are surfaced in ImportJob.error and logged.
        importer.runImport(orgId, job.id).catch(err => {
            logger.error('[MIGRATION] runImport unhandled error', err, { orgId, jobId: job.id });
        });

        res.json({ success: true, jobId: job.id, mode, includeRecentContacts });
    } catch (err: any) {
        logger.error('[MIGRATION] start failed', err);
        res.status(500).json({ success: false, error: err.message || 'start failed' });
    }
};

export const status = async (req: Request, res: Response): Promise<void> => {
    if (!requireEnabled(res)) return;
    try {
        const orgId = getOrgId(req);
        const latest = await importJob.getLatestImportJob(orgId);
        res.json({ success: true, job: latest });
    } catch (err: any) {
        logger.error('[MIGRATION] status failed', err);
        res.status(500).json({ success: false, error: err.message || 'status failed' });
    }
};
