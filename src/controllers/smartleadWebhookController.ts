/**
 * Smartlead Webhook Controller
 *
 * Handles real-time events from Smartlead including bounces, deliveries, opens, clicks, and replies.
 * Critical for tracking deliverability health and bounce rates.
 */

import { Request, Response } from 'express';
import { prisma } from '../index';
import { logger } from '../services/observabilityService';
import { EventType } from '../types';
import * as eventParserService from "../services/smartleadEventParserService";
import { storeEvent } from '../services/eventService';
import { enqueueEvent } from '../services/eventQueue';
import { validateWebhookSignature } from '../utils/webhookSignature';


/**
 * Handle Smartlead webhook events.
 *
 * Supported event types:
 * - email_sent: Email sent successfully
 * - email_opened: Recipient opened email
 * - email_clicked: Recipient clicked link
 * - email_replied: Recipient replied
 * - email_bounced: Email bounced (hard or soft)
 * - email_unsubscribed: Recipient unsubscribed
 * - email_spam_reported: Email marked as spam
 * - campaign_status_changed: Campaign status changed in Smartlead
 * - lead_category_updated: Lead categorized in Smartlead
 */
export const handleSmartleadWebhook = async (req: Request, res: Response) => {
    try {
        const event = req.body;

        // Validate required fields
        if (!event.event_type && !event.type) {
            return res.status(400).json({
                success: false,
                error: 'Missing event_type field'
            });
        }

        // Resolve org via mailbox lookup (public endpoint — no JWT)
        // Smartlead webhooks may include email_account_id, mailbox_id, OR from_email
        const mailboxIdRaw = event.email_account_id || event.mailbox_id;
        const fromEmail = event.from_email;

        if (!mailboxIdRaw && !fromEmail) {
            logger.warn('[SMARTLEAD-WEBHOOK] Event missing mailbox identifier', {
                eventType: event.event_type || event.type,
                eventKeys: Object.keys(event),
            });
            return res.json({ success: false, error: 'Missing mailbox identifier' });
        }

        // Look up mailbox by ID first, fall back to from_email
        const mailboxLookupId = mailboxIdRaw ? String(mailboxIdRaw) : null;
        const mailbox = await prisma.mailbox.findFirst({
            where: mailboxLookupId
                ? {
                    OR: [
                        { id: mailboxLookupId },
                        { external_email_account_id: mailboxLookupId },
                    ],
                }
                : { email: fromEmail },
            select: { id: true, organization_id: true },
        });

        if (!mailbox) {
            logger.info(`[SMARTLEAD-WEBHOOK] Mailbox ${mailboxLookupId} not found`);
            return res.json({ received: true, warning: 'Mailbox not found' });
        }

        const orgId = mailbox.organization_id;

        // Validate webhook signature using org-specific secret
        const setting = await prisma.organizationSetting.findUnique({
            where: { organization_id_key: { organization_id: orgId, key: 'smartlead_webhook_secret' } }
        });
        if (!validateWebhookSignature(req, setting?.value || null, ['x-smartlead-signature', 'x-webhook-signature'])) {
            return res.status(401).json({ error: 'Invalid webhook signature' });
        }

        logger.info('[SMARTLEAD-WEBHOOK] Received event', {
            organizationId: orgId,
            eventType: event.event_type || event.type,
            eventId: event.id,
            email: event.email || event.lead_email,
            campaignId: event.campaign_id,
            mailboxId: mailboxLookupId || mailbox?.id,
            resolvedVia: mailboxLookupId ? 'id' : 'from_email'
        });

        const rawEventType = event.event_type || event.type;
        // Normalize: Smartlead sends mixed case (EMAIL_OPEN, email_opened, opened)
        const eventType = rawEventType?.toLowerCase();

        // Route event to appropriate handler
        switch (eventType) {
            case 'email_bounced':
            case 'email_bounce':
            case 'bounce':
            case 'hard_bounce':
            case 'soft_bounce': {
                // Route bounces through the unified queue path (same as EmailBison/Instantly)
                const mailboxIdRaw = event.email_account_id || event.mailbox_id;
                const campaignIdRaw = event.campaign_id;
                // Fall back to resolved mailbox.id if no explicit ID in event
                const mailboxId = mailboxIdRaw ? String(mailboxIdRaw) : mailbox?.id;
                const campaignId = campaignIdRaw ? String(campaignIdRaw) : undefined;
                const recipientEmail = event.email || event.lead_email;
                const smtpResponse = event.bounce_reason || event.reason || '';
                const rawBounceType = event.bounce_type || 'hard';
                const bounceType = (rawBounceType === 'soft' || rawBounceType === 'soft_bounce') ? 'soft_bounce' : 'hard_bounce';
                const eventId = event.id || `sl-evt-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

                if (!mailboxId) {
                    logger.warn('[SMARTLEAD-WEBHOOK] Bounce event missing mailbox ID', { orgId, event });
                    break;
                }

                // 1. Store raw event for immutable event sourcing
                const { eventId: internalDbEventId } = await storeEvent({
                    organizationId: orgId,
                    eventType: EventType.HARD_BOUNCE,
                    entityType: 'mailbox',
                    entityId: mailboxId,
                    payload: event,
                    idempotencyKey: eventId,
                });

                // 2. Enqueue to BullMQ for async processing via bounceProcessingService
                await enqueueEvent({
                    eventId: internalDbEventId,
                    eventType: EventType.HARD_BOUNCE,
                    entityType: 'mailbox',
                    entityId: mailboxId,
                    organizationId: orgId,
                    campaignId,
                    recipientEmail,
                    smtpResponse,
                    bounceType,
                    sentAt: event.sent_at,
                    bouncedAt: event.bounced_at || new Date().toISOString(),
                });
                break;
            }

            case 'email_sent':
            case 'email_send':
            case 'sent':
            case 'email_opened':
            case 'email_open':
            case 'opened':
            case 'email_clicked':
            case 'email_click':
            case 'clicked':
            case 'email_replied':
            case 'email_reply':
            case 'replied':
            case 'email_unsubscribed':
            case 'email_unsubscribe':
            case 'unsubscribed':
            case 'email_spam_reported':
            case 'spam_complaint': {
                // Route ALL engagement/sent/spam/unsub events through the unified queue
                // (same path as EmailBison/Instantly — platform parity)
                const mailboxIdRaw = event.email_account_id || event.mailbox_id;
                const campaignIdRaw = event.campaign_id;
                // Fall back to resolved mailbox.id if no explicit ID in event
                const mailboxId = mailboxIdRaw ? String(mailboxIdRaw) : mailbox?.id;
                const campaignId = campaignIdRaw ? String(campaignIdRaw) : undefined;
                const recipientEmail = event.email || event.lead_email;
                const eventId = event.id || `sl-evt-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

                // Map Smartlead event type to internal queue event type
                const internalEventType =
                    (eventType?.includes('sent') || eventType?.includes('send')) ? EventType.EMAIL_SENT :
                    (eventType?.includes('open')) ? 'EmailOpened' :
                    (eventType?.includes('click')) ? 'EmailClicked' :
                    (eventType?.includes('repl')) ? 'EmailReplied' :
                    (eventType?.includes('unsub')) ? 'EmailUnsubscribed' :
                    'SpamComplaint'; // spam_reported, spam_complaint

                if (!mailboxId) {
                    logger.warn('[SMARTLEAD-WEBHOOK] Event missing mailbox ID', { orgId, eventType });
                    break;
                }

                // 1. Store raw event for immutable event sourcing
                const { eventId: internalDbEventId } = await storeEvent({
                    organizationId: orgId,
                    eventType: internalEventType as EventType,
                    entityType: 'mailbox',
                    entityId: mailboxId,
                    payload: event,
                    idempotencyKey: eventId,
                });

                // 2. Enqueue to BullMQ for async processing
                await enqueueEvent({
                    eventId: internalDbEventId,
                    eventType: internalEventType,
                    entityType: 'mailbox',
                    entityId: mailboxId,
                    organizationId: orgId,
                    campaignId,
                    recipientEmail,
                });
                break;
            }

            case 'campaign_status_changed':
            case 'CAMPAIGN_STATUS_CHANGED':
                await eventParserService.handleCampaignStatusChangedEvent(orgId, event);
                break;

            case 'lead_category_updated':
            case 'LEAD_CATEGORY_UPDATED':
                await eventParserService.handleLeadCategoryUpdatedEvent(orgId, event);
                break;

            default:
                logger.warn('[SMARTLEAD-WEBHOOK] Unknown event type', {
                    organizationId: orgId,
                    eventType,
                    eventKeys: Object.keys(event)
                });
        }

        // Always return 200 to prevent retry storms
        res.json({ success: true, received: true });

    } catch (error: any) {
        logger.error('[SMARTLEAD-WEBHOOK] Error processing webhook', error, {
            body: req.body
        });

        // Still return 200 to prevent retries
        res.json({ success: false, error: 'Processing failed' });
    }
};

/**
 * Handle bounce events - CRITICAL for infrastructure health
 */