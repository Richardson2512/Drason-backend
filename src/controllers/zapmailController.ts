/**
 * Zapmail integration controller — server-orchestrated OAuth flow.
 *
 * Endpoints (all under /api/sequencer/integrations/zapmail):
 *
 *   POST   /connect             — save API key (validated against /v2/users)
 *   DELETE /connect             — clear stored key
 *   GET    /status              — { connected, connectedAt }
 *   GET    /mailboxes           — list both Google + Microsoft mailboxes from Zapmail,
 *                                 annotated with alreadyImported / connectionStatus
 *   POST   /import              — kick off Custom OAuth orchestration via Zapmail.
 *                                 Pre-creates ConnectedAccount rows in oauth_pending,
 *                                 calls /v2/domains/add-client-id (Google), then
 *                                 /v2/mailboxes/custom-oauth. Returns exportId.
 *   GET    /import/:exportId    — proxy /v2/exports/status for progress polling.
 *
 * Token landing: Zapmail walks our standard Google/Microsoft consent URL on the
 * mailbox side. The auth code lands at our existing OAuth callback, which
 * upserts the ConnectedAccount keyed on (organization_id, email). The
 * pre-created oauth_pending row is updated to `active` automatically.
 */

import { Request, Response } from 'express';
import { getOrgId } from '../middleware/orgContext';
import { prisma } from '../index';
import { logger } from '../services/observabilityService';
import { encrypt, decrypt } from '../utils/encryption';
import { getSequencerSettings } from '../services/sequencerSettingsService';
import { provisionMailboxForConnectedAccount } from '../services/mailboxProvisioningService';
import { TIER_LIMITS } from '../services/polarClient';
import {
    validateZapmailKey,
    listAllMailboxes,
    addGoogleClientIdToDomains,
    triggerCustomOAuth,
    getExportStatus,
    type ZapmailMailbox,
    type CustomOAuthMailboxEntry,
} from '../services/zapmailService';
import { getGoogleAuthorizationUrl } from '../services/gmailSendService';
import { getMicrosoftAuthorizationUrl } from '../services/microsoftSendService';

const MAX_IMPORT = 200;

// The `app` field Zapmail uses to identify our partner integration. Zapmail's
// docs don't enumerate accepted values for the add-client-id endpoint — open
// question to support. Until confirmed we send a stable identifier.
const SUPERKABE_APP_NAME = process.env.ZAPMAIL_APP_NAME || 'SUPERKABE';

async function loadOrgKey(orgId: string): Promise<string | null> {
    const org = await prisma.organization.findUnique({
        where: { id: orgId },
        select: { zapmail_api_key: true },
    });
    if (!org?.zapmail_api_key) return null;
    try {
        return decrypt(org.zapmail_api_key);
    } catch (err) {
        logger.error('[ZAPMAIL] Failed to decrypt stored API key', err instanceof Error ? err : new Error(String(err)));
        return null;
    }
}

// ─── Connection management ───────────────────────────────────────────────────

export const connect = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const apiKey = String(req.body?.apiKey || '').trim();
        if (!apiKey) {
            return res.status(400).json({ success: false, error: 'apiKey is required' });
        }

        await validateZapmailKey(apiKey);

        await prisma.organization.update({
            where: { id: orgId },
            data: {
                zapmail_api_key: encrypt(apiKey),
                zapmail_connected_at: new Date(),
            },
        });

        logger.info(`[ZAPMAIL] Connected for org ${orgId}`);
        return res.status(200).json({ success: true, data: { connected: true } });
    } catch (err: unknown) {
        const e = err as { message?: string };
        return res.status(400).json({ success: false, error: e?.message || 'Failed to connect to Zapmail' });
    }
};

export const disconnect = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        await prisma.organization.update({
            where: { id: orgId },
            data: { zapmail_api_key: null, zapmail_connected_at: null },
        });
        return res.status(200).json({ success: true, data: { connected: false } });
    } catch (err: unknown) {
        const e = err as { message?: string };
        return res.status(500).json({ success: false, error: e?.message || 'Failed to disconnect' });
    }
};

export const status = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const org = await prisma.organization.findUnique({
            where: { id: orgId },
            select: { zapmail_api_key: true, zapmail_connected_at: true },
        });
        return res.status(200).json({
            success: true,
            data: {
                connected: Boolean(org?.zapmail_api_key),
                connectedAt: org?.zapmail_connected_at || null,
            },
        });
    } catch (err: unknown) {
        const e = err as { message?: string };
        return res.status(500).json({ success: false, error: e?.message || 'Failed to fetch status' });
    }
};

// ─── Mailbox listing ─────────────────────────────────────────────────────────

export const listMailboxes = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const apiKey = await loadOrgKey(orgId);
        if (!apiKey) {
            return res.status(400).json({ success: false, error: 'Zapmail is not connected. Add your API key first.' });
        }

        const { mailboxes, errors } = await listAllMailboxes(apiKey);

        // Annotate each row with whether it's already imported into this org
        const emails = mailboxes.map((m) => m.email);
        const existing = await prisma.connectedAccount.findMany({
            where: { organization_id: orgId, email: { in: emails } },
            select: { email: true, connection_status: true },
        });
        const existingMap = new Map(existing.map((e) => [e.email, e.connection_status]));

        const annotated = mailboxes.map((m) => ({
            ...m,
            alreadyImported: existingMap.has(m.email),
            connectionStatus: existingMap.get(m.email) || null,
        }));

        return res.status(200).json({
            success: true,
            data: {
                mailboxes: annotated,
                total: annotated.length,
                errors, // surface per-provider failures so UI can show "Microsoft failed: …"
            },
        });
    } catch (err: unknown) {
        const e = err as { message?: string };
        return res.status(400).json({ success: false, error: e?.message || 'Failed to list Zapmail mailboxes' });
    }
};

// ─── Import + Custom OAuth orchestration ─────────────────────────────────────

interface ImportRowResult {
    email: string;
    status: 'queued' | 'skipped' | 'failed';
    accountId?: string;
    provider?: string;
    error_code?: string;
    error_message?: string;
}

export const importMailboxes = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const requestedEmails: string[] = Array.isArray(req.body?.emails)
            ? req.body.emails.map((e: unknown) => String(e).trim().toLowerCase()).filter(Boolean)
            : [];

        if (requestedEmails.length === 0) {
            return res.status(400).json({ success: false, error: 'emails array is required' });
        }
        if (requestedEmails.length > MAX_IMPORT) {
            return res.status(413).json({ success: false, error: `Max ${MAX_IMPORT} mailboxes per import` });
        }

        const apiKey = await loadOrgKey(orgId);
        if (!apiKey) {
            return res.status(400).json({ success: false, error: 'Zapmail is not connected' });
        }

        const googleClientId = process.env.GOOGLE_CLIENT_ID;
        if (!googleClientId) {
            return res.status(500).json({ success: false, error: 'Server is missing GOOGLE_CLIENT_ID' });
        }

        // Source-of-truth re-fetch — user can't fabricate emails not in Zapmail
        const { mailboxes: remoteMailboxes } = await listAllMailboxes(apiKey);
        const remoteByEmail = new Map<string, ZapmailMailbox>(remoteMailboxes.map((m) => [m.email, m]));

        // Tier limit
        const org = await prisma.organization.findUnique({
            where: { id: orgId },
            select: { subscription_tier: true },
        });
        const tierLimits = TIER_LIMITS[org?.subscription_tier || 'trial'] || TIER_LIMITS.trial;
        const currentCount = await prisma.connectedAccount.count({ where: { organization_id: orgId } });
        const cap = tierLimits.mailboxes === Infinity ? Infinity : tierLimits.mailboxes;
        let remaining = cap === Infinity ? Infinity : Math.max(0, cap - currentCount);

        const orgSettings = await getSequencerSettings(orgId);
        const defaultDailyLimit = orgSettings.default_daily_limit;

        const results: ImportRowResult[] = [];
        const queuedGoogle: { mailbox: ZapmailMailbox; entry: CustomOAuthMailboxEntry }[] = [];
        const queuedMicrosoft: { mailbox: ZapmailMailbox; entry: CustomOAuthMailboxEntry }[] = [];

        // Phase 1: pre-create ConnectedAccount rows in oauth_pending. The
        // existing OAuth callback upserts on (org, email) and will flip these
        // to `active` once Zapmail completes the orchestrated consent.
        for (const email of requestedEmails) {
            const remote = remoteByEmail.get(email);
            if (!remote) {
                results.push({ email, status: 'failed', error_code: 'not_in_zapmail', error_message: 'Mailbox not found in your Zapmail account' });
                continue;
            }
            if (remaining <= 0) {
                results.push({ email, status: 'failed', error_code: 'tier_limit', error_message: `Mailbox limit reached on ${org?.subscription_tier || 'trial'} plan` });
                continue;
            }

            try {
                const account = await prisma.connectedAccount.create({
                    data: {
                        organization_id: orgId,
                        email,
                        display_name: remote.displayName || null,
                        provider: remote.provider,
                        connection_status: 'oauth_pending',
                        daily_send_limit: defaultDailyLimit,
                    },
                });

                provisionMailboxForConnectedAccount({
                    connectedAccountId: account.id,
                    organizationId: orgId,
                    email: account.email,
                    displayName: account.display_name,
                }).catch((err) =>
                    logger.error('[ZAPMAIL] Shadow provisioning failed', err instanceof Error ? err : new Error(String(err))),
                );

                // Build the OAuth URL Zapmail will walk on the mailbox side. Our
                // existing /api/sequencer/accounts/{provider}/callback handles
                // the auth code and upserts tokens onto this same row.
                const oauthLink =
                    remote.provider === 'google'
                        ? getGoogleAuthorizationUrl(orgId, email)
                        : await getMicrosoftAuthorizationUrl(orgId, email);

                const entry: CustomOAuthMailboxEntry = { mailboxId: remote.id, oauthLink };
                if (remote.provider === 'google') queuedGoogle.push({ mailbox: remote, entry });
                else queuedMicrosoft.push({ mailbox: remote, entry });

                results.push({ email, status: 'queued', accountId: account.id, provider: remote.provider });
                if (remaining !== Infinity) remaining--;
            } catch (err: unknown) {
                const e = err as { code?: string; message?: string };
                if (e?.code === 'P2002') {
                    results.push({ email, status: 'skipped', error_code: 'duplicate', error_message: 'Mailbox already imported' });
                } else {
                    logger.error('[ZAPMAIL] Pre-create failed', err instanceof Error ? err : new Error(String(err)));
                    results.push({ email, status: 'failed', error_code: 'precreate_failed', error_message: e?.message || 'Failed to create mailbox row' });
                }
            }
        }

        // Phase 2 (Google): attach our client_id to the affected domains.
        // Zapmail doc says "Client ID will be added to the domains soon" — best
        // effort, we don't currently wait/poll for confirmation.
        if (queuedGoogle.length > 0) {
            const googleDomainIds = Array.from(new Set(queuedGoogle.map(({ mailbox }) => mailbox.domainId).filter(Boolean)));
            try {
                await addGoogleClientIdToDomains(apiKey, {
                    domainIds: googleDomainIds,
                    clientId: googleClientId,
                    appName: SUPERKABE_APP_NAME,
                });
            } catch (err: unknown) {
                const e = err as { message?: string };
                logger.error('[ZAPMAIL] add-client-id failed', err instanceof Error ? err : new Error(String(err)));
                // Mark all google-queued rows as failed at this stage
                for (const { mailbox } of queuedGoogle) {
                    const r = results.find((x) => x.email === mailbox.email);
                    if (r) {
                        r.status = 'failed';
                        r.error_code = 'add_client_id_failed';
                        r.error_message = e?.message || 'Failed to whitelist OAuth client on Zapmail domains';
                    }
                }
                queuedGoogle.length = 0;
            }
        }

        // Phase 3: kick off Custom OAuth orchestration. One call covers both
        // Google and Microsoft sections.
        let exportId: number | null = null;
        if (queuedGoogle.length > 0 || queuedMicrosoft.length > 0) {
            const groupByDomain = (items: { mailbox: ZapmailMailbox; entry: CustomOAuthMailboxEntry }[]) => {
                const map: Record<string, CustomOAuthMailboxEntry[]> = {};
                for (const { mailbox, entry } of items) {
                    if (!mailbox.domainId) continue;
                    if (!map[mailbox.domainId]) map[mailbox.domainId] = [];
                    map[mailbox.domainId].push(entry);
                }
                return map;
            };

            try {
                const result = await triggerCustomOAuth(apiKey, {
                    ...(queuedGoogle.length > 0
                        ? {
                            google: {
                                appName: SUPERKABE_APP_NAME,
                                clientId: googleClientId,
                                mailboxesPerDomain: groupByDomain(queuedGoogle),
                            },
                        }
                        : {}),
                    ...(queuedMicrosoft.length > 0
                        ? {
                            microsoft: {
                                mailboxesPerDomain: groupByDomain(queuedMicrosoft),
                            },
                        }
                        : {}),
                });
                exportId = result.exportId;
            } catch (err: unknown) {
                const e = err as { message?: string };
                logger.error('[ZAPMAIL] custom-oauth trigger failed', err instanceof Error ? err : new Error(String(err)));
                for (const { mailbox } of [...queuedGoogle, ...queuedMicrosoft]) {
                    const r = results.find((x) => x.email === mailbox.email);
                    if (r && r.status === 'queued') {
                        r.status = 'failed';
                        r.error_code = 'custom_oauth_failed';
                        r.error_message = e?.message || 'Zapmail rejected the OAuth orchestration request';
                    }
                }
            }
        }

        return res.status(200).json({
            success: true,
            data: {
                results,
                exportId,
                summary: {
                    total: requestedEmails.length,
                    queued: results.filter((r) => r.status === 'queued').length,
                    skipped: results.filter((r) => r.status === 'skipped').length,
                    failed: results.filter((r) => r.status === 'failed').length,
                },
            },
        });
    } catch (err: unknown) {
        const e = err as { message?: string };
        logger.error('[ZAPMAIL] Import failed', err instanceof Error ? err : new Error(String(err)));
        return res.status(500).json({ success: false, error: e?.message || 'Failed to import mailboxes' });
    }
};

export const importStatus = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const exportId = Number(req.params.exportId);
        if (!Number.isFinite(exportId)) {
            return res.status(400).json({ success: false, error: 'Invalid exportId' });
        }
        const apiKey = await loadOrgKey(orgId);
        if (!apiKey) {
            return res.status(400).json({ success: false, error: 'Zapmail is not connected' });
        }

        const status = await getExportStatus(apiKey, exportId);

        // Cross-check our own ConnectedAccount rows so the UI can show what's
        // actually landed (Zapmail's status is opaque). Active rows = OAuth
        // callback completed; oauth_pending = still waiting.
        const recent = await prisma.connectedAccount.findMany({
            where: { organization_id: orgId, created_at: { gte: new Date(Date.now() - 24 * 3600 * 1000) } },
            select: { email: true, connection_status: true, last_error: true },
            orderBy: { created_at: 'desc' },
            take: 200,
        });

        return res.status(200).json({
            success: true,
            data: {
                exportId,
                zapmailStatus: status.status,
                zapmailProgress: status.progress,
                recentAccounts: recent,
            },
        });
    } catch (err: unknown) {
        const e = err as { message?: string };
        return res.status(500).json({ success: false, error: e?.message || 'Failed to fetch import status' });
    }
};
