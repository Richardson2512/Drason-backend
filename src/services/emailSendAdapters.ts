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
import { logger } from './observabilityService';
import { decrypt } from '../utils/encryption';
import { sendEmailViaGmailApi, refreshGoogleAccessToken } from './gmailSendService';
import { sendEmailViaGraph, refreshMicrosoftAccessToken } from './microsoftSendService';
import { prisma } from '../index';

interface ConnectedAccountInput {
    id: string;
    email: string;
    provider: string;
    smtp_host?: string | null;
    smtp_port?: number | null;
    smtp_username?: string | null;
    smtp_password?: string | null;
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
        const { access_token, expires_at } = await refreshGoogleAccessToken(decryptedRefresh);
        const { encrypt } = await import('../utils/encryption');
        await prisma.connectedAccount.update({
            where: { id: account.id },
            data: { access_token: encrypt(access_token), token_expires_at: expires_at },
        });
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
    const pass = account.smtp_password;

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

    const messageId = `<${crypto.randomUUID()}@superkabe.com>`;

    const info = await transporter.sendMail({
        from: account.email,
        to,
        subject,
        html: finalHtml,
        messageId,
        // nodemailer natively emits In-Reply-To / References headers from these fields
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
    });

    const smtpMessageId = info.messageId || messageId;

    logger.info(`[SEND] Email sent ${account.email} → ${to}`, {
        provider: account.provider,
        accountId: account.id,
        messageId: smtpMessageId,
        response: info.response,
    });

    return { success: true, messageId: smtpMessageId };
}

// ────────────────────────────────────────────────────────────────────
// Gmail Adapter — uses SMTP with app password
// (OAuth implementation can be added later)
// ────────────────────────────────────────────────────────────────────

export async function sendViaGmail(
    account: ConnectedAccountInput,
    to: string,
    subject: string,
    bodyHtml: string,
    options?: SendOptions
): Promise<SendResult> {
    // Prefer OAuth (Gmail API) if tokens exist
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

    // Fallback: SMTP with app password (from bulk import)
    if (account.smtp_host && account.smtp_password) {
        return sendViaSMTP(account, to, subject, bodyHtml, options);
    }

    return {
        success: false,
        error: 'Gmail account has no OAuth tokens or SMTP credentials. Reconnect the mailbox.',
    };
}

// ────────────────────────────────────────────────────────────────────
// Microsoft Adapter — uses SMTP with app password
// (OAuth implementation can be added later)
// ────────────────────────────────────────────────────────────────────

export async function sendViaMicrosoft(
    account: ConnectedAccountInput,
    to: string,
    subject: string,
    bodyHtml: string,
    options?: SendOptions
): Promise<SendResult> {
    // Prefer OAuth (Graph API) if tokens exist
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

    // Fallback: SMTP with app password (tenant must have SMTP AUTH enabled)
    if (account.smtp_host && account.smtp_password) {
        return sendViaSMTP(account, to, subject, bodyHtml, options);
    }

    return {
        success: false,
        error: 'Microsoft account has no OAuth tokens or SMTP credentials. Reconnect the mailbox.',
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
