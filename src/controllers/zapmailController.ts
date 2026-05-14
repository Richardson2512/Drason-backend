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
import { prisma } from '../prisma';
import { logger } from '../services/observabilityService';
import { encrypt, decrypt } from '../utils/encryption';
import { getSequencerSettings } from '../services/sequencerSettingsService';
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

// Zapmail's documented quota: max 3 Custom-OAuth attempts per mailbox per
// rolling 7-day window. Hitting it returns a generic 429 — we pre-check and
// surface an actionable error code instead.
const ZAPMAIL_OAUTH_MAX_ATTEMPTS = 3;
const ZAPMAIL_OAUTH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

// Bound for treating an oauth_pending row as "in-progress" rather than
// abandoned. Aligns with the importStatus poll expiry below.
const OAUTH_PENDING_FRESHNESS_MS = 60 * 60 * 1000;

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

        // Mailbox count is unmetered — no per-row tier-cap check.
        const orgSettings = await getSequencerSettings(orgId);
        const defaultDailyLimit = orgSettings.default_daily_limit;

        const results: ImportRowResult[] = [];
        const queuedGoogle: { mailbox: ZapmailMailbox; entry: CustomOAuthMailboxEntry; accountId: string }[] = [];
        const queuedMicrosoft: { mailbox: ZapmailMailbox; entry: CustomOAuthMailboxEntry; accountId: string }[] = [];

        const now = new Date();

        // Phase 1: smart-upsert ConnectedAccount rows.
        //
        //   active                                          → skipped/duplicate
        //   oauth_pending  AND  oauth_initiated_at < 60min  → skipped/in_progress
        //   oauth_failed   OR   stale oauth_pending         → resumable: re-arm row
        //                                                     (rolls window/quota)
        //   no row                                          → create fresh
        //
        // The OAuth callback upserts on (org, email) and flips this row to
        // `active`. The reconciliation worker sweeps abandoned oauth_pending.
        for (const email of requestedEmails) {
            const remote = remoteByEmail.get(email);
            if (!remote) {
                results.push({ email, status: 'failed', error_code: 'not_in_zapmail', error_message: 'Mailbox not found in your Zapmail account' });
                continue;
            }

            try {
                const existing = await prisma.connectedAccount.findUnique({
                    where: { organization_id_email: { organization_id: orgId, email } },
                    select: {
                        id: true,
                        connection_status: true,
                        oauth_initiated_at: true,
                        oauth_attempts: true,
                        oauth_first_attempt_at: true,
                    },
                });

                if (existing && existing.connection_status === 'active') {
                    results.push({ email, status: 'skipped', error_code: 'duplicate', error_message: 'Mailbox already imported' });
                    continue;
                }

                if (
                    existing &&
                    existing.connection_status === 'oauth_pending' &&
                    existing.oauth_initiated_at &&
                    now.getTime() - existing.oauth_initiated_at.getTime() < OAUTH_PENDING_FRESHNESS_MS
                ) {
                    results.push({ email, status: 'skipped', error_code: 'in_progress', error_message: 'OAuth already in progress for this mailbox' });
                    continue;
                }

                // Pre-flight Zapmail's 3/mailbox/7d quota. Reset window if it
                // has fully passed.
                let attemptsInWindow = existing?.oauth_attempts ?? 0;
                let windowAnchor = existing?.oauth_first_attempt_at ?? null;
                if (windowAnchor && now.getTime() - windowAnchor.getTime() >= ZAPMAIL_OAUTH_WINDOW_MS) {
                    attemptsInWindow = 0;
                    windowAnchor = null;
                }
                if (attemptsInWindow >= ZAPMAIL_OAUTH_MAX_ATTEMPTS) {
                    const resetAt = windowAnchor ? new Date(windowAnchor.getTime() + ZAPMAIL_OAUTH_WINDOW_MS) : null;
                    results.push({
                        email,
                        status: 'failed',
                        error_code: 'oauth_quota_exhausted',
                        error_message: resetAt
                            ? `Zapmail allows max ${ZAPMAIL_OAUTH_MAX_ATTEMPTS} OAuth attempts per mailbox per 7 days. Try again after ${resetAt.toISOString()}.`
                            : `Zapmail allows max ${ZAPMAIL_OAUTH_MAX_ATTEMPTS} OAuth attempts per mailbox per 7 days.`,
                    });
                    continue;
                }

                const nextAttempts = attemptsInWindow + 1;
                const nextAnchor = windowAnchor ?? now;

                const account = await prisma.connectedAccount.upsert({
                    where: { organization_id_email: { organization_id: orgId, email } },
                    create: {
                        organization_id: orgId,
                        email,
                        display_name: remote.displayName || null,
                        provider: remote.provider,
                        connection_status: 'oauth_pending',
                        daily_send_limit: defaultDailyLimit,
                        oauth_initiated_at: now,
                        oauth_attempts: nextAttempts,
                        oauth_first_attempt_at: nextAnchor,
                        last_error: null,
                        source: 'zapmail',
                    },
                    update: {
                        display_name: remote.displayName || null,
                        provider: remote.provider,
                        connection_status: 'oauth_pending',
                        oauth_initiated_at: now,
                        oauth_attempts: nextAttempts,
                        oauth_first_attempt_at: nextAnchor,
                        zapmail_export_id: null,
                        last_error: null,
                    },
                });

                // Build the OAuth URL Zapmail will walk on the mailbox side. Our
                // existing /api/sequencer/accounts/{provider}/callback handles
                // the auth code and upserts tokens onto this same row.
                const oauthLink =
                    remote.provider === 'google'
                        ? await getGoogleAuthorizationUrl(orgId, email)
                        : await getMicrosoftAuthorizationUrl(orgId, email);

                const entry: CustomOAuthMailboxEntry = { mailboxId: remote.id, oauthLink };
                if (remote.provider === 'google') queuedGoogle.push({ mailbox: remote, entry, accountId: account.id });
                else queuedMicrosoft.push({ mailbox: remote, entry, accountId: account.id });

                results.push({ email, status: 'queued', accountId: account.id, provider: remote.provider });
            } catch (err: unknown) {
                const e = err as { code?: string; message?: string };
                logger.error('[ZAPMAIL] Pre-create failed', err instanceof Error ? err : new Error(String(err)));
                results.push({ email, status: 'failed', error_code: 'precreate_failed', error_message: e?.message || 'Failed to create mailbox row' });
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
                const reason = e?.message || 'Failed to whitelist OAuth client on Zapmail domains';
                logger.error('[ZAPMAIL] add-client-id failed', err instanceof Error ? err : new Error(String(err)));
                // Roll the DB rows back to oauth_failed so the reconciler and
                // the listMailboxes annotation reflect reality, not a zombie
                // oauth_pending.
                const failedIds = queuedGoogle.map((q) => q.accountId);
                if (failedIds.length > 0) {
                    await prisma.connectedAccount.updateMany({
                        where: { id: { in: failedIds } },
                        data: { connection_status: 'oauth_failed', last_error: `add-client-id: ${reason}` },
                    });
                }
                for (const { mailbox } of queuedGoogle) {
                    const r = results.find((x) => x.email === mailbox.email);
                    if (r) {
                        r.status = 'failed';
                        r.error_code = 'add_client_id_failed';
                        r.error_message = reason;
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

                // Persist export id on every queued row so the reconciler can
                // re-poll Zapmail after a process restart, and so importStatus
                // can scope the freshness check to this batch.
                const queuedIds = [...queuedGoogle, ...queuedMicrosoft].map((q) => q.accountId);
                if (queuedIds.length > 0) {
                    await prisma.connectedAccount.updateMany({
                        where: { id: { in: queuedIds } },
                        data: { zapmail_export_id: exportId },
                    });
                }
            } catch (err: unknown) {
                const e = err as { message?: string };
                const reason = e?.message || 'Zapmail rejected the OAuth orchestration request';
                logger.error('[ZAPMAIL] custom-oauth trigger failed', err instanceof Error ? err : new Error(String(err)));
                const failedIds = [...queuedGoogle, ...queuedMicrosoft].map((q) => q.accountId);
                if (failedIds.length > 0) {
                    await prisma.connectedAccount.updateMany({
                        where: { id: { in: failedIds } },
                        data: { connection_status: 'oauth_failed', last_error: `custom-oauth: ${reason}` },
                    });
                }
                for (const { mailbox } of [...queuedGoogle, ...queuedMicrosoft]) {
                    const r = results.find((x) => x.email === mailbox.email);
                    if (r && r.status === 'queued') {
                        r.status = 'failed';
                        r.error_code = 'custom_oauth_failed';
                        r.error_message = reason;
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

        // Scope the freshness check to rows belonging to THIS export. If the
        // newest oauth_initiated_at is past the 60-min bound, stop polling
        // Zapmail — the front-end loop is unbounded otherwise. Reconciler
        // sweeps the abandoned oauth_pending rows server-side.
        const exportRows = await prisma.connectedAccount.findMany({
            where: { organization_id: orgId, zapmail_export_id: exportId },
            select: { email: true, connection_status: true, last_error: true, oauth_initiated_at: true },
            orderBy: { oauth_initiated_at: 'desc' },
            take: 200,
        });

        const newestInitiated = exportRows.reduce<Date | null>(
            (acc, r) => (r.oauth_initiated_at && (!acc || r.oauth_initiated_at > acc) ? r.oauth_initiated_at : acc),
            null,
        );
        const isExpired = newestInitiated
            ? Date.now() - newestInitiated.getTime() > OAUTH_PENDING_FRESHNESS_MS
            : false;

        if (isExpired) {
            return res.status(200).json({
                success: true,
                data: {
                    exportId,
                    zapmailStatus: 'expired',
                    zapmailProgress: null,
                    expired: true,
                    expiredAfterMs: OAUTH_PENDING_FRESHNESS_MS,
                    recentAccounts: exportRows.map(({ email, connection_status, last_error }) => ({
                        email,
                        connection_status,
                        last_error,
                    })),
                },
            });
        }

        const status = await getExportStatus(apiKey, exportId);

        return res.status(200).json({
            success: true,
            data: {
                exportId,
                zapmailStatus: status.status,
                zapmailProgress: status.progress,
                expired: false,
                recentAccounts: exportRows.map(({ email, connection_status, last_error }) => ({
                    email,
                    connection_status,
                    last_error,
                })),
            },
        });
    } catch (err: unknown) {
        const e = err as { message?: string };
        return res.status(500).json({ success: false, error: e?.message || 'Failed to fetch import status' });
    }
};
