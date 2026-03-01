/**
 * EmailBison Webhook Controller
 *
 * Handles real-time events from EmailBison.
 * Resolves org via mailbox lookup (public endpoint — no JWT required).
 * Uses the BullMQ eventQueue for async, decoupled processing.
 *
 * IMPORTANT: EmailBison delivers a deeply nested payload:
 * {
 *   data: {
 *     event: { type: "EMAIL_SENT", name: "Email Sent", workspace_id: 1 },
 *     data: {
 *       scheduled_email: { id, lead_id, sent_at, ... },
 *       campaign_event: { id, type, created_at, ... },
 *       lead: { id, email, first_name, last_name, bounces, ... },
 *       campaign: { id, name },
 *       sender_email: { id, email, bounced, ... }
 *     }
 *   }
 * }
 */

import crypto from 'crypto';
import { Request, Response } from 'express';
import { prisma } from '../index';
import { logger } from '../services/observabilityService';
import { enqueueEvent } from '../services/eventQueue';
import { storeEvent } from '../services/eventService';
import { EventType } from '../types';

/**
 * Maps EmailBison webhook event type strings to Drason's internal EventType enums.
 * EmailBison uses UPPERCASE in the payload (e.g., "EMAIL_SENT") but lowercase in the
 * API spec enum (e.g., "email_sent"). We handle both.
 */
function mapEmailBisonEventToType(ebEventName: string): EventType | string | null {
    const normalized = ebEventName.toLowerCase();
    switch (normalized) {
        case 'email_sent':
            return EventType.EMAIL_SENT;
        case 'email_opened':
            return 'EmailOpened';
        case 'email_clicked':
            return 'EmailClicked';
        case 'lead_replied':
        case 'lead_interested':
        case 'lead_first_contacted':
            return 'EmailReplied';
        case 'email_bounced':
            return EventType.HARD_BOUNCE;
        case 'lead_unsubscribed':
            return 'EmailUnsubscribed';
        case 'spam_complaint':
            return 'SpamComplaint';
        default:
            return null; // Ignore unmapped events (e.g., email_account_added/removed)
    }
}

/**
 * Extract fields from EmailBison's deeply nested webhook payload.
 * Handles the nested structure: { data: { event: { type }, data: { sender_email, lead, campaign } } }
 * Also handles potential flat payloads as a fallback for forward compatibility.
 */
function extractEmailBisonEvent(rawEvent: any): {
    eventType: string | null;
    senderEmailId: string | number | null;
    senderEmail: string | null;
    campaignId: string | number | null;
    recipientEmail: string | null;
    sentAt: string | null;
    bouncedAt: string | null;
    bounceType: string | null;
    smtpResponse: string | null;
    eventId: string;
} {
    // Try nested structure first (confirmed by API spec)
    const nestedData = rawEvent?.data;
    const eventObj = nestedData?.event;
    const innerData = nestedData?.data;

    // Event type: data.event.type (nested) or flat fallbacks
    const eventType = eventObj?.type
        || rawEvent?.event_type
        || rawEvent?.event
        || rawEvent?.type
        || null;

    // Sender email (mailbox): data.data.sender_email
    const senderEmailObj = innerData?.sender_email;
    const senderEmailId = senderEmailObj?.id
        || rawEvent?.email_account_id
        || rawEvent?.mailbox_id
        || null;
    const senderEmail = senderEmailObj?.email || null;

    // Campaign: data.data.campaign
    const campaignObj = innerData?.campaign;
    const campaignId = campaignObj?.id
        || rawEvent?.campaign_id
        || null;

    // Lead (recipient): data.data.lead
    const leadObj = innerData?.lead;
    const recipientEmail = leadObj?.email
        || rawEvent?.recipient_email
        || rawEvent?.contact_email
        || null;

    // Timing: data.data.scheduled_email.sent_at and campaign_event.created_at
    const scheduledEmail = innerData?.scheduled_email;
    const campaignEvent = innerData?.campaign_event;
    const sentAt = scheduledEmail?.sent_at || null;
    const bouncedAt = campaignEvent?.created_at || null;

    // Bounce info (if available)
    const bounceType = rawEvent?.bounce_type || innerData?.bounce_type || null;
    const smtpResponse = rawEvent?.smtp_response
        || rawEvent?.bounce_reason
        || innerData?.bounce_reason
        || innerData?.smtp_response
        || null;

    // Event ID for idempotency
    const eventId = campaignEvent?.id
        || scheduledEmail?.id
        || rawEvent?.id
        || `eb-evt-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    return {
        eventType,
        senderEmailId,
        senderEmail,
        campaignId,
        recipientEmail,
        sentAt,
        bouncedAt,
        bounceType,
        smtpResponse,
        eventId: String(eventId),
    };
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
 * EmailBison Webhook Handler
 *
 * Handles real-time events from EmailBison.
 * Resolves org via mailbox lookup (public endpoint — no JWT required).
 * Uses the BullMQ eventQueue for async, decoupled processing.
 */
export const handleEmailBisonWebhook = async (req: Request, res: Response) => {
    try {
        const bodyContent = req.body;

        // EmailBison delivers a single event per POST (wrapped in { data: ... })
        // Also handle potential array payloads for forward compatibility
        const rawEvents = Array.isArray(bodyContent)
            ? bodyContent
            : (bodyContent.events || [bodyContent]);

        if (rawEvents.length === 0) {
            return res.json({ success: true, processed: 0 });
        }

        // Extract fields from the first event to resolve org
        const firstExtracted = extractEmailBisonEvent(rawEvents[0]);
        const firstMailboxId = firstExtracted.senderEmailId
            ? `eb-${firstExtracted.senderEmailId}`
            : null;

        if (!firstMailboxId) {
            logger.warn('[EMAILBISON-WEBHOOK] First event missing sender_email ID, cannot resolve org', {
                rawKeys: Object.keys(rawEvents[0]),
                nestedKeys: rawEvents[0]?.data ? Object.keys(rawEvents[0].data) : [],
            });
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

        logger.info(`[EMAILBISON-WEBHOOK] Received ${rawEvents.length} event(s)`, { organizationId: orgId });

        // Parse and enqueue each event
        for (const rawEvent of rawEvents) {
            const extracted = extractEmailBisonEvent(rawEvent);

            if (!extracted.eventType) {
                logger.debug('[EMAILBISON-WEBHOOK] Event missing type, skipping', {
                    rawKeys: Object.keys(rawEvent),
                });
                continue;
            }

            const internalEventType = mapEmailBisonEventToType(extracted.eventType);
            if (!internalEventType) {
                logger.debug(`[EMAILBISON-WEBHOOK] Skipping unmapped event: ${extracted.eventType}`);
                continue;
            }

            const mailboxId = extracted.senderEmailId
                ? `eb-${extracted.senderEmailId}`
                : undefined;
            const campaignId = extracted.campaignId
                ? `eb-${extracted.campaignId}`
                : undefined;

            if (!mailboxId) {
                logger.warn('[EMAILBISON-WEBHOOK] Event missing sender_email ID, skipping', {
                    eventType: extracted.eventType,
                });
                continue;
            }

            // 1. Store raw event for immutable event sourcing
            const { eventId: internalDbEventId } = await storeEvent({
                organizationId: orgId,
                eventType: internalEventType as EventType,
                entityType: 'mailbox',
                entityId: mailboxId,
                payload: rawEvent, // Store full native payload for auditing
                idempotencyKey: extracted.eventId,
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
                recipientEmail: extracted.recipientEmail || undefined,
                smtpResponse: extracted.smtpResponse || undefined,
                bounceType: isBounce ? (extracted.bounceType || 'hard') : undefined,
                sentAt: isBounce ? (extracted.sentAt || undefined) : undefined,
                bouncedAt: isBounce ? (extracted.bouncedAt || new Date().toISOString()) : undefined,
            });
        }

        // Return a fast 200 OK so EmailBison does not timeout and retry
        res.json({ success: true, processed: rawEvents.length });

    } catch (error: any) {
        logger.error('[EMAILBISON-WEBHOOK] Error processing webhook payload', error, {
            body: req.body
        });

        // Return 200 even on complete parsing failure to prevent retry storms from malformed payloads
        res.json({ success: false, error: 'Processing failed' });
    }
};
