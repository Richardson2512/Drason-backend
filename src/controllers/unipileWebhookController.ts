/**
 * Unipile webhook ingress.
 *
 * Mounted OUTSIDE /api so it doesn't go through extractOrgContext (Unipile
 * has no JWT). Verifies HMAC signature against the raw request body, then
 * dispatches by event type.
 *
 * Event taxonomy we currently handle (see services/unipile/index.ts):
 *   Account status: CREATION_SUCCESS, OK, CREDENTIALS, ERROR, CONNECTING,
 *                   RECONNECTED, SYNC_SUCCESS, DELETED
 *   (Engagement / messaging events land in later phases.)
 *
 * Webhook payloads are structured as:
 *   { event: string, account_id: string, name?: string, timestamp: string,
 *     data?: { ... event-specific ... } }
 *
 * We respond 200 on every authenticated request — Unipile retries 5x with
 * exponential backoff on non-2xx, so persistent failures must surface only
 * via logs, never by 500ing back to Unipile.
 */

import { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { logger } from '../services/observabilityService';
import { verifyUnipileWebhook } from '../services/unipile/client';
import { handleStatusEvent } from '../services/linkedin/accountService';
// classifyReply is now invoked by linkedinReplyTagWorker after the
// 15-min Auto-Tag delay rather than inline on the webhook.

// The express middleware (verifyRawBody whitelist in index.ts) populates
// req.rawBody as a Buffer for Unipile-prefixed paths.
interface RawBodyRequest extends Request {
    rawBody?: Buffer;
}

export const ingest = async (req: RawBodyRequest, res: Response): Promise<Response> => {
    const raw = req.rawBody;
    if (!raw) {
        logger.warn('[UNIPILE-WEBHOOK] No raw body captured — verifyRawBody whitelist missing?');
        return res.status(200).json({ accepted: false, reason: 'no_raw_body' });
    }

    // Pass the entire header bag so the verifier can try every known
    // signature-header name + encoding (Unipile docs don't pin one down).
    if (!verifyUnipileWebhook(raw, req.headers as Record<string, string | string[] | undefined>)) {
        logger.warn('[UNIPILE-WEBHOOK] HMAC verification failed', {
            headerNames: Object.keys(req.headers).filter(k => k.toLowerCase().includes('sig')),
            bodyBytes: raw.length,
        });
        // Still respond 200 to suppress Unipile retries on a bad-secret config;
        // operators see the failure in logs and fix the secret on our side.
        return res.status(200).json({ accepted: false, reason: 'invalid_signature' });
    }

    // Unipile uses two payload shapes:
    //   - Account-status callbacks:    { status: 'CREATION_SUCCESS', account_id, name, ... }
    //   - All other webhook events:    { event: 'new_relation' | 'new message' | ..., account_id, ... }
    // We accept either field as the event identifier so the dispatcher
    // doesn't care which shape arrived.
    const payload = req.body as {
        event?: string;
        status?: string;
        account_id?: string;
        name?: string;
        timestamp?: string;
    };
    const eventName = payload?.event || payload?.status;
    if (!eventName || !payload?.account_id) {
        logger.warn('[UNIPILE-WEBHOOK] Malformed payload', { keys: Object.keys(payload || {}) });
        return res.status(200).json({ accepted: false, reason: 'malformed' });
    }

    try {
        // Dispatch by event family.
        if (isAccountStatusEvent(eventName)) {
            await handleStatusEvent({
                event: eventName,
                account_id: payload.account_id,
                name: payload.name,
                timestamp: payload.timestamp,
            });
        } else if (eventName === 'new_relation') {
            await handleNewRelation(payload as unknown as NewRelationPayload);
        } else if (eventName === 'new message' || eventName === 'message_received') {
            await handleNewMessage(payload as unknown as NewMessagePayload);
        } else {
            logger.info('[UNIPILE-WEBHOOK] Unhandled event type — accepting silently', { event: eventName });
        }
        return res.status(200).json({ accepted: true });
    } catch (err) {
        // Logging only — never 5xx Unipile, retries are not helpful here.
        logger.error('[UNIPILE-WEBHOOK] Handler failed', err instanceof Error ? err : new Error(String(err)));
        return res.status(200).json({ accepted: false, reason: 'handler_error' });
    }
};

// ────────────────────────────────────────────────────────────────────
// Event dispatch helpers
// ────────────────────────────────────────────────────────────────────

const ACCOUNT_STATUS_EVENTS = new Set([
    'CREATION_SUCCESS', 'OK', 'CREDENTIALS', 'ERROR',
    'CONNECTING', 'RECONNECTED', 'SYNC_SUCCESS', 'DELETED',
]);
function isAccountStatusEvent(name: string): boolean {
    return ACCOUNT_STATUS_EVENTS.has(name);
}

/**
 * new_relation — invitation accepted. Lags up to 8h per Unipile docs.
 * Flips the LinkedInConnectionEdge to CONNECTED.
 *
 * Payload fields (confirmed by Unipile docs):
 *   event, account_id, account_type, webhook_name,
 *   user_full_name, user_provider_id, user_public_identifier,
 *   user_profile_url, user_picture_url
 */
interface NewRelationPayload {
    account_id: string;
    user_public_identifier?: string;
    user_provider_id?: string;
    user_full_name?: string;
    user_picture_url?: string;
}
async function handleNewRelation(payload: NewRelationPayload): Promise<void> {
    const acct = await prisma.linkedInAccount.findUnique({
        where: { unipile_account_id: payload.account_id },
        select: { id: true, organization_id: true },
    });
    if (!acct) {
        logger.warn('[UNIPILE-WEBHOOK] new_relation for unknown account', { account_id: payload.account_id });
        return;
    }

    const publicId = payload.user_public_identifier || payload.user_provider_id;
    if (!publicId) {
        logger.warn('[UNIPILE-WEBHOOK] new_relation missing user identifier');
        return;
    }

    const profile = await prisma.linkedInProfile.upsert({
        where: { organization_id_public_identifier: { organization_id: acct.organization_id, public_identifier: publicId } },
        create: {
            organization_id: acct.organization_id,
            public_identifier: publicId,
            member_urn: payload.user_provider_id || null,
            name: payload.user_full_name || publicId,
            profile_picture_url: payload.user_picture_url || null,
        },
        update: payload.user_full_name ? { name: payload.user_full_name } : {},
    });

    await prisma.linkedInConnectionEdge.upsert({
        where: {
            linkedin_account_id_linkedin_profile_id: {
                linkedin_account_id: acct.id,
                linkedin_profile_id: profile.id,
            },
        },
        create: {
            linkedin_account_id: acct.id,
            linkedin_profile_id: profile.id,
            status: 'CONNECTED',
            accepted_at: new Date(),
        },
        update: {
            status: 'CONNECTED',
            accepted_at: new Date(),
        },
    });

    logger.info('[UNIPILE-WEBHOOK] Connection accepted', {
        organization_id: acct.organization_id,
        account_id: payload.account_id,
        profile_id: profile.id,
    });
}

/**
 * new message — incoming DM. Triggers the reply classifier when the
 * lead's first reply lands on a campaign-initiated thread.
 *
 * The fast-path acceptance signal also lives here: if a connection
 * request carried a text note, the lead's first reply is the earliest
 * indicator that the invite was accepted (Unipile's `new_relation`
 * webhook can lag up to 8h). We flip CONNECTED here too.
 *
 * Payload fields (best-effort; Unipile docs are thin):
 *   event, account_id, sender (id / public_id / name), text/content,
 *   thread_id, timestamp
 */
interface NewMessagePayload {
    account_id: string;
    sender?: { id?: string; public_identifier?: string; full_name?: string };
    content?: string;
    text?: string;
    thread_id?: string;
}
async function handleNewMessage(payload: NewMessagePayload): Promise<void> {
    const acct = await prisma.linkedInAccount.findUnique({
        where: { unipile_account_id: payload.account_id },
        select: { id: true, organization_id: true },
    });
    if (!acct) {
        logger.warn('[UNIPILE-WEBHOOK] new_message for unknown account', { account_id: payload.account_id });
        return;
    }

    const senderId = payload.sender?.public_identifier || payload.sender?.id;
    const messageText = payload.content || payload.text || '';
    if (!senderId || !messageText.trim()) {
        logger.debug('[UNIPILE-WEBHOOK] new_message dropped — missing sender or empty body');
        return;
    }

    // Upsert the profile + flip edge to CONNECTED if it was INVITE_SENT
    // (fast-path acceptance signal — the lead's first reply means the
    // invite must have been accepted).
    const profile = await prisma.linkedInProfile.upsert({
        where: { organization_id_public_identifier: { organization_id: acct.organization_id, public_identifier: senderId } },
        create: {
            organization_id: acct.organization_id,
            public_identifier: senderId,
            name: payload.sender?.full_name || senderId,
        },
        update: payload.sender?.full_name ? { name: payload.sender.full_name } : {},
    });

    const edge = await prisma.linkedInConnectionEdge.findUnique({
        where: {
            linkedin_account_id_linkedin_profile_id: {
                linkedin_account_id: acct.id,
                linkedin_profile_id: profile.id,
            },
        },
    });
    if (edge?.status === 'INVITE_SENT') {
        await prisma.linkedInConnectionEdge.update({
            where: {
                linkedin_account_id_linkedin_profile_id: {
                    linkedin_account_id: acct.id,
                    linkedin_profile_id: profile.id,
                },
            },
            data: { status: 'CONNECTED', accepted_at: new Date() },
        });
        logger.info('[UNIPILE-WEBHOOK] Fast-path acceptance via first reply', {
            organization_id: acct.organization_id,
            profile_id: profile.id,
        });
    }

    // 15-minute Auto-Tag delay.
    // Instead of classifying inline (latency: 100ms-2s + delays our 200
    // response back to Unipile, risking retries), stage the pending
    // classification on the profile. linkedinReplyTagWorker scans for
    // rows where auto_tag_pending_at <= now()-15min and runs the
    // classifier then. Latest-text wins: a second message in the 15min
    // window overwrites the pending text and resets the due-at clock.
    try {
        const pending: Prisma.InputJsonValue = {
            text: messageText.slice(0, 4000),
            sender_name: payload.sender?.full_name ?? null,
            thread_id: payload.thread_id ?? null,
        };
        await prisma.linkedInProfile.update({
            where: { id: profile.id },
            data: {
                auto_tag_pending: pending,
                auto_tag_pending_at: new Date(),
            },
        });
    } catch (err) {
        logger.warn('[UNIPILE-WEBHOOK] Failed to stage pending classification', { err: String(err).slice(0, 200) });
    }
}
