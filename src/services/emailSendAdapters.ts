/**
 * Email Send Adapters
 *
 * Provider-specific send adapters for the Superkabe Sequencer.
 * SMTP adapter uses nodemailer with the credentials stored in ConnectedAccount.
 * Gmail and Microsoft adapters fall through to SMTP (app passwords work for both).
 */

import crypto from 'crypto';
import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
// nodemailer's MailComposer is the internal MIME builder. Importing it
// directly (vs. re-implementing MIME construction) keeps the message we
// APPEND to Sent byte-identical to the one we sent via SMTP.
import MailComposer from 'nodemailer/lib/mail-composer';
import { logger } from './observabilityService';
import { decrypt, isEncrypted } from '../utils/encryption';

/** Decrypt smtp_password if it's encrypted; return as-is for legacy
 *  plaintext rows. Both shapes coexist while the encryption rollout
 *  reaches every existing row (SMTP pre-existed encryption-at-rest). */
function readSmtpPassword(stored: string | null | undefined): string | null {
    if (!stored) return null;
    return isEncrypted(stored) ? decrypt(stored) : stored;
}
import { sendEmailViaGmailApi, refreshGoogleAccessToken } from './gmailSendService';
import { sendEmailViaGraph, refreshMicrosoftAccessToken } from './microsoftSendService';
import { appendToSentFolder } from './imapSentAppendService';
import { prisma } from '../prisma';

interface ConnectedAccountInput {
    id: string;
    email: string;
    provider: string;
    /** Set by the send-queue when fetching mailboxes — required for the
     *  Super Sender routing decision. Optional so legacy callers that
     *  build a partial input (transactional sends, tests) still type-check;
     *  routing falls back to native send when missing. */
    organization_id?: string;
    display_name?: string | null;
    smtp_host?: string | null;
    smtp_port?: number | null;
    smtp_username?: string | null;
    smtp_password?: string | null;
    imap_host?: string | null;
    imap_port?: number | null;
    access_token?: string | null;
    refresh_token?: string | null;
    token_expires_at?: Date | null;
    signature_html?: string | null;
}

/**
 * Ensure the account's access token is fresh. Refreshes via OAuth if expired.
 * Returns a decrypted access token.
 */
async function ensureFreshAccessToken(account: ConnectedAccountInput): Promise<string> {
    if (!account.access_token || !account.refresh_token) {
        throw new Error('Account has no OAuth tokens');
    }

    const decryptedAccess = decrypt(account.access_token);
    const decryptedRefresh = decrypt(account.refresh_token);

    // If token is still valid for at least 2 more minutes, use it
    if (account.token_expires_at && account.token_expires_at.getTime() > Date.now() + 2 * 60 * 1000) {
        return decryptedAccess;
    }

    // Refresh
    logger.info(`[SEND] Refreshing ${account.provider} token for ${account.email}`);

    if (account.provider === 'google') {
        const { access_token, expires_at, rotated_refresh_token } = await refreshGoogleAccessToken(decryptedRefresh);
        const { encrypt } = await import('../utils/encryption');
        // Persist a rotated refresh token if Google supplied one. Ignoring it
        // would strand the connection on the next refresh.
        const updateData: any = { access_token: encrypt(access_token), token_expires_at: expires_at };
        if (rotated_refresh_token) updateData.refresh_token = encrypt(rotated_refresh_token);
        await prisma.connectedAccount.update({ where: { id: account.id }, data: updateData });
        return access_token;
    } else if (account.provider === 'microsoft') {
        const { access_token, refresh_token: newRefresh, expires_at } = await refreshMicrosoftAccessToken(decryptedRefresh);
        const { encrypt } = await import('../utils/encryption');
        await prisma.connectedAccount.update({
            where: { id: account.id },
            data: {
                access_token: encrypt(access_token),
                refresh_token: encrypt(newRefresh), // Microsoft rotates refresh tokens
                token_expires_at: expires_at,
            },
        });
        return access_token;
    }

    return decryptedAccess;
}

export interface SendResult {
    success: boolean;
    messageId?: string;
    error?: string;
    /** SMTP transcript capture — populated on every send, success or failure.
     *  Used by sendQueueService to convert 5xx synchronous bounces into
     *  BounceEvent rows in real time (no waiting for async DSN). */
    smtpCode?: string;        // e.g. "550", "5.7.1"
    smtpResponse?: string;    // full server message, capped at 1024 chars
}

/** Truncate a server response to fit BounceEvent.smtp_response (1024 chars). */
function clipResponse(s: unknown): string | undefined {
    if (s === undefined || s === null) return undefined;
    const str = typeof s === 'string' ? s : String(s);
    return str.length > 1024 ? str.slice(0, 1024) : str;
}

/** Extract SMTP code + response from a nodemailer / Gmail / Microsoft error.
 *  Each provider exposes the SMTP details on different fields, so we probe
 *  several locations and stop at the first hit. */
function extractSmtp(err: any): { smtpCode?: string; smtpResponse?: string } {
    if (!err || typeof err !== 'object') return {};
    // nodemailer: error.responseCode (number) + error.response (string)
    const responseCode = err.responseCode ?? err.code;
    const response = err.response ?? err.message;
    // Gmail API: err.errors[0].message often contains SMTP transcript
    // Microsoft Graph: err.body.error.message contains it
    const fallback = err.errors?.[0]?.message
        ?? err.body?.error?.message
        ?? err.statusText;
    return {
        smtpCode: responseCode !== undefined ? String(responseCode) : undefined,
        smtpResponse: clipResponse(response ?? fallback),
    };
}

export { extractSmtp, clipResponse };

// ────────────────────────────────────────────────────────────────────
// Transporter cache — reuse connections per account to avoid
// reconnecting on every email
// ────────────────────────────────────────────────────────────────────

const transporterCache = new Map<string, { transporter: Transporter; createdAt: number }>();
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

function getOrCreateTransporter(account: ConnectedAccountInput): Transporter {
    const cacheKey = account.id;
    const cached = transporterCache.get(cacheKey);

    if (cached && Date.now() - cached.createdAt < CACHE_TTL) {
        return cached.transporter;
    }

    const host = account.smtp_host;
    const port = account.smtp_port || 587;
    const user = account.smtp_username || account.email;
    const pass = readSmtpPassword(account.smtp_password);

    if (!host || !pass) {
        throw new Error(`Missing SMTP credentials for ${account.email}`);
    }

    const transporter = nodemailer.createTransport({
        host,
        port,
        secure: port === 465, // TLS for 465, STARTTLS for 587
        auth: { user, pass },
        tls: {
            rejectUnauthorized: false, // Accept self-signed certs from infra providers
        },
        connectionTimeout: 10000,
        greetingTimeout: 10000,
        socketTimeout: 30000,
        pool: true,
        maxConnections: 3,
        maxMessages: 50,
    });

    transporterCache.set(cacheKey, { transporter, createdAt: Date.now() });
    return transporter;
}

/**
 * Clear cached transporter for an account (call when credentials change).
 */
export function clearTransporterCache(accountId: string): void {
    const cached = transporterCache.get(accountId);
    if (cached) {
        cached.transporter.close();
        transporterCache.delete(accountId);
    }
}

// ────────────────────────────────────────────────────────────────────
// SMTP Adapter — the real one
// ────────────────────────────────────────────────────────────────────

export interface SendOptions {
    inReplyTo?: string | null;
    references?: string | null;
    /** RFC 2369 + RFC 8058 unsubscribe URL — populates List-Unsubscribe headers
     *  required by Gmail's bulk-sender requirements (Feb 2024) and Yahoo's
     *  parallel rules. Null/undefined = no headers (transactional mail). */
    unsubscribeUrl?: string | null;
    /** Pre-generated RFC 5322 Message-ID. When set, the adapter uses this
     *  header verbatim instead of letting the provider auto-generate one.
     *  Used by the Unibox reply flow so the DB row written BEFORE the SMTP
     *  send and the outbound MIME header agree, enabling safe retries
     *  without duplicate sends. */
    messageId?: string | null;
}

export async function sendViaSMTP(
    account: ConnectedAccountInput,
    to: string,
    subject: string,
    bodyHtml: string,
    options?: SendOptions
): Promise<SendResult> {
    const transporter = getOrCreateTransporter(account);

    // Append signature if set
    let finalHtml = bodyHtml;
    if (account.signature_html) {
        finalHtml += `<br/><div style="margin-top:16px;border-top:1px solid #e5e5e5;padding-top:12px">${account.signature_html}</div>`;
    }

    // Honor a caller-provided Message-ID (Unibox reply flow generates one
    // upfront so the DB row and the outbound header agree, enabling safe
    // retries without duplicate sends). Falls back to auto-generation for
    // sequence sends that don't need pre-coordination.
    const messageId = options?.messageId || `<${crypto.randomUUID()}@superkabe.com>`;

    // Build the MIME message ONCE so we can both (a) send it via SMTP and
    // (b) APPEND the byte-identical message to the operator's Sent folder
    // afterwards. Nodemailer's internal MailComposer is what `sendMail`
    // uses under the hood — using it directly here gives us the raw bytes.
    const mailOptions = {
        from: account.email,
        to,
        subject,
        html: finalHtml,
        messageId,
        ...(options?.inReplyTo ? { inReplyTo: options.inReplyTo } : {}),
        ...(options?.references ? { references: options.references } : {}),
        headers: {
            'X-Mailer': 'Superkabe/1.0',
            // RFC 2369 + RFC 8058 one-click unsubscribe headers — Gmail/Yahoo
            // bulk-sender compliance.
            ...(options?.unsubscribeUrl
                ? {
                    'List-Unsubscribe': `<${options.unsubscribeUrl}>`,
                    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
                }
                : {}),
        },
    };

    const composer = new MailComposer(mailOptions);
    const rawBuffer: Buffer = await new Promise((resolve, reject) => {
        composer.compile().build((err: Error | null, message: Buffer) => {
            if (err) reject(err);
            else resolve(message);
        });
    });

    const info = await transporter.sendMail({
        envelope: { from: account.email, to: [to] },
        raw: rawBuffer,
    });

    const smtpMessageId = info.messageId || messageId;

    logger.info(`[SEND] Email sent ${account.email} → ${to}`, {
        provider: account.provider,
        accountId: account.id,
        messageId: smtpMessageId,
        response: info.response,
    });

    // Fire-and-forget: append the same message bytes to the operator's
    // Sent folder so it appears in their Gmail/Outlook UI under "Sent".
    // SMTP alone doesn't do this — Gmail's web UI only shows messages
    // the server placed there directly. Failure here NEVER affects the
    // send result; we just log and move on.
    if (account.smtp_password && account.smtp_host) {
        const imapHost = account.imap_host || (
            account.provider === 'google' ? 'imap.gmail.com' :
            account.provider === 'microsoft' ? 'outlook.office365.com' :
            null
        );
        if (imapHost) {
            const imapPort = account.imap_port || 993;
            const username = account.smtp_username || account.email;
            // The smtp_password field stores the encrypted credential; we
            // need plaintext for IMAP auth. The transporter cache holds
            // the same plaintext but isn't exposed — decrypt here.
            const plaintextPass = readSmtpPassword(account.smtp_password);
            if (plaintextPass) {
                appendToSentFolder({
                    email: account.email,
                    imapHost,
                    imapPort,
                    username,
                    password: plaintextPass,
                    provider: account.provider,
                    rfc822: rawBuffer,
                }).catch(() => undefined);
            }
        }
    }

    return { success: true, messageId: smtpMessageId };
}

// ────────────────────────────────────────────────────────────────────
// Gmail Adapter — prefers SMTP with app password
//
// Send priority is intentionally SMTP-FIRST. Reasons:
//   1. SMTP requires no Restricted-scope verification or CASA — Google
//      treats SMTP via app password as a normal authenticated user.
//   2. Inbox placement is identical (same Gmail outbound MTA either way).
//   3. The Gmail API path is grandfathered for legacy users who connected
//      via OAuth before bulk import existed; it stays as a fallback.
//
// Order: SMTP creds present → SMTP. Else OAuth tokens present → API.
// Else error.
// ────────────────────────────────────────────────────────────────────

export async function sendViaGmail(
    account: ConnectedAccountInput,
    to: string,
    subject: string,
    bodyHtml: string,
    options?: SendOptions
): Promise<SendResult> {
    // Preferred: SMTP with app password (from bulk import or manual setup).
    if (account.smtp_host && account.smtp_password) {
        return sendViaSMTP(account, to, subject, bodyHtml, options);
    }

    // Fallback: Gmail API (legacy OAuth path).
    if (account.access_token && account.refresh_token) {
        const accessToken = await ensureFreshAccessToken(account);

        let finalHtml = bodyHtml;
        if (account.signature_html) {
            finalHtml += `<br/><div style="margin-top:16px;border-top:1px solid #e5e5e5;padding-top:12px">${account.signature_html}</div>`;
        }

        const { messageId } = await sendEmailViaGmailApi(accessToken, account.email, to, subject, finalHtml, options);
        logger.info(`[SEND] Gmail API sent ${account.email} → ${to}`, { messageId });
        return { success: true, messageId };
    }

    return {
        success: false,
        error: 'Gmail account has no SMTP credentials or OAuth tokens. Reconnect the mailbox.',
    };
}

// ────────────────────────────────────────────────────────────────────
// Microsoft Adapter — prefers SMTP with app password
//
// Same priority logic as Gmail: SMTP first (no Microsoft Graph permission
// review needed), Graph API fallback for legacy connections.
//
// NOTE: Microsoft 365 SMTP AUTH must be enabled at the tenant level by
// the Workspace admin. Some enterprise tenants disable it for security
// policy reasons — those will fall through to the Graph API path.
// ────────────────────────────────────────────────────────────────────

export async function sendViaMicrosoft(
    account: ConnectedAccountInput,
    to: string,
    subject: string,
    bodyHtml: string,
    options?: SendOptions
): Promise<SendResult> {
    // Preferred: SMTP with app password / SMTP AUTH credentials.
    if (account.smtp_host && account.smtp_password) {
        return sendViaSMTP(account, to, subject, bodyHtml, options);
    }

    // Fallback: Microsoft Graph API (legacy OAuth path).
    if (account.access_token && account.refresh_token) {
        const accessToken = await ensureFreshAccessToken(account);

        let finalHtml = bodyHtml;
        if (account.signature_html) {
            finalHtml += `<br/><div style="margin-top:16px;border-top:1px solid #e5e5e5;padding-top:12px">${account.signature_html}</div>`;
        }

        const { messageId } = await sendEmailViaGraph(accessToken, account.email, to, subject, finalHtml, options);
        logger.info(`[SEND] Graph API sent ${account.email} → ${to}`, { messageId });
        return { success: true, messageId };
    }

    return {
        success: false,
        error: 'Microsoft account has no SMTP credentials or OAuth tokens. Reconnect the mailbox.',
    };
}

// ────────────────────────────────────────────────────────────────────
// Dispatcher
// ────────────────────────────────────────────────────────────────────

export async function sendEmail(
    account: ConnectedAccountInput,
    to: string,
    subject: string,
    bodyHtml: string,
    options?: SendOptions
): Promise<SendResult> {
    try {
        // Super Sender routing — if the workspace owns an active dedicated
        // IP and the mailbox is SES-eligible (SMTP/relay, not OAuth), we
        // intercept and send through SES with the IP's pool. Daily-cap is
        // claimed atomically inside resolveRouteForSend; on cap exhaustion
        // or no IP we fall through to the native transport untouched.
        // Failure on the SES path refunds the cap claim and falls back to
        // native — never blocks the send.
        if (account.organization_id) {
            const { resolveRouteForSend, refundCapClaim } = await import('./superSenderRouting');
            const decision = await resolveRouteForSend({
                organizationId: account.organization_id,
                provider: account.provider,
            });
            if (decision.route === 'ses') {
                const { sendViaSes } = await import('./sesSenderService');
                const result = await sendViaSes({
                    poolName: decision.ip.pool_name,
                    fromEmail: account.email,
                    fromName: account.display_name ?? null,
                    to,
                    subject,
                    bodyHtml,
                    headers: options?.unsubscribeUrl ? {
                        'List-Unsubscribe': `<${options.unsubscribeUrl}>`,
                        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
                    } : undefined,
                });
                if (!result.success) {
                    await refundCapClaim(decision.ip.id);
                    logger.warn('[SEND] SES path failed, falling back to native', {
                        accountId: account.id, ipId: decision.ip.id, err: result.error,
                    });
                    // Fall through to native transport below.
                } else {
                    return result;
                }
            }
        }

        switch (account.provider) {
            case 'google':
                return await sendViaGmail(account, to, subject, bodyHtml, options);
            case 'microsoft':
                return await sendViaMicrosoft(account, to, subject, bodyHtml, options);
            case 'smtp':
            default:
                return await sendViaSMTP(account, to, subject, bodyHtml, options);
        }
    } catch (err: any) {
        logger.error(`[SEND] Failed: ${account.email} → ${to}`, err);

        // Clear the cached transporter on connection errors so next attempt reconnects
        if (err.code === 'ECONNREFUSED' || err.code === 'ESOCKET' || err.code === 'EAUTH' || err.code === 'ETIMEDOUT') {
            clearTransporterCache(account.id);
        }

        // Capture SMTP transcript so sendQueueService can convert 5xx
        // synchronous bounces into BounceEvent rows in real time.
        const smtp = extractSmtp(err);
        return {
            success: false,
            error: err.message || 'Send failed',
            smtpCode: smtp.smtpCode,
            smtpResponse: smtp.smtpResponse,
        };
    }
}
