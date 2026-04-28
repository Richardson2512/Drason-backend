/**
 * Instantly one-time-import controller.
 *
 * Same shape and feature-flag wiring as the Smartlead controller — both flows
 * gate on MIGRATION_TOOL_ENABLED so they roll out together. Per-platform
 * specifics:
 *   • Key validation calls `GET /api/v2/workspaces/current` (Instantly's
 *     canonical whoami). 401/403 → invalid key, 402 → workspace plan
 *     inactive, network → upstream-unavailable.
 *   • Acknowledgement copy calls out the disconnected-mailbox UX up front so
 *     the customer doesn't expect Instantly mailboxes to start sending the
 *     moment they finish the import.
 *
 * Endpoints:
 *   GET  /api/migration/from-instantly/feature        - feature flag probe
 *   GET  /api/migration/from-instantly/key-status     - is a key on file?
 *   POST /api/migration/from-instantly/validate-key   - probe key vs Instantly
 *   POST /api/migration/from-instantly/store-key      - encrypt + persist
 *   POST /api/migration/from-instantly/discard-key    - immediate wipe
 *   POST /api/migration/from-instantly/preview        - read-only summary
 *   POST /api/migration/from-instantly/start          - kick off ImportJob
 *   GET  /api/migration/from-instantly/status         - latest ImportJob progress
 */

import { Request, Response } from 'express';
import { getOrgId } from '../middleware/orgContext';
import { logger } from '../services/observabilityService';
import * as instantly from '../services/instantlyClient';
import { InstantlyAuthError, InstantlyPaymentRequiredError } from '../services/instantlyClient';
import * as importJob from '../services/importJobService';
import * as importer from '../services/instantlyImportService';
import { prisma } from '../index';
import { recordConsentFromRequest } from '../services/consentService';

const isEnabled = (): boolean => process.env.MIGRATION_TOOL_ENABLED === 'true';

const requireEnabled = (res: Response): boolean => {
    if (!isEnabled()) {
        res.status(404).json({ success: false, error: 'Migration tool is disabled' });
        return false;
    }
    return true;
};

// ─────────────────────────────────────────────────────────────────────────────
// Feature flag + key status
// ─────────────────────────────────────────────────────────────────────────────

export const featureFlag = async (_req: Request, res: Response): Promise<void> => {
    res.json({ enabled: isEnabled() });
};

export const keyStatus = async (req: Request, res: Response): Promise<void> => {
    if (!requireEnabled(res)) return;
    try {
        const orgId = getOrgId(req);
        const status = await importJob.getKeyStatus(orgId);
        // Only surface as "connected" if the key on file is FOR Instantly —
        // a Smartlead key in the same column shouldn't make this wizard
        // think it has a key.
        const isOurs = status.connected && status.platform === 'instantly';
        res.json({
            success: true,
            connected: isOurs,
            platform: isOurs ? status.platform : null,
            expiresAt: isOurs ? status.expiresAt : null,
            minutesRemaining: isOurs ? status.minutesRemaining : null,
        });
    } catch (err: any) {
        logger.error('[MIGRATION-INSTANTLY] keyStatus failed', err);
        res.status(500).json({ success: false, error: err.message || 'keyStatus failed' });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// Key lifecycle
// ─────────────────────────────────────────────────────────────────────────────

const probeKey = async (apiKey: string): Promise<{ ok: true; workspaceId: string; workspaceName: string } | { ok: false; status: number; error: string }> => {
    try {
        const ws = await instantly.getCurrentWorkspace(apiKey);
        return { ok: true, workspaceId: ws.id, workspaceName: ws.name };
    } catch (err: any) {
        if (err instanceof InstantlyAuthError) {
            return { ok: false, status: 401, error: 'Invalid Instantly API key' };
        }
        if (err instanceof InstantlyPaymentRequiredError) {
            return { ok: false, status: 402, error: err.message };
        }
        // Network / 5xx — distinguish from auth so the wizard can render
        // "Instantly is unreachable, retry" instead of "your key is bad".
        throw err;
    }
};

export const validateKey = async (req: Request, res: Response): Promise<void> => {
    if (!requireEnabled(res)) return;
    const apiKey: string = (req.body?.apiKey || '').toString().trim();
    if (!apiKey) {
        res.status(400).json({ success: false, error: 'apiKey is required' });
        return;
    }
    try {
        const probe = await probeKey(apiKey);
        if (!probe.ok) {
            res.status(probe.status).json({ success: false, error: probe.error });
            return;
        }
        res.json({ success: true, workspace: { id: probe.workspaceId, name: probe.workspaceName } });
    } catch (err: any) {
        logger.error('[MIGRATION-INSTANTLY] validateKey infra error', err);
        res.status(503).json({
            success: false,
            error: 'Could not reach Instantly — try again in a few minutes',
        });
    }
};

export const storeKey = async (req: Request, res: Response): Promise<void> => {
    if (!requireEnabled(res)) return;
    const apiKey: string = (req.body?.apiKey || '').toString().trim();
    const acknowledged: boolean = !!req.body?.acknowledged;
    if (!apiKey) {
        res.status(400).json({ success: false, error: 'apiKey is required' });
        return;
    }
    if (!acknowledged) {
        res.status(400).json({
            success: false,
            error: 'You must acknowledge that Superkabe will read campaigns, leads, and mailbox metadata from your Instantly workspace, and that imported mailboxes will land disconnected and need re-authentication.',
        });
        return;
    }
    try {
        const orgId = getOrgId(req);
        // Re-probe before persisting — never store a bad key.
        const probe = await probeKey(apiKey);
        if (!probe.ok) {
            res.status(probe.status).json({ success: false, error: probe.error });
            return;
        }
        const { expiresAt } = await importJob.setImportKey(orgId, 'instantly', apiKey);

        // Audit-trail consent row.
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
                    platform: 'instantly',
                    workspace_id: probe.workspaceId,
                    workspace_name: probe.workspaceName,
                    expires_at: expiresAt.toISOString(),
                    actions_authorized: [
                        'read_workspaces',
                        'read_campaigns',
                        'read_leads',
                        'read_accounts',
                        'read_blocklist',
                        'read_custom_tags',
                        'read_lead_labels',
                    ],
                },
            });
        } catch (consentErr) {
            logger.error(
                '[MIGRATION-INSTANTLY] import-key consent record failed — manual remediation required',
                consentErr instanceof Error ? consentErr : new Error(String(consentErr)),
                { orgId },
            );
        }

        res.json({
            success: true,
            expiresAt,
            workspace: { id: probe.workspaceId, name: probe.workspaceName },
        });
    } catch (err: any) {
        logger.error('[MIGRATION-INSTANTLY] storeKey failed', err);
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
        logger.error('[MIGRATION-INSTANTLY] discardKey failed', err);
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
        // Typed errors map to user-actionable status codes so the wizard
        // renders the right copy instead of a generic 500.
        if (err instanceof InstantlyAuthError) {
            res.status(401).json({ success: false, error: err.message });
            return;
        }
        if (err instanceof InstantlyPaymentRequiredError) {
            res.status(402).json({ success: false, error: err.message });
            return;
        }
        logger.error('[MIGRATION-INSTANTLY] preview failed', err);
        res.status(500).json({ success: false, error: err.message || 'preview failed' });
    }
};

export const start = async (req: Request, res: Response): Promise<void> => {
    if (!requireEnabled(res)) return;
    try {
        const orgId = getOrgId(req);

        const rawMode = String(req.body?.mode || 'conservative').toLowerCase();
        const mode: 'conservative' | 'aggressive' =
            rawMode === 'aggressive' ? 'aggressive' : 'conservative';
        const includeRecentContacts = !!req.body?.includeRecentContacts && mode === 'aggressive';

        // Concurrent-import guard — return the in-flight job rather than
        // starting a parallel one for the same org.
        const latest = await importJob.getLatestImportJob(orgId);
        if (latest && (latest.status === 'pending' || latest.status === 'running' || latest.status === 'paused_source')) {
            res.json({ success: true, jobId: latest.id, alreadyRunning: true });
            return;
        }

        const job = await importJob.createImportJob(orgId, 'instantly', {
            mode,
            includeRecentContacts,
        });

        // Fire-and-forget: client polls /status.
        importer.runImport(orgId, job.id).catch(err => {
            logger.error('[MIGRATION-INSTANTLY] runImport unhandled error', err, { orgId, jobId: job.id });
        });

        res.json({ success: true, jobId: job.id, mode, includeRecentContacts });
    } catch (err: any) {
        logger.error('[MIGRATION-INSTANTLY] start failed', err);
        res.status(500).json({ success: false, error: err.message || 'start failed' });
    }
};

export const status = async (req: Request, res: Response): Promise<void> => {
    if (!requireEnabled(res)) return;
    try {
        const orgId = getOrgId(req);
        const latest = await importJob.getLatestImportJob(orgId);
        // Only show Instantly jobs through this controller — running a Smartlead
        // job shouldn't surface here as if it were ours.
        const job = latest && latest.platform === 'instantly' ? latest : null;
        res.json({ success: true, job });
    } catch (err: any) {
        logger.error('[MIGRATION-INSTANTLY] status failed', err);
        res.status(500).json({ success: false, error: err.message || 'status failed' });
    }
};
