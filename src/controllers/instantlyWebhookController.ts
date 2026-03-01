/**
 * Instantly Webhook Controller
 *
 * Handles real-time events from Instantly API V2.
 * Resolves org via mailbox lookup (public endpoint — no JWT required).
 * Event types: email_sent, email_opened, email_clicked, email_bounced,
 *              email_replied, lead_unsubscribed
 *
 * Uses BullMQ eventQueue for async, decoupled processing (same as EmailBison).
 * Returns 200 immediately so Instantly does not retry on slow processing.
 */

import crypto from 'crypto';
import { Request, Response } from 'express';
import { prisma } from '../index';
import { logger } from '../services/observabilityService';
import { enqueueEvent } from '../services/eventQueue';
import { storeEvent } from '../services/eventService';
import { EventType } from '../types';

/**
 * Maps Instantly webhook event_type strings to Drason internal EventType.
 * Instantly V2 event names follow snake_case conventions.
 */
function mapInstantlyEventType(eventName: string): EventType | string | null {
    switch (eventName) {
        case 'email_sent':
            return EventType.EMAIL_SENT;
        case 'email_opened':
            return 'EmailOpened';
        case 'email_clicked':
            return 'EmailClicked';
        case 'email_replied':
            return 'EmailReplied';
        case 'email_bounced':
        case 'bounced':
            return EventType.HARD_BOUNCE;
        case 'lead_unsubscribed':
        case 'email_unsubscribed':
            return 'EmailUnsubscribed';
        case 'spam_block':
        case 'spam_complaint':
            return 'SpamComplaint';
        default:
            return null; // Ignore unsupported events
    }
}

/**
 * Validate HMAC-SHA256 webhook signature.
 * Returns true if valid or if no secret is configured in non-production.
 */
function validateSignature(req: Request, secret: string | null): boolean {
    if (!secret) {
        if (process.env.NODE_ENV === 'production') {
            logger.warn('[INSTANTLY-WEBHOOK] No webhook secret configured — rejecting in production');
            return false;
        }
        return true; // Allow unsigned in development
    }

    const signature = req.headers['x-instantly-signature'] as string || req.headers['x-webhook-signature'] as string;
    if (!signature) {
        logger.warn('[INSTANTLY-WEBHOOK] Missing signature header');
        return false;
    }

    const expectedSignature = crypto
        .createHmac('sha256', secret)
        .update(JSON.stringify(req.body))
        .digest('hex');

    try {
        return crypto.timingSafeEqual(
            Buffer.from(signature),
            Buffer.from(expectedSignature)
        );
    } catch {
        return false; // Length mismatch
    }
}

/**
 * Instantly Webhook Handler
 *
 * Instantly delivers one event object per POST.
 * Payload shape (V2):
 *  {
 *    event_type: "email_bounced",
 *    campaign_id: "uuid",
 *    email_account: "sender@domain.com",   // the sending mailbox
 *    lead_email: "recipient@domain.com",
 *    timestamp: "2026-02-27T12:00:00Z",
 *    bounce_type: "hard" | "soft",
 *    smtp_response: "550 ...",
 *    ... (other event-specific fields)
 *  }
 */
export const handleInstantlyWebhook = async (req: Request, res: Response) => {
    try {
        const body = req.body;

        // Instantly can send a single event or a batch array
        const events: any[] = Array.isArray(body) ? body : [body];

        if (events.length === 0) {
            return res.json({ success: true, processed: 0 });
        }

        // Resolve org from the first event's mailbox
        const firstEvent = events[0];
        const firstSenderEmail = firstEvent.email_account || firstEvent.from_email || firstEvent.account;
        const firstMailboxId = firstSenderEmail ? `inst-${firstSenderEmail}` : null;

        if (!firstMailboxId) {
            logger.warn('[INSTANTLY-WEBHOOK] First event missing email_account, cannot resolve org');
            return res.json({ success: false, error: 'Missing mailbox identifier' });
        }

        const mailbox = await prisma.mailbox.findUnique({
            where: { id: firstMailboxId },
            select: { organization_id: true }
        });

        if (!mailbox) {
            logger.info(`[INSTANTLY-WEBHOOK] Mailbox ${firstMailboxId} not found`);
            return res.json({ received: true, warning: 'Mailbox not found' });
        }

        const orgId = mailbox.organization_id;

        // Validate webhook signature using org-specific secret
        const setting = await prisma.organizationSetting.findUnique({
            where: { organization_id_key: { organization_id: orgId, key: 'instantly_webhook_secret' } }
        });
        if (!validateSignature(req, setting?.value || null)) {
            return res.status(401).json({ error: 'Invalid webhook signature' });
        }

        logger.info(`[INSTANTLY-WEBHOOK] Received ${events.length} event(s)`, {
            organizationId: orgId,
        });

        for (const event of events) {
            const rawEventType = event.event_type || event.type || event.event;
            if (!rawEventType) continue;

            const internalEventType = mapInstantlyEventType(rawEventType);
            if (!internalEventType) {
                logger.debug(`[INSTANTLY-WEBHOOK] Skipping unmapped event: ${rawEventType}`);
                continue;
            }

            // Extract identifiers — Instantly uses email address as account ID
            const senderEmail = event.email_account || event.from_email || event.account;
            const campaignIdRaw = event.campaign_id;
            const recipientEmail = event.lead_email || event.to_email || event.email;
            const smtpResponse =
                event.smtp_response || event.bounce_reason || event.error_message;
            const eventId =
                event.id ||
                event.event_id ||
                `inst-evt-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

            // Prefix IDs to match our multi-platform schema
            const mailboxId = senderEmail ? `inst-${senderEmail}` : undefined;
            const campaignId = campaignIdRaw ? `inst-${campaignIdRaw}` : undefined;

            if (!mailboxId) {
                logger.warn('[INSTANTLY-WEBHOOK] Event missing email_account, skipping', { event });
                continue;
            }

            // 1. Store raw event for audit trail (immutable event sourcing)
            const { eventId: internalDbEventId } = await storeEvent({
                organizationId: orgId,
                eventType: internalEventType as EventType,
                entityType: 'mailbox',
                entityId: mailboxId,
                payload: event,
                idempotencyKey: eventId,
            });

            // 2. Enqueue to BullMQ for async processing
            const isBounce = internalEventType === EventType.HARD_BOUNCE;

            await enqueueEvent({
                eventId: internalDbEventId,
                eventType: internalEventType,
                entityType: 'mailbox',
                entityId: mailboxId,
                organizationId: orgId,
                campaignId,
                recipientEmail,
                smtpResponse,
                bounceType: isBounce ? (event.bounce_type || 'hard') : undefined,
                sentAt: isBounce ? event.sent_at : undefined,
                bouncedAt: isBounce ? (event.timestamp || new Date().toISOString()) : undefined,
            });
        }

        // Fast 200 to prevent Instantly retry storms
        res.json({ success: true, processed: events.length });
    } catch (err: any) {
        logger.error('[INSTANTLY-WEBHOOK] Error processing webhook payload', err, {
            body: req.body,
        });
        // Return 200 even on error to prevent infinite retries from malformed payloads
        res.json({ success: false, error: 'Processing failed' });
    }
};
