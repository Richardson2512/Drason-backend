/**
 * Warmup Send Service - isolated from production sends.
 *
 * Responsibilities (the user explicitly asked for these to be isolated):
 *   - Send warmup emails via SMTP, never via the production
 *     emailSendAdapters path. This is what guarantees:
 *       * Warmup volume is NOT counted in Mailbox.daily_send_count.
 *       * Warmup sends do NOT create SendEvent rows.
 *       * Warmup bounces do NOT enter the BounceEvent state machine.
 *       * The user's Sent folder is NOT polluted.
 *   - Stamp the X-Superkabe-Warmup HMAC header so the recipient worker
 *     can identify warmup emails on arrival and route them into the
 *     warmup lane (and the imapReplyWorker can SKIP them - see
 *     workers/imapReplyWorker.ts patch).
 *   - Bypass List-Unsubscribe / signature / tracking pixels -
 *     warmup traffic is intra-pool, not customer-facing.
 *
 * Auth strategy:
 *   - SMTP password accounts → standard SMTP AUTH LOGIN
 *   - OAuth accounts (Google / Microsoft) → SMTP via XOAUTH2 using the
 *     stored access token (refreshed on demand if expired)
 *
 * Both paths produce a byte-identical MIME message, so the warmup
 * header is uniform across mailbox provider types.
 */

import * as crypto from 'crypto';
import nodemailer, { type Transporter } from 'nodemailer';
import { prisma } from '../../index';
import { logger } from '../observabilityService';
import { decrypt, isEncrypted } from '../../utils/encryption';
import { refreshGoogleAccessToken } from '../gmailSendService';
import { refreshMicrosoftAccessToken } from '../microsoftSendService';
import { signWarmupHeader, getWarmupHeaderName } from './contentService';

interface ConnectedAccountForWarmup {
    id: string;
    email: string;
    provider: string;
    smtp_host: string | null;
    smtp_port: number | null;
    smtp_username: string | null;
    smtp_password: string | null;
    access_token: string | null;
    refresh_token: string | null;
    token_expires_at: Date | null;
}

export interface WarmupSendInput {
    exchangeId: string;
    senderMailboxId: string;
    senderConnectedAccountId: string;
    recipientMailboxId: string;
    recipientEmail: string;
    subject: string;
    body: string;
    isHtml: boolean;
    /** When sending a reply, threading headers from the parent. */
    inReplyToMessageId?: string | null;
    referencesHeader?: string | null;
}

export interface WarmupSendResult {
    success: boolean;
    messageId?: string;
    error?: string;
}

// ────────────────────────────────────────────────────────────────────
// Decrypt the stored secret/token. Mirrors emailSendAdapters' helper
// so credential storage stays consistent with production.
// ────────────────────────────────────────────────────────────────────

function readSecret(stored: string | null): string | null {
    if (!stored) return null;
    return isEncrypted(stored) ? decrypt(stored) : stored;
}

// ────────────────────────────────────────────────────────────────────
// Build a transporter for a single send. We do NOT cache here because:
//   1. Warmup volume per mailbox is low (≤50/day), so connection reuse
//      doesn't move the needle.
//   2. Caching across the production cache would couple warmup to the
//      production send path, which violates the isolation rule.
// ────────────────────────────────────────────────────────────────────

async function buildTransporter(account: ConnectedAccountForWarmup): Promise<Transporter> {
    // SMTP-password path - same as production.
    if (account.smtp_host && account.smtp_password) {
        const port = account.smtp_port || 587;
        return nodemailer.createTransport({
            host: account.smtp_host,
            port,
            secure: port === 465,
            auth: {
                user: account.smtp_username || account.email,
                pass: readSecret(account.smtp_password)!,
            },
            tls: { rejectUnauthorized: false },
            connectionTimeout: 15_000,
            greetingTimeout: 10_000,
            socketTimeout: 30_000,
        });
    }

    // OAuth path - Google / Microsoft. SMTP via XOAUTH2.
    const accessToken = await getValidOAuthAccessToken(account);
    const isGoogle = account.provider === 'google' || account.provider === 'GOOGLE';
    const host = isGoogle ? 'smtp.gmail.com' : 'smtp.office365.com';
    const port = isGoogle ? 465 : 587;

    return nodemailer.createTransport({
        host,
        port,
        secure: isGoogle, // 465 = TLS, 587 = STARTTLS
        auth: {
            type: 'OAuth2',
            user: account.email,
            accessToken,
        },
        connectionTimeout: 15_000,
        greetingTimeout: 10_000,
        socketTimeout: 30_000,
    });
}

async function getValidOAuthAccessToken(account: ConnectedAccountForWarmup): Promise<string> {
    if (!account.access_token || !account.refresh_token) {
        throw new Error(`OAuth tokens missing for ${account.email}`);
    }

    // Refresh if within 60 seconds of expiry to avoid mid-send failures.
    const accessRaw = readSecret(account.access_token)!;
    const refreshRaw = readSecret(account.refresh_token)!;
    const expiresAt = account.token_expires_at?.getTime() ?? 0;
    const fresh = expiresAt > Date.now() + 60_000;
    if (fresh) return accessRaw;

    if (account.provider === 'google' || account.provider === 'GOOGLE') {
        const refreshed = await refreshGoogleAccessToken(refreshRaw);
        // Persist the rotated tokens so other senders pick them up.
        await prisma.connectedAccount.update({
            where: { id: account.id },
            data: {
                access_token: refreshed.access_token,
                token_expires_at: refreshed.expires_at,
                ...(refreshed.rotated_refresh_token
                    ? { refresh_token: refreshed.rotated_refresh_token }
                    : {}),
            },
        });
        return readSecret(refreshed.access_token)!;
    }

    if (account.provider === 'microsoft' || account.provider === 'MICROSOFT') {
        const refreshed = await refreshMicrosoftAccessToken(refreshRaw);
        await prisma.connectedAccount.update({
            where: { id: account.id },
            data: {
                access_token: refreshed.access_token,
                refresh_token: refreshed.refresh_token,
                token_expires_at: refreshed.expires_at,
            },
        });
        return readSecret(refreshed.access_token)!;
    }

    throw new Error(`Unknown OAuth provider for warmup: ${account.provider}`);
}

// ────────────────────────────────────────────────────────────────────
// Public API - single send.
// ────────────────────────────────────────────────────────────────────

export async function sendWarmupEmail(input: WarmupSendInput): Promise<WarmupSendResult> {
    // Load the sender's ConnectedAccount via mailbox → ConnectedAccount link.
    const mailbox = await prisma.mailbox.findUnique({
        where: { id: input.senderMailboxId },
        include: {
            connectedAccount: {
                select: {
                    id: true,
                    email: true,
                    provider: true,
                    smtp_host: true,
                    smtp_port: true,
                    smtp_username: true,
                    smtp_password: true,
                    access_token: true,
                    refresh_token: true,
                    token_expires_at: true,
                },
            },
            domain: { select: { infra_status: true } },
        },
    });
    if (!mailbox?.connectedAccount) {
        return { success: false, error: 'Sender mailbox has no connected account' };
    }
    // Door B: never warm up a mailbox whose sending IP or domain is on a blocking blacklist.
    // Warming a blacklisted IP is futile (the traffic bounces too) and 'not sendable' must
    // include warmup traffic. Skipped as a soft failure - the pool simply moves on.
    if (mailbox.infra_status === 'action_required' || mailbox.domain?.infra_status === 'action_required') {
        return { success: false, error: 'Sender mailbox infrastructure not ready (blacklisted IP or domain)' };
    }
    const account = mailbox.connectedAccount;
    if (!account.smtp_host && !(account.access_token && account.refresh_token)) {
        return { success: false, error: 'Mailbox has neither SMTP credentials nor OAuth tokens' };
    }

    let transporter: Transporter;
    try {
        transporter = await buildTransporter(account);
    } catch (err) {
        return { success: false, error: `Transporter build failed: ${(err as Error).message}` };
    }

    const messageId = `<${crypto.randomUUID()}@superkabe-warmup.com>`;
    const warmupHeaderValue = signWarmupHeader({
        exchangeId: input.exchangeId,
        senderMailboxId: input.senderMailboxId,
        recipientMailboxId: input.recipientMailboxId,
    });

    // Construct the mail. NO signature, NO List-Unsubscribe, NO tracking
    // pixels - those are production-only concerns. Custom warmup header
    // is required so the recipient worker can identify and route.
    const mailOpts: any = {
        from: account.email,
        to: input.recipientEmail,
        subject: input.subject,
        messageId,
        headers: {
            [getWarmupHeaderName()]: warmupHeaderValue,
            'X-Mailer': 'Superkabe-Warmup/1.0',
        },
    };
    if (input.isHtml) {
        mailOpts.html = input.body;
    } else {
        mailOpts.text = input.body;
    }
    if (input.inReplyToMessageId) mailOpts.inReplyTo = input.inReplyToMessageId;
    if (input.referencesHeader) mailOpts.references = input.referencesHeader;

    try {
        const info = await transporter.sendMail(mailOpts);
        // Tear down - no caching for warmup transporters.
        try { transporter.close(); } catch { /* swallow */ }
        const finalMessageId = (info as any).messageId || messageId;
        return { success: true, messageId: String(finalMessageId).replace(/[<>]/g, '') };
    } catch (err) {
        try { transporter.close(); } catch { /* swallow */ }
        const message = (err as Error).message?.slice(0, 300);
        logger.warn('[WARMUP_SEND] failed', {
            exchangeId: input.exchangeId,
            sender: account.email,
            recipient: input.recipientEmail,
            error: message,
        });
        return { success: false, error: message };
    }
}
