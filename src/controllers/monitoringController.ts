/**
 * Monitoring Controller
 * 
 * Handles monitoring events from external systems (Smartlead webhooks)
 * and internal event triggers.
 */

import { Request, Response } from 'express';
import { prisma } from '../index';
import * as monitoringService from '../services/monitoringService';
import * as eventService from '../services/eventService';
import * as eventQueue from '../services/eventQueue';
import { getOrgId } from '../middleware/orgContext';
import { EventType } from '../types';
import { logger } from '../services/observabilityService';

/**
 * Get the webhook secret for an organization from settings.
 */
async function getWebhookSecret(organizationId: string): Promise<string | null> {
    try {
        const setting = await prisma.organizationSetting.findUnique({
            where: {
                organization_id_key: {
                    organization_id: organizationId,
                    key: 'smartlead_webhook_secret'
                }
            }
        });
        return setting?.value || null;
    } catch {
        return null;
    }
}

/**
 * Map Smartlead event types to our EventType enum.
 */
function mapSmartleadEventType(eventType: string): EventType {
    const normalized = eventType.toUpperCase().replace(/_/g, '');

    switch (normalized) {
        case 'EMAILBOUNCE':
        case 'HARDBOUNCE':
        case 'BOUNCE':
            return EventType.HARD_BOUNCE;
        case 'SOFTBOUNCE':
            return EventType.SOFT_BOUNCE;
        case 'EMAILSENT':
        case 'SENT':
            return EventType.EMAIL_SENT;
        case 'DELIVERYFAILURE':
        case 'FAILED':
            return EventType.DELIVERY_FAILURE;
        case 'MAILBOXPAUSED':
            return EventType.MAILBOX_PAUSED;
        case 'MAILBOXRESUMED':
            return EventType.MAILBOX_RESUMED;
        default:
            logger.warn(`[WEBHOOK] Unknown event type received: ${eventType}`);
            return 'UNKNOWN' as EventType;
    }
}

/**
 * Manually trigger a monitoring event.
 * POST /api/monitor/event
 */
export const triggerEvent = async (req: Request, res: Response) => {
    const { eventType, mailboxId, campaignId } = req.body;

    if (!eventType || !mailboxId) {
        return res.status(400).json({ error: 'Missing required fields: eventType, mailboxId' });
    }

    try {
        if (eventType === 'bounce') {
            await monitoringService.recordBounce(mailboxId, campaignId || '');
            res.json({ success: true, message: 'Bounce recorded', mailboxId });
        } else if (eventType === 'sent') {
            await monitoringService.recordSent(mailboxId, campaignId || '');
            res.json({ success: true, message: 'Send recorded', mailboxId });
        } else {
            res.status(400).json({ error: 'Invalid eventType. Use: bounce, sent' });
        }
    } catch (error) {
        logger.error('[MONITOR] Error processing event:', error as Error);
        res.status(500).json({ error: 'Failed to process monitoring event' });
    }
};

/**
 * Validate Smartlead webhook signature.
 * Smartlead signs webhooks with HMAC-SHA256 using your API key as the secret.
 */
function validateWebhookSignature(req: Request, orgSecret: string | null): boolean {
    if (!orgSecret) {
        // In production, BLOCK unsigned webhooks by default
        if (process.env.NODE_ENV === 'production') {
            logger.warn('[WEBHOOK] No webhook secret configured — rejecting in production');
            return false;
        }
        logger.info('[WEBHOOK] No secret configured, allowing in development');
        return true;
    }

    const signature = req.headers['x-smartlead-signature'] as string;
    if (!signature) {
        logger.info('[WEBHOOK] Missing signature header');
        return false;
    }

    const crypto = require('crypto');
    const expectedSignature = crypto
        .createHmac('sha256', orgSecret)
        .update(JSON.stringify(req.body))
        .digest('hex');

    return crypto.timingSafeEqual(
        Buffer.from(signature),
        Buffer.from(expectedSignature)
    );
}

/**
 * Generate idempotency key for webhook events.
 * Combines event attributes to create a unique identifier.
 */
function generateWebhookIdempotencyKey(payload: any): string {
    const parts = [
        payload.event_type || payload.event || 'unknown',
        payload.email_account_id || payload.mailbox_id || '',
        payload.campaign_id || '',
        payload.timestamp || payload.created_at || Date.now().toString(),
        payload.message_id || payload.id || ''
    ];

    const crypto = require('crypto');
    return crypto.createHash('sha256').update(parts.join('-')).digest('hex');
}

/**
 * Handle incoming Smartlead webhooks.
 * POST /api/monitor/smartlead-webhook
 * 
 * Smartlead sends events like:
 * - EMAIL_SENT
 * - EMAIL_BOUNCE
 * - EMAIL_OPENED
 * - EMAIL_REPLIED
 */
export const handleSmartleadWebhook = async (req: Request, res: Response) => {
    const payload = req.body;

    logger.info('[WEBHOOK] Smartlead payload', { preview: JSON.stringify(payload).substring(0, 300) });

    // Generate idempotency key for deduplication
    const idempotencyKey = generateWebhookIdempotencyKey(payload);
    logger.info(`[WEBHOOK] Idempotency key: ${idempotencyKey.substring(0, 12)}...`);

    // Extract event data - Smartlead format varies
    const eventType = payload.event_type || payload.event || payload.type;
    const emailAccountId = payload.email_account_id || payload.mailbox_id;
    const campaignId = payload.campaign_id;

    if (!eventType) {
        logger.info('[WEBHOOK] No event_type in payload, acknowledging anyway');
        return res.json({ received: true });
    }

    try {
        // Find mailbox by Smartlead ID
        let mailbox = null;
        if (emailAccountId) {
            mailbox = await prisma.mailbox.findUnique({
                where: { id: emailAccountId }
            });
        }

        if (!mailbox) {
            logger.info(`[WEBHOOK] Mailbox ${emailAccountId} not found in system`);
            return res.json({ received: true, warning: 'Mailbox not found' });
        }

        const orgId = mailbox.organization_id;

        // Validate webhook signature (blocks unsigned in production)
        const webhookSecret = await getWebhookSecret(orgId);
        if (!validateWebhookSignature(req, webhookSecret)) {
            logger.warn('[WEBHOOK] Invalid or missing signature, rejecting');
            return res.status(401).json({ error: 'Invalid webhook signature' });
        }

        // Store event with idempotency key (prevents duplicate processing)
        const { eventId, isNew } = await eventService.storeEvent({
            organizationId: orgId,
            eventType: mapSmartleadEventType(eventType),
            entityType: 'mailbox',
            entityId: mailbox.id,
            payload,
            idempotencyKey
        });

        if (!isNew) {
            logger.info('[WEBHOOK] Duplicate event, already processed');
            return res.json({ received: true, duplicate: true });
        }

        // Enqueue for async processing (falls back to sync if Redis unavailable)
        const wasEnqueued = await eventQueue.enqueueEvent({
            eventId,
            eventType: mapSmartleadEventType(eventType),
            entityType: 'mailbox',
            entityId: mailbox.id,
            organizationId: orgId,
            campaignId: campaignId || '',
            smtpResponse: payload.smtp_response,
            recipientEmail: payload.recipient_email,
        });

        logger.info(`[WEBHOOK] Event ${wasEnqueued ? 'enqueued' : 'processed sync'}`, {
            eventId,
            mailboxId: mailbox.id,
            eventType,
        });

        res.json({ received: true, processed: !wasEnqueued, enqueued: wasEnqueued });

    } catch (error) {
        logger.error('[WEBHOOK] Error processing Smartlead webhook:', error as Error);
        // Still return 200 to prevent Smartlead from retrying
        res.json({ received: true, error: 'Internal processing error' });
    }
};

/**
 * Get mailbox health status and metrics.
 * GET /api/monitor/mailbox/:id
 */
export const getMailboxHealth = async (req: Request, res: Response) => {
    const { id } = req.params;

    try {
        const orgId = getOrgId(req);

        const mailbox = await prisma.mailbox.findFirst({
            where: {
                id: id as string,
                organization_id: orgId
            },
            include: {
                domain: true,
                metrics: true
            }
        });

        if (!mailbox) {
            return res.status(404).json({ error: 'Mailbox not found' });
        }

        // Get recent state transitions
        const recentTransitions = await prisma.stateTransition.findMany({
            where: {
                organization_id: orgId,
                entity_type: 'mailbox',
                entity_id: id as string
            },
            orderBy: { created_at: 'desc' },
            take: 10
        });

        res.json({
            success: true,
            data: {
                mailbox,
                recentTransitions,
                health: {
                    status: mailbox.status,
                    windowBounceRate: mailbox.window_sent_count > 0
                        ? (mailbox.window_bounce_count / mailbox.window_sent_count * 100).toFixed(2) + '%'
                        : '0%',
                    inCooldown: mailbox.cooldown_until && mailbox.cooldown_until > new Date(),
                    cooldownRemaining: mailbox.cooldown_until
                        ? Math.max(0, mailbox.cooldown_until.getTime() - Date.now())
                        : 0
                }
            }
        });
    } catch (error) {
        logger.error('[MONITOR] Error getting mailbox health:', error as Error);
        res.status(500).json({ error: 'Failed to get mailbox health' });
    }
};
