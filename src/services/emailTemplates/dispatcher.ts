/**
 * Email dispatcher - the single send-site every transactional email goes
 * through.
 *
 * Handles the cross-cutting concerns that every individual email needs but
 * we don't want repeated:
 *
 *   1. Recipient resolution. Most operational emails go to org admins,
 *      not just one user. We look those up here based on the audience type.
 *   2. Idempotency. Resend dedupes on Idempotency-Key; we mint stable keys
 *      from the event id + entity id so a worker retry doesn't double-send.
 *   3. Tagging. Resend's analytics dashboard groups by tags; we always
 *      attach `category` and `event_kind`.
 *   4. Fail-safe. Email send failures must never crash the worker / request
 *      that triggered them - they're side effects, not gates. We log and
 *      swallow non-throw paths from sendTransactionalEmail.
 *   5. Dev-mode logging. When RESEND_API_KEY is unset we want a clear log
 *      of what would have been sent, with subject + recipient.
 *
 * Each individual template lives in its own file (e.g. `passwordReset.ts`)
 * and exports a `renderXxxEmail(params)` function returning
 * `{ subject, html, text, preheader }`. The dispatcher takes that envelope
 * plus an `EmailEvent` shape and drives delivery.
 */

import { prisma } from '../../prisma';
import { logger } from '../observabilityService';
import { sendTransactionalEmail } from '../transactionalEmailService';

/**
 * Shape every template renderer returns.
 *
 * Defined here (not on individual templates) so any future template can
 * `import type { RenderedEmail } from './dispatcher'` without a circular
 * dependency on the password-reset module.
 */
export interface RenderedEmail {
    subject: string;
    html: string;
    text: string;
    /** Inbox preview snippet - for logger / observability, never delivered. */
    preheader: string;
}

/** Where a given email should go. */
export type Audience =
    | { kind: 'user'; userId: string }
    | { kind: 'email'; email: string }
    | { kind: 'org-admins'; organizationId: string }
    | { kind: 'org-all-members'; organizationId: string };

export interface DispatchEmailParams {
    /** Pre-rendered template output. */
    rendered: RenderedEmail;
    /** Who to send to. */
    audience: Audience;
    /** Stable category for Resend analytics + log filtering. */
    category: EmailCategory;
    /** Concrete event kind - tighter grouping than category. */
    eventKind: string;
    /**
     * Stable per-event identifier so a retry doesn't double-send. Combine
     * the entity id with the event timestamp / counter that uniquely names
     * THIS occurrence (not just "this user got a reset link" - that would
     * dedupe the *next* request hour). Examples:
     *   - `pwreset:${userId}:${tokenHash[:16]}`
     *   - `mailbox-paused:${mailboxId}:${pausedAt.getTime()}`
     *   - `trial-ending:${orgId}:${daysRemaining}`
     */
    idempotencyKey: string;
    /**
     * Skip the "no API key configured" warning when we're intentionally
     * in dev mode. Default false - most callers want to know when sends
     * are silently dropped.
     */
    quiet?: boolean;
}

/**
 * High-level taxonomy for Resend analytics + internal log filtering.
 * Keep stable - these strings flow into the Resend dashboard's tag filter.
 */
export type EmailCategory =
    | 'account_security'
    | 'billing'
    | 'operational_alert'
    | 'integration'
    | 'compliance'
    | 'reporting'
    | 'system';

export interface DispatchResult {
    /** True if Resend accepted the message (or reported skipped-but-known). */
    delivered: boolean;
    /** Recipients actually targeted after audience resolution. */
    recipients: string[];
    /** Resend message id when delivered, else null. */
    messageId: string | null;
    /** Reason for non-delivery (e.g. "no_recipients", "missing_api_key"). */
    skippedReason?: string;
}

/**
 * The one entry point. Every wire-up site calls this - they don't import
 * sendTransactionalEmail directly.
 */
export async function dispatchEmail(params: DispatchEmailParams): Promise<DispatchResult> {
    const recipients = await resolveAudience(params.audience);

    if (recipients.length === 0) {
        logger.info('[EMAIL_DISPATCH] No recipients resolved - skipped', {
            eventKind: params.eventKind,
            audience: params.audience,
        });
        return { delivered: false, recipients: [], messageId: null, skippedReason: 'no_recipients' };
    }

    try {
        const result = await sendTransactionalEmail({
            to: recipients,
            subject: params.rendered.subject,
            html: params.rendered.html,
            text: params.rendered.text,
            tags: [
                { name: 'category', value: params.category },
                { name: 'event', value: params.eventKind },
            ],
            idempotencyKey: params.idempotencyKey,
        });

        if (!result.sent) {
            // sendTransactionalEmail returns sent:false on missing API key or
            // resend rejection - both are non-fatal but worth logging.
            if (!params.quiet) {
                logger.warn('[EMAIL_DISPATCH] Send returned not-sent', {
                    eventKind: params.eventKind,
                    reason: result.skippedReason,
                    recipients,
                });
            }
            return {
                delivered: false,
                recipients,
                messageId: null,
                skippedReason: result.skippedReason,
            };
        }

        logger.info('[EMAIL_DISPATCH] Sent', {
            eventKind: params.eventKind,
            category: params.category,
            recipients,
            messageId: result.id,
            idempotencyKey: params.idempotencyKey,
        });
        return { delivered: true, recipients, messageId: result.id ?? null };
    } catch (err) {
        // Email is a side effect, NEVER crash the caller (worker tick,
        // billing webhook, login handler, etc.) on a delivery failure.
        logger.error(
            '[EMAIL_DISPATCH] Unhandled error while dispatching',
            err instanceof Error ? err : new Error(String(err)),
            {
                eventKind: params.eventKind,
                audience: params.audience,
            } as any,
        );
        return {
            delivered: false,
            recipients,
            messageId: null,
            skippedReason: 'unhandled_error',
        };
    }
}

// ─── Audience resolution ────────────────────────────────────────────────

async function resolveAudience(audience: Audience): Promise<string[]> {
    switch (audience.kind) {
        case 'email':
            return [audience.email];

        case 'user': {
            const u = await prisma.user.findUnique({
                where: { id: audience.userId },
                select: { email: true },
            });
            return u?.email ? [u.email] : [];
        }

        case 'org-admins': {
            // Operational alerts (mailbox paused, payment failed, etc.) go to
            // every owner/admin in the org. Viewers don't get spammed.
            const users = await prisma.user.findMany({
                where: {
                    organization_id: audience.organizationId,
                    role: { in: ['admin', 'owner'] },
                },
                select: { email: true },
            });
            return users.map(u => u.email).filter(Boolean);
        }

        case 'org-all-members': {
            const users = await prisma.user.findMany({
                where: { organization_id: audience.organizationId },
                select: { email: true },
            });
            return users.map(u => u.email).filter(Boolean);
        }
    }
}
