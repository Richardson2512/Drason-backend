/**
 * Webhook Dispatcher Worker
 *
 * Picks up `WebhookDelivery` rows from the BullMQ queue, POSTs them to the
 * customer endpoint with HMAC-SHA256 signing, records the outcome via
 * webhookService.markDeliveryAttempt, and (on failure) re-enqueues itself
 * after the next-attempt delay.
 *
 * Two entry paths into this worker:
 *   1. webhookService.dispatchEvent enqueues a fresh delivery → BullMQ runs it now
 *   2. A failed attempt re-adds the job with `delay = nextAttemptAt - now`
 *
 * A safety-net rescue scan also runs every 60s — sweeps DB for any pending /
 * failed delivery whose next_attempt_at has passed but isn't in the queue
 * (e.g. after a Redis/process restart). Belt-and-braces; the queue is the
 * primary mechanism.
 *
 * Slack endpoints (provider='slack') get their payload reshaped into Slack's
 * { blocks: [...] } format before being POSTed; the HMAC scheme is skipped
 * for them because Slack expects no signature on inbound webhook URLs.
 */

import { Worker, Queue, Job } from 'bullmq';
import { prisma } from '../index';
import { logger } from '../services/observabilityService';
import { getRedisClient } from '../utils/redis';
import {
    markDeliveryAttempt,
    WEBHOOK_QUEUE_NAME,
    type DeliveryAttemptResult,
    type WebhookEventType,
} from '../services/webhookService';
import { signWebhookPayload } from '../utils/webhookOutboundSigning';

const LOG_TAG = 'WEBHOOK_DISPATCHER';
const WORKER_CONCURRENCY = 10;
const RESCUE_INTERVAL_MS = 60_000;
const POST_TIMEOUT_MS = 15_000;

let worker: Worker | null = null;
let rescueQueue: Queue | null = null;
let rescueInterval: NodeJS.Timeout | null = null;

// ────────────────────────────────────────────────────────────────────
// Job processor
// ────────────────────────────────────────────────────────────────────

interface DeliveryJobData {
    deliveryId: string;
}

async function processDelivery(job: Job<DeliveryJobData>): Promise<void> {
    const { deliveryId } = job.data;

    const delivery = await prisma.webhookDelivery.findUnique({
        where: { id: deliveryId },
        include: { endpoint: true },
    });

    if (!delivery) {
        logger.warn(`[${LOG_TAG}] Delivery ${deliveryId} not found — skipping`);
        return;
    }
    if (delivery.status === 'success' || delivery.status === 'dead_letter') {
        // Already terminal — nothing to do.
        return;
    }
    if (!delivery.endpoint.active || delivery.endpoint.disabled_at) {
        logger.info(`[${LOG_TAG}] Endpoint ${delivery.endpoint_id} is inactive — skipping ${deliveryId}`);
        return;
    }

    const result = await postDelivery(delivery, delivery.endpoint);
    const headersForLog: Record<string, string> = {
        'Content-Type': 'application/json',
        'User-Agent': 'Superkabe-Webhooks/1.0',
        'X-Superkabe-Event': delivery.event_type,
        'X-Superkabe-Event-Id': delivery.event_id,
        'X-Superkabe-Delivery-Id': delivery.id,
        ...(delivery.endpoint.provider === 'generic' && { 'X-Superkabe-Signature': '<redacted>' }),
    };

    const outcome = await markDeliveryAttempt(deliveryId, result, headersForLog);

    // Re-enqueue if we still have retries left. We use the closure-scoped
    // `rescueQueue` rather than `job.queue` (which is protected in BullMQ).
    if (outcome.status === 'failed' && outcome.nextAttemptAt && rescueQueue) {
        const delayMs = Math.max(0, outcome.nextAttemptAt.getTime() - Date.now());
        await rescueQueue.add(
            'deliver',
            { deliveryId } satisfies DeliveryJobData,
            {
                delay: delayMs,
                jobId: `${deliveryId}-r${delivery.attempt_count + 1}`,
                removeOnComplete: { count: 100 },
                removeOnFail: { count: 500 },
            }
        );
    }
}

// ────────────────────────────────────────────────────────────────────
// HTTP POST
// ────────────────────────────────────────────────────────────────────

interface DeliveryEndpointFields {
    url: string;
    secret: string;
    provider: string;
}

async function postDelivery(
    delivery: { id: string; event_type: string; event_id: string; payload: any },
    endpoint: DeliveryEndpointFields
): Promise<DeliveryAttemptResult> {
    // Provider-specific payload transform (Slack reshapes; everyone else
    // gets the canonical Superkabe envelope).
    const body =
        endpoint.provider === 'slack'
            ? buildSlackPayload(delivery.event_type as WebhookEventType, delivery.payload)
            : buildGenericEnvelope(delivery);

    const rawBody = JSON.stringify(body);

    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'User-Agent': 'Superkabe-Webhooks/1.0',
        'X-Superkabe-Event': delivery.event_type,
        'X-Superkabe-Event-Id': delivery.event_id,
        'X-Superkabe-Delivery-Id': delivery.id,
    };

    // HMAC signing — generic endpoints only. Slack incoming webhooks
    // don't accept arbitrary signatures and Slack's own request signing
    // is for events going INTO Slack, not for incoming webhook URLs.
    if (endpoint.provider === 'generic') {
        const sig = signWebhookPayload(rawBody, endpoint.secret);
        headers['X-Superkabe-Signature'] = sig.signatureHeader;
    }

    const startedAt = Date.now();
    try {
        const res = await fetch(endpoint.url, {
            method: 'POST',
            headers,
            body: rawBody,
            signal: AbortSignal.timeout(POST_TIMEOUT_MS),
        });
        const responseBody = await res.text().catch(() => '');
        const durationMs = Date.now() - startedAt;

        if (res.ok) {
            return { success: true, responseCode: res.status, responseBody, durationMs };
        }
        return {
            success: false,
            responseCode: res.status,
            responseBody,
            durationMs,
            errorMessage: `HTTP ${res.status} ${res.statusText}`,
        };
    } catch (err) {
        const durationMs = Date.now() - startedAt;
        const msg = err instanceof Error ? err.message : String(err);
        return {
            success: false,
            durationMs,
            errorMessage: msg.includes('aborted') ? `timeout after ${POST_TIMEOUT_MS}ms` : msg,
        };
    }
}

// ────────────────────────────────────────────────────────────────────
// Payload builders
// ────────────────────────────────────────────────────────────────────

function buildGenericEnvelope(delivery: { event_type: string; event_id: string; payload: any }): Record<string, unknown> {
    return {
        id: delivery.event_id,
        type: delivery.event_type,
        api_version: '1',
        created_at: new Date().toISOString(),
        data: delivery.payload || {},
    };
}

/**
 * Reshape a generic event payload into Slack's blocks format.
 *
 * Best-effort — the goal is "useful in a Slack channel without setting up
 * a custom transform." Each event type gets a one-line headline, a small
 * fields block of relevant context, and a link back to the dashboard.
 */
function buildSlackPayload(eventType: WebhookEventType, payload: Record<string, unknown>): Record<string, unknown> {
    const headline = slackHeadlineFor(eventType, payload);
    const fields = slackFieldsFor(payload);

    return {
        blocks: [
            { type: 'section', text: { type: 'mrkdwn', text: headline } },
            ...(fields.length > 0 ? [{ type: 'section', fields }] : []),
        ],
    };
}

function slackHeadlineFor(eventType: WebhookEventType, payload: Record<string, unknown>): string {
    const subject = (payload.email || payload.domain || payload.campaign_name || payload.id || '').toString();
    const verb = SLACK_VERBS[eventType] || eventType;
    return subject ? `*${verb}* — \`${subject}\`` : `*${verb}*`;
}

const SLACK_VERBS: Record<WebhookEventType, string> = {
    'lead.created': 'Lead created',
    'lead.validated': 'Lead validated',
    'lead.health_changed': 'Lead health changed',
    'lead.replied': 'Lead replied',
    'campaign.launched': 'Campaign launched',
    'campaign.paused': 'Campaign paused',
    'campaign.completed': 'Campaign completed',
    'mailbox.paused': 'Mailbox paused',
    'mailbox.entered_quarantine': 'Mailbox → quarantine',
    'mailbox.entered_restricted_send': 'Mailbox → restricted send',
    'mailbox.entered_warm_recovery': 'Mailbox → warm recovery',
    'mailbox.healed': 'Mailbox healed',
    'domain.dnsbl_listed': 'Domain blacklisted',
    'domain.dnsbl_cleared': 'Domain cleared from blacklist',
    'domain.dns_failed': 'Domain DNS check failed',
    'email.sent': 'Email sent',
    'email.bounced': 'Email bounced',
    'email.opened': 'Email opened',
    'email.clicked': 'Email clicked',
    'reply.received': 'Reply received',
};

function slackFieldsFor(payload: Record<string, unknown>): { type: 'mrkdwn'; text: string }[] {
    const fields: { type: 'mrkdwn'; text: string }[] = [];
    const interesting = ['campaign_name', 'mailbox_email', 'domain', 'phase', 'reason', 'bounce_type'];
    for (const key of interesting) {
        if (payload[key] !== undefined && payload[key] !== null) {
            fields.push({ type: 'mrkdwn', text: `*${key.replace(/_/g, ' ')}:*\n${String(payload[key])}` });
        }
    }
    return fields.slice(0, 6); // Slack limits to 10, keep tight.
}

// ────────────────────────────────────────────────────────────────────
// Rescue scan — picks up deliveries whose next_attempt_at slipped past
// the queue (e.g. process crash mid-retry, Redis flush, etc.)
// ────────────────────────────────────────────────────────────────────

async function rescueScan(): Promise<void> {
    if (!rescueQueue) return;
    try {
        const due = await prisma.webhookDelivery.findMany({
            where: {
                status: { in: ['pending', 'failed'] },
                next_attempt_at: { lte: new Date() },
            },
            select: { id: true },
            take: 200,
        });
        for (const row of due) {
            await rescueQueue.add(
                'deliver',
                { deliveryId: row.id } satisfies DeliveryJobData,
                { jobId: `${row.id}-rescue-${Date.now()}` }
            );
        }
        if (due.length > 0) {
            logger.info(`[${LOG_TAG}] Rescue scan re-enqueued ${due.length} stuck deliveries`);
        }
    } catch (err) {
        logger.error(`[${LOG_TAG}] Rescue scan failed`, err instanceof Error ? err : new Error(String(err)));
    }
}

// ────────────────────────────────────────────────────────────────────
// Lifecycle
// ────────────────────────────────────────────────────────────────────

export function startWebhookDispatcherWorker(): void {
    const redis = getRedisClient();
    if (!redis) {
        logger.warn(`[${LOG_TAG}] No Redis — webhook dispatcher disabled (deliveries will queue in DB only)`);
        return;
    }

    const connection = { host: redis.options.host!, port: redis.options.port!, password: redis.options.password };

    rescueQueue = new Queue(WEBHOOK_QUEUE_NAME, { connection });

    worker = new Worker(
        WEBHOOK_QUEUE_NAME,
        async (job: Job<DeliveryJobData>) => {
            await processDelivery(job);
        },
        {
            connection,
            concurrency: WORKER_CONCURRENCY,
        }
    );

    worker.on('completed', (job) => {
        logger.debug(`[${LOG_TAG}] Job ${job.id} completed`);
    });

    worker.on('failed', (job, err) => {
        logger.error(`[${LOG_TAG}] Job ${job?.id} failed at queue level: ${err.message}`, err);
    });

    worker.on('error', (err) => {
        logger.error(`[${LOG_TAG}] Worker error`, err);
    });

    rescueInterval = setInterval(() => {
        rescueScan().catch(err => logger.error(`[${LOG_TAG}] rescueScan threw`, err));
    }, RESCUE_INTERVAL_MS);

    logger.info(`[${LOG_TAG}] Started (concurrency: ${WORKER_CONCURRENCY}, rescue every ${RESCUE_INTERVAL_MS / 1000}s)`);
}

export async function stopWebhookDispatcherWorker(): Promise<void> {
    if (rescueInterval) {
        clearInterval(rescueInterval);
        rescueInterval = null;
    }
    if (worker) {
        await worker.close();
        worker = null;
    }
    if (rescueQueue) {
        await rescueQueue.close();
        rescueQueue = null;
    }
    logger.info(`[${LOG_TAG}] Stopped`);
}
