/**
 * Mailbox Import Controller — provider-agnostic bulk import endpoints.
 *
 * Routes (all under /api/sequencer/mailbox-import):
 *   GET  /providers                   — list all providers + status
 *   POST /:provider/connect           — store the customer's API key
 *   POST /:provider/disconnect        — clear the stored API key
 *   GET  /:provider/mailboxes         — list available mailboxes
 *   POST /:provider/import            — bulk-import selected mailboxes
 *
 * Today only the Zapmail provider is fully implemented. The other three
 * (Premium Inboxes, Mission Inbox, Scaled Mail) appear in /providers with
 * isImplemented=false so the frontend can render "Coming soon" entries
 * uniformly. Write operations against unimplemented providers return 501.
 *
 * Storage:
 *   - Zapmail key uses the existing Organization.zapmail_api_key column.
 *   - When the stub providers go live, each gets its own storage column
 *     OR we move all four into a new MailboxImportProviderConnection
 *     table. Deferred until at least two stubs need to ship — premature
 *     abstraction otherwise.
 */

import { Request, Response } from 'express';
import { getOrgId } from '../middleware/orgContext';
import { prisma } from '../index';
import { logger } from '../services/observabilityService';
import { encrypt, decrypt } from '../utils/encryption';
import { getProvider, getAllProviders } from '../services/mailboxImportProviders/registry';
import { runBulkImport } from '../services/mailboxImportService';

/**
 * Read the stored API key for a provider, decrypting if needed. Returns
 * null if no key is stored. Centralizes the per-provider storage lookup.
 */
async function readStoredApiKey(orgId: string, providerKey: string): Promise<string | null> {
    if (providerKey === 'zapmail') {
        const org = await prisma.organization.findUnique({
            where: { id: orgId },
            select: { zapmail_api_key: true },
        });
        if (!org?.zapmail_api_key) return null;
        try {
            return decrypt(org.zapmail_api_key);
        } catch {
            // Legacy plaintext (pre-encryption rollout) — return as-is.
            return org.zapmail_api_key;
        }
    }
    // Stub providers don't have storage yet. When implemented, add a case here.
    return null;
}

async function writeStoredApiKey(orgId: string, providerKey: string, apiKey: string): Promise<void> {
    if (providerKey === 'zapmail') {
        await prisma.organization.update({
            where: { id: orgId },
            data: {
                zapmail_api_key: encrypt(apiKey),
                zapmail_connected_at: new Date(),
            },
        });
        return;
    }
    throw new Error(`Storage not yet wired for provider: ${providerKey}`);
}

async function clearStoredApiKey(orgId: string, providerKey: string): Promise<void> {
    if (providerKey === 'zapmail') {
        await prisma.organization.update({
            where: { id: orgId },
            data: {
                zapmail_api_key: null,
                zapmail_connected_at: null,
            },
        });
        return;
    }
    throw new Error(`Storage not yet wired for provider: ${providerKey}`);
}

/**
 * GET /api/sequencer/mailbox-import/providers
 * Returns the registry contents + per-provider connection state for this org.
 */
export const listProviders = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const providers = getAllProviders();
        const result = await Promise.all(
            providers.map(async p => ({
                key: p.key,
                displayName: p.displayName,
                isImplemented: p.isImplemented,
                connected: !!(await readStoredApiKey(orgId, p.key)),
            })),
        );
        return res.json({ success: true, providers: result });
    } catch (err) {
        logger.error('[MAILBOX_IMPORT] listProviders failed', err instanceof Error ? err : new Error(String(err)));
        return res.status(500).json({ success: false, error: 'Failed to list providers' });
    }
};

/**
 * POST /api/sequencer/mailbox-import/:provider/connect
 * Body: { apiKey: string }
 * Validates the key against the reseller, then stores it encrypted.
 */
export const connectProvider = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const provider = getProvider(String(req.params.provider));
        if (!provider) return res.status(404).json({ success: false, error: 'Unknown provider' });
        if (!provider.isImplemented) {
            return res.status(501).json({
                success: false,
                error: `${provider.displayName} integration is coming soon`,
            });
        }
        const apiKey = typeof req.body?.apiKey === 'string' ? req.body.apiKey.trim() : '';
        if (!apiKey) return res.status(400).json({ success: false, error: 'API key is required' });

        const ok = await provider.validateApiKey(apiKey);
        if (!ok) return res.status(400).json({ success: false, error: 'Invalid API key' });

        await writeStoredApiKey(orgId, provider.key, apiKey);
        logger.info('[MAILBOX_IMPORT] Provider connected', { orgId, provider: provider.key });
        return res.json({ success: true });
    } catch (err) {
        logger.error('[MAILBOX_IMPORT] connect failed', err instanceof Error ? err : new Error(String(err)));
        return res.status(500).json({ success: false, error: err instanceof Error ? err.message : 'Failed to connect' });
    }
};

export const disconnectProvider = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const provider = getProvider(String(req.params.provider));
        if (!provider) return res.status(404).json({ success: false, error: 'Unknown provider' });
        await clearStoredApiKey(orgId, provider.key);
        return res.json({ success: true });
    } catch (err) {
        logger.error('[MAILBOX_IMPORT] disconnect failed', err instanceof Error ? err : new Error(String(err)));
        return res.status(500).json({ success: false, error: err instanceof Error ? err.message : 'Failed to disconnect' });
    }
};

/**
 * GET /api/sequencer/mailbox-import/:provider/mailboxes
 * Lists mailboxes available on the reseller, with their readiness state
 * (those without an app password yet are flagged so the frontend can show
 * "Provisioning" instead of "Available").
 *
 * NEVER returns the actual app passwords or TOTP secrets to the client.
 * The frontend selects by remoteId; the import endpoint pulls credentials
 * server-side again before persisting.
 */
export const listProviderMailboxes = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const provider = getProvider(String(req.params.provider));
        if (!provider) return res.status(404).json({ success: false, error: 'Unknown provider' });
        if (!provider.isImplemented) {
            return res.status(501).json({
                success: false,
                error: `${provider.displayName} integration is coming soon`,
            });
        }
        const apiKey = await readStoredApiKey(orgId, provider.key);
        if (!apiKey) return res.status(400).json({ success: false, error: `${provider.displayName} is not connected` });

        const mailboxes = await provider.listMailboxes(apiKey);

        // Detect already-imported mailboxes so the UI can render checkbox
        // state correctly ("already connected" vs. "available").
        const emails = mailboxes.map(m => m.email);
        const existing = emails.length > 0
            ? await prisma.connectedAccount.findMany({
                where: { organization_id: orgId, email: { in: emails } },
                select: { email: true },
            })
            : [];
        const existingSet = new Set(existing.map(e => e.email));

        // Strip credentials from the response — the frontend doesn't need
        // them and we never want them on the wire more than once.
        return res.json({
            success: true,
            mailboxes: mailboxes.map(m => ({
                remoteId: m.remoteId,
                email: m.email,
                displayName: m.displayName,
                provider: m.provider,
                domain: m.domain,
                ready: !!m.appPassword,
                alreadyImported: existingSet.has(m.email),
                remoteStatus: m.remoteStatus,
                isWarmedUp: m.isWarmedUp,
            })),
        });
    } catch (err) {
        logger.error('[MAILBOX_IMPORT] listMailboxes failed', err instanceof Error ? err : new Error(String(err)));
        return res.status(500).json({ success: false, error: err instanceof Error ? err.message : 'Failed to list mailboxes' });
    }
};

/**
 * POST /api/sequencer/mailbox-import/:provider/import
 * Body: { remoteIds?: string[] }   (omit to import everything)
 *
 * Pulls credentials server-side (never trusts the client), encrypts,
 * upserts ConnectedAccount rows, kicks off provisioning. Returns a
 * per-mailbox result so the UI can show "78 imported, 12 already
 * connected, 10 not ready (no app password yet)".
 */
export const bulkImport = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const provider = getProvider(String(req.params.provider));
        if (!provider) return res.status(404).json({ success: false, error: 'Unknown provider' });
        if (!provider.isImplemented) {
            return res.status(501).json({
                success: false,
                error: `${provider.displayName} integration is coming soon`,
            });
        }
        const apiKey = await readStoredApiKey(orgId, provider.key);
        if (!apiKey) return res.status(400).json({ success: false, error: `${provider.displayName} is not connected` });

        const remoteIds = Array.isArray(req.body?.remoteIds)
            ? (req.body.remoteIds as unknown[]).map(x => String(x))
            : undefined;

        const result = await runBulkImport({
            organizationId: orgId,
            provider,
            apiKey,
            remoteIds,
        });

        logger.info('[MAILBOX_IMPORT] Bulk import complete', {
            orgId,
            provider: provider.key,
            total: result.total,
            imported: result.imported,
            updated: result.updated,
            skipped: result.skipped,
            failed: result.failed,
        });

        return res.json({ success: true, ...result });
    } catch (err) {
        logger.error('[MAILBOX_IMPORT] bulkImport failed', err instanceof Error ? err : new Error(String(err)));
        return res.status(500).json({ success: false, error: err instanceof Error ? err.message : 'Failed to import' });
    }
};
