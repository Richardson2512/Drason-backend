import crypto from 'crypto';
import { Request, Response } from 'express';
import { prisma } from '../index';
import { logger } from '../services/observabilityService';
import { enqueueEvent } from '../services/eventQueue';
import { storeEvent } from '../services/eventService';
import { EventType } from '../types';

/**
 * Maps EmailBison webhook generic event strings to Drason's internal EventType enums.
 */
function mapEmailBisonEventToType(ebEventName: string): EventType | string | null {
    switch (ebEventName) {
        case 'email_sent':
            return EventType.EMAIL_SENT;
        case 'email_opened':
            return 'EmailOpened';
        case 'email_clicked':
            return 'EmailClicked';
        case 'lead_replied':
        case 'lead_interested':
            return 'EmailReplied';
        case 'email_bounced':
            return EventType.HARD_BOUNCE;
        case 'lead_unsubscribed':
            return 'EmailUnsubscribed';
        case 'spam_complaint':
            return 'SpamComplaint';
        default:
            return null; // Ignore unmapped events (e.g., account added/removed)
    }
}

/**
 * Validate HMAC-SHA256 webhook signature.
 * Returns true if valid or if no secret is configured in non-production.
 */
function validateSignature(req: Request, secret: string | null): boolean {
    if (!secret) {
        if (process.env.NODE_ENV === 'production') {
            logger.warn('[EMAILBISON-WEBHOOK] No webhook secret configured — rejecting in production');
            return false;
        }
        return true; // Allow unsigned in development
    }

    const signature = req.headers['x-emailbison-signature'] as string || req.headers['x-webhook-signature'] as string;
    if (!signature) {
        logger.warn('[EMAILBISON-WEBHOOK] Missing signature header');
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
 * EmailBison Webhook Controller
 *
 * Handles real-time events from EmailBison.
 * Resolves org via mailbox lookup (public endpoint — no JWT required).
 * Uses the BullMQ eventQueue for async, decoupled processing.
 */
export const handleEmailBisonWebhook = async (req: Request, res: Response) => {
    try {
        const bodyContent = req.body;

        // Handle varying payload structures (array vs wrapped object)
        const events = Array.isArray(bodyContent) ? bodyContent : (bodyContent.events || [bodyContent]);

        if (events.length === 0) {
            return res.json({ success: true, processed: 0 });
        }

        // Resolve org from the first event's mailbox
        const firstEvent = events[0];
        const firstMailboxIdRaw = firstEvent.email_account_id || firstEvent.mailbox_id || firstEvent.data?.email_account_id;
        const firstMailboxId = firstMailboxIdRaw ? `eb-${firstMailboxIdRaw}` : null;

        if (!firstMailboxId) {
            logger.warn('[EMAILBISON-WEBHOOK] First event missing mailbox ID, cannot resolve org');
            return res.json({ success: false, error: 'Missing mailbox identifier' });
        }

        const mailbox = await prisma.mailbox.findUnique({
            where: { id: firstMailboxId },
            select: { organization_id: true }
        });

        if (!mailbox) {
            logger.info(`[EMAILBISON-WEBHOOK] Mailbox ${firstMailboxId} not found`);
            return res.json({ received: true, warning: 'Mailbox not found' });
        }

        const orgId = mailbox.organization_id;

        // Validate webhook signature using org-specific secret
        const setting = await prisma.organizationSetting.findUnique({
            where: { organization_id_key: { organization_id: orgId, key: 'emailbison_webhook_secret' } }
        });
        if (!validateSignature(req, setting?.value || null)) {
            return res.status(401).json({ error: 'Invalid webhook signature' });
        }

        logger.info(`[EMAILBISON-WEBHOOK] Received ${events.length} event(s)`, { organizationId: orgId });

        // Parse and enqueue each event
        for (const event of events) {
            const ebEventName = event.event || event.type;
            if (!ebEventName) continue;

            const internalEventType = mapEmailBisonEventToType(ebEventName);

            // Skip events Drason doesn't track (e.g., manual_email_sent)
            if (!internalEventType) {
                logger.debug(`[EMAILBISON-WEBHOOK] Skipping unmapped event: ${ebEventName}`);
                continue;
            }

            // Extract IDs and heavily prefix them to match our multi-platform schema
            const mailboxIdRaw = event.email_account_id || event.mailbox_id || event.data?.email_account_id;
            const campaignIdRaw = event.campaign_id || event.data?.campaign_id;
            const eventId = event.id || `eb-evt-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

            const mailboxId = mailboxIdRaw ? `eb-${mailboxIdRaw}` : undefined;
            const campaignId = campaignIdRaw ? `eb-${campaignIdRaw}` : undefined;
            const recipientEmail = event.recipient_email || event.contact_email || event.data?.contact_email;
            const smtpResponse = event.smtp_response || event.bounce_reason || event.data?.bounce_reason;

            if (!mailboxId) {
                logger.warn(`[EMAILBISON-WEBHOOK] Event missing mailbox origin, skipping`, { event });
                continue;
            }

            // 1. Store the raw event in the database (Immutable event sourcing)
            const { eventId: internalDbEventId } = await storeEvent({
                organizationId: orgId,
                eventType: internalEventType as EventType,
                entityType: 'mailbox',
                entityId: mailboxId,
                payload: event, // Store the entire EmailBison native payload for auditing
                idempotencyKey: eventId // Pass eventId as the idempotency key to prevent dupes
            });

            // 2. Enqueue the parsed event to BullMQ
            await enqueueEvent({
                eventId: internalDbEventId,
                eventType: internalEventType,
                entityType: 'mailbox',
                entityId: mailboxId,
                organizationId: orgId,
                campaignId: campaignId,
                recipientEmail: recipientEmail,
                smtpResponse: smtpResponse
            });
        }

        // Return a fast 200 OK so EmailBison does not timeout and retry
        res.json({ success: true, processed: events.length });

    } catch (error: any) {
        logger.error('[EMAILBISON-WEBHOOK] Error processing webhook payload', error, {
            body: req.body
        });

        // Return 200 even on complete parsing failure to prevent retry storms from malformed payloads
        res.json({ success: false, error: 'Processing failed' });
    }
};
