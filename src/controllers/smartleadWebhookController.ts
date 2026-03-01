/**
 * Smartlead Webhook Controller
 *
 * Handles real-time events from Smartlead including bounces, deliveries, opens, clicks, and replies.
 * Critical for tracking deliverability health and bounce rates.
 */

import { Request, Response } from 'express';
import { prisma } from '../index';
import { logger } from '../services/observabilityService';
import * as auditLogService from '../services/auditLogService';
import { getOrgId } from '../middleware/orgContext';
import { EventType } from '../types';
import * as eventParserService from "../services/smartleadEventParserService";
import { storeEvent } from '../services/eventService';
import { enqueueEvent } from '../services/eventQueue';

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
        const orgId = getOrgId(req);
        const event = req.body;

        logger.info('[SMARTLEAD-WEBHOOK] Received event', {
            organizationId: orgId,
            eventType: event.event_type || event.type,
            eventId: event.id,
            email: event.email || event.lead_email,
            campaignId: event.campaign_id,
            mailboxId: event.email_account_id || event.mailbox_id
        });

        // Validate required fields
        if (!event.event_type && !event.type) {
            return res.status(400).json({
                success: false,
                error: 'Missing event_type field'
            });
        }

        const eventType = event.event_type || event.type;

        // Route event to appropriate handler
        switch (eventType) {
            case 'email_bounced':
            case 'bounce':
            case 'hard_bounce':
            case 'soft_bounce': {
                // Route bounces through the unified queue path (same as EmailBison/Instantly)
                const mailboxIdRaw = event.email_account_id || event.mailbox_id;
                const campaignIdRaw = event.campaign_id;
                const mailboxId = mailboxIdRaw ? String(mailboxIdRaw) : undefined;
                const campaignId = campaignIdRaw ? String(campaignIdRaw) : undefined;
                const recipientEmail = event.email || event.lead_email;
                const smtpResponse = event.bounce_reason || event.reason || '';
                const bounceType = event.bounce_type || 'hard';
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
            case 'sent':
                await eventParserService.handleSentEvent(orgId, event);
                break;

            case 'email_opened':
            case 'opened':
                await eventParserService.handleOpenEvent(orgId, event);
                break;

            case 'email_clicked':
            case 'clicked':
                await eventParserService.handleClickEvent(orgId, event);
                break;

            case 'email_replied':
            case 'replied':
                await eventParserService.handleReplyEvent(orgId, event);
                break;

            case 'email_unsubscribed':
            case 'unsubscribed':
                await eventParserService.handleUnsubscribeEvent(orgId, event);
                break;

            case 'email_spam_reported':
            case 'spam_complaint':
                await eventParserService.handleSpamEvent(orgId, event);
                break;

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