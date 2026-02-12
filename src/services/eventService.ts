/**
 * Event Service
 * 
 * Implements event sourcing as per Section 5 of the Infrastructure Audit.
 * All events are stored BEFORE processing to ensure durability and replay capability.
 * 
 * Key principles:
 * - Events are append-only and immutable
 * - Events support idempotency via unique keys
 * - Events can be replayed to reconstruct state
 */

import { prisma } from '../index';
import { EventType } from '../types';
import { logger } from './observabilityService';

interface StoreEventParams {
    organizationId: string;
    eventType: EventType;
    entityType: string;
    entityId?: string;
    payload: any;
    idempotencyKey?: string;
}

/**
 * Store a raw event before processing.
 * Returns the event ID if stored, or the existing event ID if duplicate.
 */
export const storeEvent = async (params: StoreEventParams): Promise<{ eventId: string; isNew: boolean }> => {
    const { organizationId, eventType, entityType, entityId, payload, idempotencyKey } = params;

    // Check for duplicate if idempotency key provided
    if (idempotencyKey) {
        const existing = await prisma.rawEvent.findUnique({
            where: { idempotency_key: idempotencyKey }
        });

        if (existing) {
            logger.info(`[EVENT] Duplicate event detected: ${idempotencyKey}`);
            return { eventId: existing.id, isNew: false };
        }
    }

    // Store the event
    const event = await prisma.rawEvent.create({
        data: {
            organization_id: organizationId,
            event_type: eventType,
            entity_type: entityType,
            entity_id: entityId,
            payload,
            idempotency_key: idempotencyKey
        }
    });

    logger.info(`[EVENT] Stored event: ${event.id} (${eventType})`);
    return { eventId: event.id, isNew: true };
};

/**
 * Mark an event as processed.
 */
export const markEventProcessed = async (eventId: string): Promise<void> => {
    await prisma.rawEvent.update({
        where: { id: eventId },
        data: {
            processed: true,
            processed_at: new Date()
        }
    });
};

/**
 * Mark an event as failed with error message.
 */
export const markEventFailed = async (eventId: string, errorMessage: string): Promise<void> => {
    await prisma.rawEvent.update({
        where: { id: eventId },
        data: {
            error_message: errorMessage,
            retry_count: { increment: 1 }
        }
    });
};

/**
 * Get unprocessed events for a worker to consume.
 * Returns oldest events first (FIFO).
 */
export const getUnprocessedEvents = async (
    organizationId: string,
    limit: number = 100
): Promise<any[]> => {
    return prisma.rawEvent.findMany({
        where: {
            organization_id: organizationId,
            processed: false,
            retry_count: { lt: 3 }  // Max 3 retries
        },
        orderBy: { created_at: 'asc' },
        take: limit
    });
};

/**
 * Get events for replay/reconstruction of state.
 */
export const getEventsForReplay = async (
    organizationId: string,
    entityType: string,
    entityId: string,
    fromTimestamp?: Date
): Promise<any[]> => {
    return prisma.rawEvent.findMany({
        where: {
            organization_id: organizationId,
            entity_type: entityType,
            entity_id: entityId,
            processed: true,
            ...(fromTimestamp && { created_at: { gte: fromTimestamp } })
        },
        orderBy: { created_at: 'asc' }
    });
};

/**
 * Get all events of a specific type for an organization.
 */
export const getEventsByType = async (
    organizationId: string,
    eventType: EventType,
    limit: number = 1000
): Promise<any[]> => {
    return prisma.rawEvent.findMany({
        where: {
            organization_id: organizationId,
            event_type: eventType
        },
        orderBy: { created_at: 'desc' },
        take: limit
    });
};
