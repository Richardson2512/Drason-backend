/**
 * Transactional Email Service
 *
 * Thin wrapper around Resend's HTTP API for system-generated emails
 * (webhook auto-disable alerts, dead-letter notifications, password reset
 * later, etc.). Distinct from the sequencer's outbound campaign sends —
 * those go through emailSendAdapters with the customer's connected
 * mailboxes; this is for messages FROM Superkabe TO operators.
 *
 * Configuration:
 *   RESEND_API_KEY     — required to actually send. Without it, calls log
 *                        the would-be email and resolve successfully so
 *                        the rest of the platform stays operable.
 *   RESEND_FROM_EMAIL  — e.g. "Superkabe <alerts@superkabe.com>"
 *                        (must be a verified Resend sender)
 *   RESEND_REPLY_TO    — optional reply-to address
 *
 * Resend docs: https://resend.com/docs/api-reference/emails/send-email
 */

import { logger } from './observabilityService';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

export interface SendTransactionalEmailParams {
    to: string | string[];
    subject: string;
    html: string;
    text?: string;             // plain-text fallback; auto-generated from html if absent
    /** Optional override; defaults to RESEND_FROM_EMAIL env. */
    from?: string;
    /** Optional reply-to override. */
    replyTo?: string;
    /** Optional idempotency key — Resend dedupes deliveries with the same key. */
    idempotencyKey?: string;
    /** Tag for delivery analytics in Resend dashboard. */
    tags?: { name: string; value: string }[];
}

export interface SendTransactionalEmailResult {
    sent: boolean;
    /** Resend message ID when sent; null when skipped (no API key). */
    id: string | null;
    /** "missing_api_key" | "missing_from" | "resend_error" — only when sent=false. */
    skippedReason?: string;
}

const FALLBACK_FROM = 'Superkabe <alerts@superkabe.com>';

function htmlToText(html: string): string {
    return html
        .replace(/<\/p>/gi, '\n\n')
        .replace(/<br\s*\/?>(\s*)/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/**
 * Send a transactional email via Resend.
 *
 * Returns `{ sent: false, skippedReason: 'missing_api_key' }` (not throwing)
 * if RESEND_API_KEY is unset — that lets dispatch flows that depend on this
 * service degrade gracefully instead of crashing during local dev.
 */
export async function sendTransactionalEmail(
    params: SendTransactionalEmailParams
): Promise<SendTransactionalEmailResult> {
    const apiKey = process.env.RESEND_API_KEY;
    const from = params.from || process.env.RESEND_FROM_EMAIL || FALLBACK_FROM;
    const replyTo = params.replyTo || process.env.RESEND_REPLY_TO;

    if (!apiKey) {
        logger.warn('[TX_EMAIL] RESEND_API_KEY not set — would have sent', {
            to: params.to,
            subject: params.subject,
        });
        return { sent: false, id: null, skippedReason: 'missing_api_key' };
    }

    const body: Record<string, unknown> = {
        from,
        to: Array.isArray(params.to) ? params.to : [params.to],
        subject: params.subject,
        html: params.html,
        text: params.text || htmlToText(params.html),
    };
    if (replyTo) body.reply_to = replyTo;
    if (params.tags && params.tags.length > 0) body.tags = params.tags;

    const headers: Record<string, string> = {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
    };
    if (params.idempotencyKey) headers['Idempotency-Key'] = params.idempotencyKey;

    try {
        const res = await fetch(RESEND_ENDPOINT, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(15_000),
        });

        if (!res.ok) {
            const text = await res.text().catch(() => '');
            logger.error(`[TX_EMAIL] Resend rejected: ${res.status}`, new Error(text), {
                to: params.to, subject: params.subject,
            });
            return { sent: false, id: null, skippedReason: 'resend_error' };
        }

        const json = await res.json() as { id?: string };
        logger.info(`[TX_EMAIL] Sent to ${params.to} via Resend id=${json.id}`);
        return { sent: true, id: json.id || null };
    } catch (err) {
        logger.error('[TX_EMAIL] Network error sending via Resend', err instanceof Error ? err : new Error(String(err)));
        return { sent: false, id: null, skippedReason: 'resend_error' };
    }
}

/**
 * True when Resend is configured and ready to deliver. Call sites can
 * branch on this to decide whether to fall back to in-app notifications
 * only.
 */
export function isTransactionalEmailConfigured(): boolean {
    return Boolean(process.env.RESEND_API_KEY);
}
