import { Request, Response } from 'express';
import { logger } from '../services/observabilityService';
import { getOrgId } from '../middleware/orgContext';
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
 * EmailBison Webhook Controller
 *
 * Handles real-time events from EmailBison.
 * Uses the BullMQ eventQueue for async, decoupled processing to ensure database stability during spikes.
 */
export const handleEmailBisonWebhook = async (req: Request, res: Response) => {
    try {
        const orgId = getOrgId(req);
        // EmailBison payload is typically { events: [...] } or an array directly
        const bodyContent = req.body;

        // Handle varying payload structures (array vs wrapped object)
        const events = Array.isArray(bodyContent) ? bodyContent : (bodyContent.events || [bodyContent]);

        logger.info(`[EMAILBISON-WEBHOOK] Received ${events.length} event(s)`, {
            organizationId: orgId
        });

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
        res.json({ success: false, error: error.message });
    }
};
