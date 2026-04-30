/**
 * CRM activity-push subscriber.
 *
 * Subscribes to the in-process webhook event bus and writes one
 * CrmActivityPushItem row per (active CRM connection, event) pair.
 * No HubSpot or Salesforce code lives here — this service is purely
 * a queue producer. Per-provider workers (Phase 2 / Phase 3) consume
 * the items and call the actual CRM API.
 *
 * Idempotency: the (connection_id, lead_id, event_type, occurred_at)
 * unique constraint on CrmActivityPushItem absorbs duplicate emits
 * from event-bus retries. We catch the unique-violation Prisma error
 * and skip silently.
 */

import { Prisma } from '@prisma/client';
import { prisma } from '../../index';
import { logger } from '../observabilityService';
import { onInternalEvent, type WebhookEventType } from '../webhookService';
import { listActiveConnectionIdsForOrg } from './connectionService';
import type { CrmActivityEventType } from './types';

/**
 * Webhook bus event types we forward to CRMs. Anything else we ignore.
 * Keep narrow on purpose — CRMs care about per-contact activity, not
 * mailbox or domain state changes.
 */
const FORWARDED_EVENTS = new Set<WebhookEventType>([
    'email.sent',
    'email.opened',
    'email.clicked',
    'email.bounced',
    'reply.received',
]);

/** Map webhook bus event → CRM activity vocabulary. */
function toCrmEventType(eventType: WebhookEventType): CrmActivityEventType | null {
    switch (eventType) {
        case 'email.sent':     return 'email.sent';
        case 'email.opened':   return 'email.opened';
        case 'email.clicked':  return 'email.clicked';
        case 'email.bounced':  return 'email.bounced';
        case 'reply.received': return 'email.replied';
        default:               return null;
    }
}

/**
 * Pull the lead identifier out of the heterogeneous payload shapes used
 * by different webhook emit functions. Most carry `lead_id`; some carry
 * only `lead_email` (we'd resolve email → lead_id at push time).
 */
function extractLeadRef(payload: Record<string, unknown>): { leadId: string | null; email: string | null } {
    const leadId = typeof payload.lead_id === 'string' ? payload.lead_id : null;
    const email = typeof payload.lead_email === 'string'
        ? payload.lead_email
        : typeof payload.email === 'string'
            ? payload.email
            : null;
    return { leadId, email };
}

/**
 * Resolve the canonical occurred_at for an event. Prefer payload.timestamp
 * (ISO string) → fallback to now. Using the payload value keeps activity
 * timelines accurate even if the worker lags.
 */
function extractOccurredAt(payload: Record<string, unknown>): Date {
    const ts = payload.timestamp;
    if (typeof ts === 'string') {
        const parsed = new Date(ts);
        if (!isNaN(parsed.getTime())) return parsed;
    }
    if (ts instanceof Date) return ts;
    return new Date();
}

/**
 * The actual subscriber callback. Registered at server startup.
 */
async function handleEvent(
    orgId: string,
    eventType: WebhookEventType,
    payload: Record<string, unknown>,
): Promise<void> {
    if (!FORWARDED_EVENTS.has(eventType)) return;

    const crmEventType = toCrmEventType(eventType);
    if (!crmEventType) return;

    const { leadId } = extractLeadRef(payload);
    if (!leadId) {
        // Without a lead reference we can't enqueue per-contact work.
        // This is fine — some events (e.g., domain-level) shouldn't push.
        return;
    }

    const connections = await listActiveConnectionIdsForOrg(orgId);
    if (connections.length === 0) return;

    const occurredAt = extractOccurredAt(payload);

    // Insert one row per (connection, event). Idempotency via the
    // unique tuple — duplicates from event-bus retries are swallowed.
    for (const conn of connections) {
        try {
            await prisma.crmActivityPushItem.create({
                data: {
                    crm_connection_id: conn.id,
                    superkabe_lead_id: leadId,
                    event_type: crmEventType,
                    event_payload: payload as Prisma.InputJsonValue,
                    occurred_at: occurredAt,
                    state: 'pending',
                },
            });
        } catch (err) {
            // P2002 = unique constraint violation → already enqueued, fine.
            if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
                continue;
            }
            logger.error(
                `[CRM_PUSH] failed to enqueue activity for connection=${conn.id} event=${eventType}`,
                err instanceof Error ? err : new Error(String(err)),
            );
        }
    }
}

/**
 * Initialize the subscriber. Call once at server startup, before the
 * HTTP server starts accepting traffic.
 */
export function registerActivityPushSubscriber(): void {
    onInternalEvent((orgId, eventType, payload) => {
        return handleEvent(orgId, eventType, payload);
    });
    logger.info('[CRM_PUSH] activity-push subscriber registered');
}
