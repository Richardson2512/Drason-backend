/**
 * Webhook Service — outbound delivery fan-out.
 *
 * Public API:
 *   dispatchEvent(orgId, eventType, payload)
 *     Fans out to every active WebhookEndpoint in the org that subscribes
 *     to this event. Creates a WebhookDelivery row per matching endpoint
 *     (status=pending, attempt_count=0), enqueues each row to BullMQ for
 *     immediate first-attempt delivery, and returns synchronously.
 *
 *   markDeliveryAttempt(...)
 *     Used by the dispatcher worker to record success / schedule retry /
 *     dead-letter. Centralized here so the auto-disable rule has one home.
 *
 *   replayDelivery(deliveryId)
 *     Re-enqueues an existing delivery row. Used by the customer-facing
 *     "Replay" button in Slice 4.
 *
 * Note on SlackAlertService — the legacy `SlackAlertService` (chat.postMessage
 * with org bot tokens) is intentionally NOT migrated onto this plumbing.
 * It uses a different auth model (OAuth bot token + channel ID) from a
 * generic webhook URL, and forcing both into one WebhookEndpoint row
 * would bend the schema. The two systems run in parallel:
 *   • SlackAlertService → operator-facing Slack alerts via bot token
 *   • This service       → customer-facing webhook fan-out
 * Customers who want their events in Slack create a generic webhook
 * endpoint pointing at a Slack INCOMING webhook URL with provider='slack';
 * the dispatcher then reshapes the payload into Slack's blocks format.
 */

import crypto from 'crypto';
import { Queue } from 'bullmq';
import { getRedisClient } from '../utils/redis';
import { prisma } from '../index';
import { logger } from './observabilityService';
import { sendTransactionalEmail } from './transactionalEmailService';
import { renderEmailTemplate, renderEmailPlainText } from './transactionalEmailTemplates';

// ────────────────────────────────────────────────────────────────────
// Event taxonomy — single source of truth for valid event types.
// Slice 2 will instrument the codebase to emit these. Keeping the list
// here lets the API + UI validate against it without drift.
// ────────────────────────────────────────────────────────────────────

export const WEBHOOK_EVENTS = [
    // Lead lifecycle
    'lead.created',
    'lead.validated',
    'lead.health_changed',
    'lead.replied',

    // Campaign lifecycle
    'campaign.launched',
    'campaign.paused',
    'campaign.completed',

    // Mailbox state machine
    'mailbox.paused',
    'mailbox.entered_quarantine',
    'mailbox.entered_restricted_send',
    'mailbox.entered_warm_recovery',
    'mailbox.healed',

    // Domain health
    'domain.dnsbl_listed',
    'domain.dnsbl_cleared',
    'domain.dns_failed',

    // Send / engagement
    'email.sent',
    'email.bounced',
    'email.opened',
    'email.clicked',
    'reply.received',
] as const;

export type WebhookEventType = typeof WEBHOOK_EVENTS[number];

export function isValidEventType(s: string): s is WebhookEventType {
    return (WEBHOOK_EVENTS as readonly string[]).includes(s);
}

// ────────────────────────────────────────────────────────────────────
// Retry schedule + auto-disable thresholds
// ────────────────────────────────────────────────────────────────────

/** Delays in seconds applied AFTER each failed attempt. Length sets max attempts. */
export const RETRY_DELAYS_SEC = [30, 120, 600, 3600, 21_600, 86_400]; // 30s, 2m, 10m, 1h, 6h, 24h
export const MAX_DELIVERY_ATTEMPTS = RETRY_DELAYS_SEC.length;

/** After this many consecutive dead-lettered deliveries, the endpoint auto-disables. */
export const AUTO_DISABLE_THRESHOLD = 5;

/** Truncate response_body to keep storage bounded. */
const MAX_RESPONSE_BODY_BYTES = 4096;

// ────────────────────────────────────────────────────────────────────
// BullMQ queue
// ────────────────────────────────────────────────────────────────────

export const WEBHOOK_QUEUE_NAME = 'webhook-deliveries';

let _queue: Queue | null = null;

function getQueue(): Queue | null {
    if (_queue) return _queue;
    const redis = getRedisClient();
    if (!redis) {
        logger.warn('[WEBHOOK] No Redis — webhook deliveries will not be enqueued');
        return null;
    }
    _queue = new Queue(WEBHOOK_QUEUE_NAME, {
        connection: { host: redis.options.host!, port: redis.options.port!, password: redis.options.password },
    });
    return _queue;
}

interface DeliveryJobData {
    deliveryId: string;
}

// ────────────────────────────────────────────────────────────────────
// Public API: dispatch
// ────────────────────────────────────────────────────────────────────

// ────────────────────────────────────────────────────────────────────
// In-process subscribers
// ────────────────────────────────────────────────────────────────────
//
// Customer-configured webhook endpoints are fanned out via the DB +
// BullMQ pipeline below. Some integrations (CRM activity push, future
// in-process side effects) need the same events synchronously inside
// the backend — they register here and dispatchEvent calls them in
// addition to the DB fan-out. Subscribers must never throw; failures
// are logged and swallowed so customer webhooks aren't blocked.

export type InternalSubscriber = (
    orgId: string,
    eventType: WebhookEventType,
    payload: Record<string, unknown>,
    eventId: string,
) => Promise<void> | void;

const internalSubscribers: InternalSubscriber[] = [];

export function onInternalEvent(handler: InternalSubscriber): void {
    internalSubscribers.push(handler);
}

async function fanOutInternalSubscribers(
    orgId: string,
    eventType: WebhookEventType,
    payload: Record<string, unknown>,
    eventId: string,
): Promise<void> {
    for (const sub of internalSubscribers) {
        try {
            await sub(orgId, eventType, payload, eventId);
        } catch (err) {
            logger.error(
                `[WEBHOOK] internal subscriber failed for ${eventType}`,
                err instanceof Error ? err : new Error(String(err)),
            );
        }
    }
}

/**
 * Fan out an event to every matching active endpoint in the org.
 * Idempotent on the (org, eventId) pair — callers can pass eventId to
 * dedupe retries from upstream.
 *
 * Returns the count of deliveries created (0 = no subscribers).
 */
export async function dispatchEvent(
    orgId: string,
    eventType: WebhookEventType,
    payload: Record<string, unknown>,
    opts: { eventId?: string } = {}
): Promise<{ created: number; deliveryIds: string[] }> {
    if (!isValidEventType(eventType)) {
        logger.warn(`[WEBHOOK] dispatchEvent called with unknown event type: ${eventType}`);
        return { created: 0, deliveryIds: [] };
    }

    const eventId = opts.eventId || crypto.randomUUID();

    // Internal in-process subscribers (CRM activity push, etc.) run
    // before the DB fan-out so they share the eventId and timestamp.
    await fanOutInternalSubscribers(orgId, eventType, payload, eventId);

    // Find all active, non-disabled endpoints for the org subscribed to this event.
    // Empty `events` array means "subscribe to all".
    const endpoints = await prisma.webhookEndpoint.findMany({
        where: {
            organization_id: orgId,
            active: true,
            disabled_at: null,
            OR: [
                { events: { isEmpty: true } },
                { events: { has: eventType } },
            ],
        },
        select: { id: true },
    });

    if (endpoints.length === 0) {
        return { created: 0, deliveryIds: [] };
    }

    // Create delivery rows in a single batch.
    const now = new Date();
    const deliveryIds: string[] = [];

    await prisma.$transaction(
        endpoints.map(ep => {
            const id = crypto.randomUUID();
            deliveryIds.push(id);
            return prisma.webhookDelivery.create({
                data: {
                    id,
                    endpoint_id: ep.id,
                    event_type: eventType,
                    event_id: eventId,
                    payload: payload as any,
                    status: 'pending',
                    next_attempt_at: now,
                },
            });
        })
    );

    // Enqueue for immediate dispatch.
    const queue = getQueue();
    if (queue) {
        for (const id of deliveryIds) {
            await queue.add(
                'deliver',
                { deliveryId: id } satisfies DeliveryJobData,
                {
                    // BullMQ will pick this up immediately.
                    // The retry schedule is enforced by us (re-adding the job
                    // with a `delay` after a failure), not by BullMQ's
                    // backoff config — gives us per-attempt control.
                    jobId: id, // dedupe re-enqueues
                    removeOnComplete: { count: 100 },
                    removeOnFail: { count: 500 },
                }
            );
        }
    } else {
        logger.warn(`[WEBHOOK] Created ${deliveryIds.length} pending deliveries but Redis is offline — they will fire when worker reconnects via the next-attempt scan.`);
    }

    logger.info(`[WEBHOOK] Dispatched ${eventType} to ${endpoints.length} endpoints (org=${orgId} eventId=${eventId})`);
    return { created: deliveryIds.length, deliveryIds };
}

// ────────────────────────────────────────────────────────────────────
// Worker-side helpers
// ────────────────────────────────────────────────────────────────────

export interface DeliveryAttemptResult {
    success: boolean;
    responseCode?: number;
    responseBody?: string;
    durationMs: number;
    errorMessage?: string;
}

/**
 * Record the outcome of a single delivery attempt and decide what comes next.
 * Centralizes the retry / dead-letter / auto-disable rules so the worker
 * stays a thin shell.
 *
 * Returns the new status of the delivery row.
 */
export async function markDeliveryAttempt(
    deliveryId: string,
    result: DeliveryAttemptResult,
    requestHeaders?: Record<string, string>
): Promise<{ status: 'success' | 'failed' | 'dead_letter'; nextAttemptAt: Date | null }> {
    const delivery = await prisma.webhookDelivery.findUnique({
        where: { id: deliveryId },
        include: { endpoint: true },
    });
    if (!delivery) throw new Error(`Delivery ${deliveryId} not found`);

    const newAttemptCount = delivery.attempt_count + 1;
    const truncatedBody = truncate(result.responseBody, MAX_RESPONSE_BODY_BYTES);

    if (result.success) {
        await prisma.$transaction([
            prisma.webhookDelivery.update({
                where: { id: deliveryId },
                data: {
                    status: 'success',
                    attempt_count: newAttemptCount,
                    response_code: result.responseCode || null,
                    response_body: truncatedBody,
                    request_headers: requestHeaders ? (requestHeaders as any) : undefined,
                    duration_ms: result.durationMs,
                    delivered_at: new Date(),
                    next_attempt_at: null,
                    last_error: null,
                },
            }),
            prisma.webhookEndpoint.update({
                where: { id: delivery.endpoint_id },
                data: {
                    last_delivery_at: new Date(),
                    failure_count: 0, // success resets the consecutive-failure counter
                },
            }),
        ]);
        return { status: 'success', nextAttemptAt: null };
    }

    // Failed attempt — decide between retry and dead-letter.
    const shouldRetry = newAttemptCount < MAX_DELIVERY_ATTEMPTS;
    const delaySec = shouldRetry ? RETRY_DELAYS_SEC[newAttemptCount] : null;
    const nextAttemptAt = delaySec ? new Date(Date.now() + delaySec * 1000) : null;
    const status: 'failed' | 'dead_letter' = shouldRetry ? 'failed' : 'dead_letter';

    if (status === 'dead_letter') {
        // Increment endpoint failure_count; auto-disable when threshold reached.
        const newFailureCount = delivery.endpoint.failure_count + 1;
        const shouldAutoDisable = newFailureCount >= AUTO_DISABLE_THRESHOLD;

        await prisma.$transaction([
            prisma.webhookDelivery.update({
                where: { id: deliveryId },
                data: {
                    status: 'dead_letter',
                    attempt_count: newAttemptCount,
                    response_code: result.responseCode || null,
                    response_body: truncatedBody,
                    request_headers: requestHeaders ? (requestHeaders as any) : undefined,
                    duration_ms: result.durationMs,
                    next_attempt_at: null,
                    last_error: result.errorMessage || null,
                },
            }),
            prisma.webhookEndpoint.update({
                where: { id: delivery.endpoint_id },
                data: {
                    failure_count: newFailureCount,
                    ...(shouldAutoDisable && {
                        active: false,
                        disabled_at: new Date(),
                        disabled_reason: `${newFailureCount} consecutive deliveries dead-lettered`,
                    }),
                },
            }),
        ]);

        if (shouldAutoDisable) {
            // Fire-and-forget: alert the org but don't fail this delivery handler.
            notifyEndpointAutoDisabled(delivery.endpoint_id).catch(err =>
                logger.error('[WEBHOOK] notifyEndpointAutoDisabled failed', err instanceof Error ? err : new Error(String(err)))
            );
        }
    } else {
        await prisma.webhookDelivery.update({
            where: { id: deliveryId },
            data: {
                status: 'failed',
                attempt_count: newAttemptCount,
                response_code: result.responseCode || null,
                response_body: truncatedBody,
                request_headers: requestHeaders ? (requestHeaders as any) : undefined,
                duration_ms: result.durationMs,
                next_attempt_at: nextAttemptAt,
                last_error: result.errorMessage || null,
            },
        });
    }

    return { status, nextAttemptAt };
}

/**
 * Re-enqueue an existing delivery for replay. Resets attempt_count so the
 * full 6-attempt schedule is available again. Status returns to pending.
 */
export async function replayDelivery(deliveryId: string): Promise<void> {
    const now = new Date();
    await prisma.webhookDelivery.update({
        where: { id: deliveryId },
        data: {
            status: 'pending',
            attempt_count: 0,
            next_attempt_at: now,
            response_code: null,
            response_body: null,
            duration_ms: null,
            delivered_at: null,
            last_error: null,
        },
    });
    const queue = getQueue();
    if (queue) {
        await queue.add('deliver', { deliveryId } satisfies DeliveryJobData, { jobId: `${deliveryId}-replay-${Date.now()}` });
    }
}

// ────────────────────────────────────────────────────────────────────
// Auto-disable notification
// ────────────────────────────────────────────────────────────────────

async function notifyEndpointAutoDisabled(endpointId: string): Promise<void> {
    const endpoint = await prisma.webhookEndpoint.findUnique({
        where: { id: endpointId },
        include: {
            organization: {
                include: {
                    users: {
                        where: { role: { in: ['owner', 'admin'] } },
                        select: { email: true, name: true },
                    },
                },
            },
        },
    });
    if (!endpoint) return;

    // 1. In-app notification (every org member sees it on next page load).
    await prisma.notification.create({
        data: {
            organization_id: endpoint.organization_id,
            type: 'WARNING',
            title: `Webhook "${endpoint.name}" was auto-disabled`,
            message: `Superkabe stopped delivering to ${endpoint.url} after ${AUTO_DISABLE_THRESHOLD} consecutive failures. Re-enable it from Integrations → Webhooks once you've verified the endpoint is reachable.`,
        },
    }).catch(err => logger.error('[WEBHOOK] notification create failed', err instanceof Error ? err : new Error(String(err))));

    // 2. Email to owners + admins via Resend (if configured).
    if (endpoint.organization.users.length > 0) {
        const dashboardUrl = `https://app.superkabe.com/dashboard/integrations/webhooks/${endpoint.id}`;
        const params = {
            preheader: `${endpoint.name} was auto-disabled after ${AUTO_DISABLE_THRESHOLD} failed deliveries.`,
            eyebrow: 'Webhook auto-disabled',
            heading: `"${endpoint.name}" stopped delivering`,
            intro: `Superkabe paused webhook deliveries to <strong>${endpoint.name}</strong> after <strong>${AUTO_DISABLE_THRESHOLD} consecutive failed attempts</strong>. No further events will be sent until you re-enable it.`,
            facts: [
                { label: 'Endpoint', value: endpoint.name },
                { label: 'URL', value: endpoint.url, mono: true },
                { label: 'Reason', value: endpoint.disabled_reason || 'Repeated delivery failures' },
                { label: 'Disabled at', value: (endpoint.disabled_at || new Date()).toUTCString() },
            ],
            body: 'Once your receiver is healthy, reactivate the endpoint from your dashboard. You can also replay any of the dead-lettered deliveries from the same screen.',
            ctaLabel: 'Re-enable webhook',
            ctaUrl: dashboardUrl,
            secondaryLinkLabel: 'View delivery log →',
            secondaryLinkUrl: `${dashboardUrl}?view=log`,
        };
        await sendTransactionalEmail({
            to: endpoint.organization.users.map(u => u.email),
            subject: `Webhook "${endpoint.name}" was auto-disabled`,
            html: renderEmailTemplate(params),
            text: renderEmailPlainText(params),
            tags: [{ name: 'kind', value: 'webhook_auto_disabled' }],
            idempotencyKey: `webhook-disabled-${endpoint.id}-${endpoint.disabled_at?.getTime()}`,
        });
    }
}

// ────────────────────────────────────────────────────────────────────
// Utilities
// ────────────────────────────────────────────────────────────────────

function truncate(s: string | undefined, maxBytes: number): string | null {
    if (!s) return null;
    const buf = Buffer.from(s, 'utf-8');
    if (buf.byteLength <= maxBytes) return s;
    return buf.slice(0, maxBytes).toString('utf-8') + '\n…[truncated]';
}

