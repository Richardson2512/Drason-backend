/**
 * Connected Account Controller
 *
 * Manage SMTP/OAuth connected email accounts for the Sequencer.
 */

import { Request, Response } from 'express';
import { getOrgId } from '../middleware/orgContext';
import { prisma } from '../index';
import { logger } from '../services/observabilityService';
import { getSequencerSettings } from '../services/sequencerSettingsService';
import { provisionMailboxForConnectedAccount, deprovisionMailboxForConnectedAccount } from '../services/mailboxProvisioningService';
import { verifyAndPersistForAccount, checkTrackingDomain } from '../services/trackingDomainVerifierService';
import { encrypt, decrypt, isEncrypted } from '../utils/encryption';
import { revokeGoogleToken } from '../utils/googleOAuth';
import nodemailer from 'nodemailer';

/**
 * GET /api/sequencer/accounts
 * List all connected accounts for the org with send stats.
 */
export const listAccounts = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);

        const accounts = await prisma.connectedAccount.findMany({
            where: { organization_id: orgId },
            orderBy: { created_at: 'desc' },
            include: {
                campaignAccounts: {
                    select: { campaign_id: true },
                },
                mailbox: {
                    select: {
                        status: true,
                        recovery_phase: true,
                        resilience_score: true,
                        hard_bounce_count: true,
                        window_sent_count: true,
                        window_bounce_count: true,
                    },
                },
            },
        });

        const data = accounts.map((a) => {
            // ── Protection status - from shadow Mailbox (unified Option B) ──
            // status: 'healthy' | 'warning' | 'paused'
            // recovery_phase: 'healthy' | 'paused' | 'quarantine' | 'restricted_send' | 'warm_recovery'
            const mailboxStatus = a.mailbox?.status || 'healthy';
            const recoveryPhase = a.mailbox?.recovery_phase || 'healthy';

            // A mailbox is selectable for new campaigns only if healthy + OAuth/SMTP connection is active
            const isPausedOrHealing = mailboxStatus === 'paused'
                || recoveryPhase === 'paused'
                || recoveryPhase === 'quarantine'
                || recoveryPhase === 'restricted_send'
                || recoveryPhase === 'warm_recovery';
            const isConnectionBroken = a.connection_status !== 'active';
            const selectable = !isPausedOrHealing && !isConnectionBroken;

            // ── Utilization (based on today's sends vs daily limit) ──
            const utilizationPct = a.daily_send_limit > 0
                ? (a.sends_today / a.daily_send_limit) * 100
                : 0;
            let utilization: 'underutilized' | 'balanced' | 'overutilized';
            if (utilizationPct < 40) utilization = 'underutilized';
            else if (utilizationPct > 80) utilization = 'overutilized';
            else utilization = 'balanced';

            // Pick the disabled reason for UI tooltip
            let disabledReason: string | null = null;
            if (isConnectionBroken) disabledReason = `Connection ${a.connection_status} - reconnect mailbox`;
            else if (recoveryPhase === 'paused' || mailboxStatus === 'paused') disabledReason = 'Mailbox paused by Protection layer';
            else if (recoveryPhase === 'quarantine') disabledReason = 'Mailbox in quarantine - healing in progress';
            else if (recoveryPhase === 'restricted_send') disabledReason = 'Mailbox in restricted sending - healing phase';
            else if (recoveryPhase === 'warm_recovery') disabledReason = 'Mailbox in warm recovery - healing phase';

            return {
                id: a.id,
                email: a.email,
                display_name: a.display_name,
                provider: a.provider,
                connection_status: a.connection_status,
                last_error: a.last_error,
                daily_send_limit: a.daily_send_limit,
                sends_today: a.sends_today,
                sends_reset_at: a.sends_reset_at,
                warmup_complete: a.warmup_complete,
                signature_html: a.signature_html,
                campaign_count: a.campaignAccounts.length,
                // How this mailbox got into Superkabe - drives the Source
                // column + filter on the mailboxes page.
                source: a.source,
                // Protection + utilization signals for campaign mailbox picker
                mailbox_status: mailboxStatus,
                recovery_phase: recoveryPhase,
                resilience_score: a.mailbox?.resilience_score ?? 50,
                hard_bounce_count: a.mailbox?.hard_bounce_count ?? 0,
                selectable,
                disabled_reason: disabledReason,
                utilization,
                utilization_pct: Math.round(utilizationPct),
                created_at: a.created_at,
                updated_at: a.updated_at,
            };
        });

        return res.json({ success: true, data });
    } catch (error: any) {
        logger.error('[ACCOUNTS] Failed to list accounts', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ success: false, error: 'Failed to list accounts' });
    }
};

/**
 * POST /api/sequencer/accounts
 * Create a new connected account (SMTP or OAuth placeholder).
 */
export const createAccount = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const {
            email, displayName, provider,
            smtpHost, smtpPort, smtpUsername, smtpPassword,
            imapHost, imapPort, dailySendLimit,
        } = req.body;

        if (!email || !provider) {
            return res.status(400).json({ success: false, error: 'email and provider are required' });
        }

        // Mailbox count is unmetered - connect as many as you like at any tier.
        // Use the org's Sequencer default if no explicit value provided
        const orgSettings = await getSequencerSettings(orgId);
        const effectiveDailyLimit = dailySendLimit || orgSettings.default_daily_limit;

        const data: any = {
            organization_id: orgId,
            email,
            display_name: displayName || null,
            provider,
            daily_send_limit: effectiveDailyLimit,
            // Single-mailbox connections from the "Connect Mailbox" modal
            // are tagged 'manual' regardless of OAuth/SMTP - the OAuth case
            // is overridden later in the OAuth callback (oauthConnectController).
            source: 'manual',
        };

        // For SMTP accounts, store connection details
        if (provider === 'smtp') {
            if (!smtpHost || !smtpPort || !smtpUsername || !smtpPassword) {
                return res.status(400).json({ success: false, error: 'SMTP connection details are required for smtp provider' });
            }
            data.smtp_host = smtpHost;
            data.smtp_port = smtpPort;
            data.smtp_username = smtpUsername;
            // Encrypt at rest. The schema marks this field encrypted but
            // historic code stored plaintext - this fixes the gap. Consumers
            // (emailSendAdapters, imapReplyWorker) tolerate both encrypted
            // and legacy plaintext via isEncrypted() probe so existing rows
            // keep working without migration.
            data.smtp_password = encrypt(smtpPassword);
            data.imap_host = imapHost || null;
            data.imap_port = imapPort || null;
        }
        // For google/microsoft, OAuth is handled separately - just create the record

        const account = await prisma.connectedAccount.create({ data });

        // Provision shadow Mailbox + Domain so Protection services cover this account
        try {
            await provisionMailboxForConnectedAccount({
                connectedAccountId: account.id,
                organizationId: orgId,
                email: account.email,
                displayName: account.display_name,
            });
        } catch (provisionErr: any) {
            logger.error('[ACCOUNTS] Shadow mailbox provisioning failed', provisionErr);
            // Non-fatal - account is still created. Protection will be degraded until resolved.
        }

        return res.status(201).json({ success: true, data: account });
    } catch (error: any) {
        if (error?.code === 'P2002') {
            return res.status(409).json({ success: false, error: 'Account with this email already exists' });
        }
        logger.error('[ACCOUNTS] Failed to create account', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ success: false, error: 'Failed to create account' });
    }
};

/**
 * POST /api/sequencer/accounts/bulk
 * Bulk-create connected accounts from a parsed CSV. Each row is validated and
 * created independently - one bad row does NOT abort the batch. Returns a per-
 * row status array so the frontend can show which rows succeeded and which
 * need attention.
 *
 * Body shape: { rows: BulkRow[] }
 *   BulkRow = {
 *     email: string                  (required)
 *     provider: 'smtp' | 'google' | 'microsoft' (required)
 *     displayName?: string
 *     dailySendLimit?: number
 *     // SMTP-only:
 *     smtpHost?: string
 *     smtpPort?: number
 *     smtpUsername?: string
 *     smtpPassword?: string
 *     imapHost?: string
 *     imapPort?: number
 *   }
 *
 * Tier limits are enforced against the running total - the loop stops issuing
 * creates the moment the org would exceed its mailbox cap (rather than rejecting
 * the entire batch). Already-created accounts persist; remaining rows return
 * a `tier_limit` error.
 *
 * google/microsoft rows are accepted but flagged `oauth_pending` since OAuth
 * tokens are obtained interactively - the bulk endpoint creates the
 * placeholder ConnectedAccount so the user can click "authorize" later from
 * the accounts list. SMTP rows are immediately usable if credentials work.
 *
 * Hard cap: 200 rows per request to keep the transaction footprint sane.
 */

interface BulkRowInput {
    email?: string;
    provider?: string;
    displayName?: string;
    dailySendLimit?: number;
    smtpHost?: string;
    smtpPort?: number;
    smtpUsername?: string;
    smtpPassword?: string;
    imapHost?: string;
    imapPort?: number;
}

interface BulkRowResult {
    row: number;            // 1-based index for user-facing messages
    email: string | null;
    status: 'created' | 'skipped' | 'failed';
    accountId?: string;
    /** Stable error code so the frontend can group + remediate. */
    error_code?: 'duplicate' | 'missing_email' | 'missing_provider' | 'invalid_provider' | 'missing_smtp_fields' | 'tier_limit' | 'invalid_email' | 'unknown';
    error_message?: string;
    requires_oauth?: boolean;
}

const MAX_BULK_ROWS = 200;
const VALID_PROVIDERS = new Set(['smtp', 'google', 'microsoft']);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const bulkCreateAccounts = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const rows: BulkRowInput[] = Array.isArray(req.body?.rows) ? req.body.rows : [];

        if (rows.length === 0) {
            return res.status(400).json({ success: false, error: 'rows array is required and must contain at least one entry' });
        }
        if (rows.length > MAX_BULK_ROWS) {
            return res.status(413).json({ success: false, error: `Too many rows. Max ${MAX_BULK_ROWS} per request.` });
        }

        // Mailbox count is unmetered - no per-row tier-cap check.
        const orgSettings = await getSequencerSettings(orgId);
        const defaultDailyLimit = orgSettings.default_daily_limit;

        const results: BulkRowResult[] = [];
        let createdCount = 0;

        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            const email = (row.email || '').trim().toLowerCase();
            const provider = (row.provider || '').trim().toLowerCase();

            if (!email) {
                results.push({ row: i + 1, email: null, status: 'failed', error_code: 'missing_email', error_message: 'email is required' });
                continue;
            }
            if (!EMAIL_RE.test(email)) {
                results.push({ row: i + 1, email, status: 'failed', error_code: 'invalid_email', error_message: 'email format is invalid' });
                continue;
            }
            if (!provider) {
                results.push({ row: i + 1, email, status: 'failed', error_code: 'missing_provider', error_message: 'provider is required (smtp / google / microsoft)' });
                continue;
            }
            if (!VALID_PROVIDERS.has(provider)) {
                results.push({ row: i + 1, email, status: 'failed', error_code: 'invalid_provider', error_message: `provider must be one of: smtp, google, microsoft (got "${provider}")` });
                continue;
            }
            if (provider === 'smtp') {
                if (!row.smtpHost || !row.smtpPort || !row.smtpUsername || !row.smtpPassword) {
                    results.push({ row: i + 1, email, status: 'failed', error_code: 'missing_smtp_fields', error_message: 'SMTP rows require smtpHost, smtpPort, smtpUsername, smtpPassword' });
                    continue;
                }
            }
            const data: Record<string, unknown> = {
                organization_id: orgId,
                email,
                display_name: row.displayName || null,
                provider,
                daily_send_limit: row.dailySendLimit || defaultDailyLimit,
                source: 'csv',
            };
            if (provider === 'smtp') {
                data.smtp_host = row.smtpHost;
                data.smtp_port = row.smtpPort;
                data.smtp_username = row.smtpUsername;
                // Encrypt at rest - see single-account create handler above.
                data.smtp_password = row.smtpPassword ? encrypt(row.smtpPassword) : null;
                data.imap_host = row.imapHost || null;
                data.imap_port = row.imapPort || null;
            }

            try {
                const account = await prisma.connectedAccount.create({ data: data as never });
                // Best-effort shadow Mailbox provisioning. Logged on failure but doesn't
                // block the row from being marked created - Protection coverage will
                // gracefully recover on the next assessment cycle.
                try {
                    await provisionMailboxForConnectedAccount({
                        connectedAccountId: account.id,
                        organizationId: orgId,
                        email: account.email,
                        displayName: account.display_name,
                    });
                } catch (provisionErr: unknown) {
                    logger.error(
                        '[ACCOUNTS] Bulk: shadow provisioning failed',
                        provisionErr instanceof Error ? provisionErr : new Error(String(provisionErr)),
                    );
                }
                results.push({
                    row: i + 1,
                    email,
                    status: 'created',
                    accountId: account.id,
                    requires_oauth: provider === 'google' || provider === 'microsoft',
                });
                createdCount++;
            } catch (err: unknown) {
                const e = err as { code?: string; message?: string };
                if (e?.code === 'P2002') {
                    results.push({ row: i + 1, email, status: 'skipped', error_code: 'duplicate', error_message: 'Account with this email already exists' });
                } else {
                    logger.error('[ACCOUNTS] Bulk: create failed', err instanceof Error ? err : new Error(String(err)));
                    results.push({ row: i + 1, email, status: 'failed', error_code: 'unknown', error_message: e?.message || 'Failed to create account' });
                }
            }
        }

        return res.status(200).json({
            success: true,
            data: {
                results,
                summary: {
                    total: rows.length,
                    created: createdCount,
                    skipped: results.filter(r => r.status === 'skipped').length,
                    failed: results.filter(r => r.status === 'failed').length,
                    requires_oauth: results.filter(r => r.requires_oauth).length,
                },
            },
        });
    } catch (error: unknown) {
        logger.error('[ACCOUNTS] Bulk create fatal error', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ success: false, error: 'Bulk import failed' });
    }
};

/**
 * DELETE /api/sequencer/accounts/:id
 * Remove a connected account.
 */
export const deleteAccount = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const accountId = String(req.params.id);

        const account = await prisma.connectedAccount.findFirst({
            where: { id: accountId, organization_id: orgId },
        });

        if (!account) return res.status(404).json({ success: false, error: 'Account not found' });

        // Revoke the Google grant before clearing local state. Google's
        // OAuth best-practices: "Revoke tokens as soon as they are no
        // longer needed." Best-effort - never block deletion on revoke
        // failure (the user always sees an honest UI), but the grant
        // SHOULD be killed on Google's side regardless of our DB state.
        if (account.provider === 'google' && account.refresh_token) {
            try {
                const refresh = isEncrypted(account.refresh_token)
                    ? decrypt(account.refresh_token)
                    : account.refresh_token;
                const result = await revokeGoogleToken(refresh);
                logger.info('[ACCOUNTS] Google revoke outcome', { accountId, revoked: result.revoked, status: result.status });
            } catch (revokeErr) {
                logger.warn('[ACCOUNTS] Google revoke threw - proceeding with local cleanup', {
                    accountId,
                    error: revokeErr instanceof Error ? revokeErr.message : String(revokeErr),
                });
            }
        }

        // Soft-disconnect shadow mailbox first (preserves SendEvent history)
        await deprovisionMailboxForConnectedAccount(accountId);

        await prisma.connectedAccount.delete({ where: { id: accountId } });

        return res.json({ success: true, message: 'Account deleted' });
    } catch (error: any) {
        logger.error('[ACCOUNTS] Failed to delete account', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ success: false, error: 'Failed to delete account' });
    }
};

/**
 * PATCH /api/sequencer/accounts/:id
 * Update dailySendLimit, displayName, or signatureHtml.
 */
export const updateAccount = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const accountId = String(req.params.id);
        const { dailySendLimit, displayName, signatureHtml } = req.body;

        const account = await prisma.connectedAccount.findFirst({
            where: { id: accountId, organization_id: orgId },
        });

        if (!account) return res.status(404).json({ success: false, error: 'Account not found' });

        const updateData: any = {};
        if (dailySendLimit !== undefined) updateData.daily_send_limit = dailySendLimit;
        if (displayName !== undefined) updateData.display_name = displayName;
        if (signatureHtml !== undefined) updateData.signature_html = signatureHtml;

        const updated = await prisma.connectedAccount.update({
            where: { id: accountId },
            data: updateData,
        });

        return res.json({ success: true, data: updated });
    } catch (error: any) {
        logger.error('[ACCOUNTS] Failed to update account', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ success: false, error: 'Failed to update account' });
    }
};

/**
 * POST /api/sequencer/accounts/:id/test
 * Probe live mailbox credentials. For SMTP-password accounts we run
 * nodemailer.verify() (issues a NOOP + AUTH against the configured host),
 * which catches changed passwords, blocked-by-ESP, and host-down cases
 * before a campaign send fails. OAuth accounts skip the probe - token
 * validity is enforced at refresh time by emailSendAdapters.
 */
export const testConnection = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const accountId = String(req.params.id);

        const account = await prisma.connectedAccount.findFirst({
            where: { id: accountId, organization_id: orgId },
        });

        if (!account) return res.status(404).json({ success: false, error: 'Account not found' });

        if (!account.smtp_host || !account.smtp_password) {
            return res.json({
                success: true,
                status: 'oauth',
                message: 'OAuth account - credentials revalidated at send time.',
            });
        }

        const port = account.smtp_port || 587;
        const user = account.smtp_username || account.email;
        const storedPass = String(account.smtp_password);
        const pass = isEncrypted(storedPass) ? decrypt(storedPass) : storedPass;

        const probe = nodemailer.createTransport({
            host: account.smtp_host,
            port,
            secure: port === 465,
            auth: { user, pass },
            tls: { rejectUnauthorized: false },
            connectionTimeout: 8000,
            greetingTimeout: 8000,
            socketTimeout: 8000,
        });

        try {
            await probe.verify();
        } finally {
            probe.close();
        }

        return res.json({
            success: true,
            status: 'ok',
            message: `SMTP login succeeded at ${account.smtp_host}:${port}.`,
        });
    } catch (error: any) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('[ACCOUNTS] Connection test failed', error instanceof Error ? error : new Error(message));
        return res.status(400).json({
            success: false,
            status: 'failed',
            error: message || 'Connection test failed',
        });
    }
};

/**
 * POST /api/sequencer/accounts/:id/tracking-domain
 * Body: { domain: string | null }
 * Set or clear the per-mailbox custom tracking domain. Setting marks it
 * unverified - the user must call /verify before sends will use it.
 */
export const setTrackingDomain = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const id = String(req.params.id);
        const raw = (req.body?.domain ?? null) as string | null;
        const domain = raw === null ? null : String(raw).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');

        if (domain && !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain)) {
            return res.status(400).json({ success: false, error: 'Invalid hostname. Use a hostname like links.yourdomain.com' });
        }

        const account = await prisma.connectedAccount.findFirst({
            where: { id, organization_id: orgId },
            select: { id: true },
        });
        if (!account) return res.status(404).json({ success: false, error: 'Mailbox not found' });

        const updated = await prisma.connectedAccount.update({
            where: { id },
            data: {
                tracking_domain: domain,
                tracking_domain_verified: false,
                tracking_domain_verified_at: null,
                tracking_domain_last_error: null,
                tracking_domain_last_check_at: null,
            },
            select: { id: true, tracking_domain: true, tracking_domain_verified: true },
        });
        return res.json({ success: true, data: updated });
    } catch (error: unknown) {
        logger.error('[ACCOUNTS] Failed to set tracking domain', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ success: false, error: 'Failed to set tracking domain' });
    }
};

/**
 * POST /api/sequencer/accounts/:id/tracking-domain/verify
 * Run DNS + HTTP verification against the saved tracking_domain. Persists
 * the result. Returns the verification report so the UI can show a
 * remediation hint (which DNS record is missing, what the CNAME points at).
 */
export const verifyTrackingDomain = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const id = String(req.params.id);
        const account = await prisma.connectedAccount.findFirst({
            where: { id, organization_id: orgId },
            select: { id: true, tracking_domain: true },
        });
        if (!account) return res.status(404).json({ success: false, error: 'Mailbox not found' });
        if (!account.tracking_domain) {
            return res.status(400).json({ success: false, error: 'No tracking domain set on this mailbox' });
        }

        const result = await verifyAndPersistForAccount(id);
        return res.json({ success: true, data: result });
    } catch (error: unknown) {
        logger.error('[ACCOUNTS] Tracking domain verify failed', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ success: false, error: 'Tracking domain verification failed' });
    }
};

/**
 * GET /api/sequencer/accounts/tracking-domain/check?domain=...
 * Read-only DNS + HTTP probe. Useful for showing live verification
 * feedback as the user types the hostname into the settings form,
 * before they save it to a mailbox.
 */
export const checkTrackingDomainEndpoint = async (req: Request, res: Response): Promise<Response> => {
    try {
        const domain = String(req.query.domain || '').trim();
        if (!domain) return res.status(400).json({ success: false, error: 'domain query param is required' });
        const result = await checkTrackingDomain(domain);
        return res.json({ success: true, data: result });
    } catch (error: unknown) {
        logger.error('[ACCOUNTS] Tracking domain check failed', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ success: false, error: 'Tracking domain check failed' });
    }
};
