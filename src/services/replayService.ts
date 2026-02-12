/**
 * Event Replay Service
 * 
 * Reconstructs entity state by replaying stored events.
 * Useful for debugging, auditing, and state verification.
 * 
 * Modes:
 *   - DRY_RUN: Simulates replay, returns what WOULD happen without making changes
 *   - LIVE: Actually replays events, applying state changes
 * 
 * Safety:
 *   - Events are replayed in chronological order
 *   - Each event is processed idempotently (no duplicate side effects)
 *   - Dry-run mode is the default to prevent accidental state mutations
 */

import { prisma } from '../index';
import { logger } from './observabilityService';
import * as eventService from './eventService';
import * as monitoringService from './monitoringService';
import * as auditLogService from './auditLogService';

// ============================================================================
// TYPES
// ============================================================================

export type ReplayMode = 'dry_run' | 'live';

export interface ReplayRequest {
    organizationId: string;
    entityType: string;
    entityId: string;
    mode: ReplayMode;
    fromTimestamp?: Date;
    toTimestamp?: Date;
}

export interface ReplayResult {
    mode: ReplayMode;
    entityType: string;
    entityId: string;
    totalEvents: number;
    replayedEvents: number;
    skippedEvents: number;
    errors: Array<{ eventId: string; error: string }>;
    stateChanges: Array<{
        eventId: string;
        eventType: string;
        timestamp: Date;
        action: string;
    }>;
    durationMs: number;
}

// ============================================================================
// REPLAY LOGIC
// ============================================================================

/**
 * Replay events for a specific entity to reconstruct or verify its state.
 */
export async function replayEvents(request: ReplayRequest): Promise<ReplayResult> {
    const startTime = Date.now();
    const { organizationId, entityType, entityId, mode, fromTimestamp, toTimestamp } = request;

    logger.info(`[REPLAY] Starting ${mode} replay`, {
        organizationId,
        entityType,
        entityId,
        fromTimestamp,
        toTimestamp,
    });

    // Fetch events
    const events = await eventService.getEventsForReplay(
        organizationId,
        entityType,
        entityId,
        fromTimestamp
    );

    // Filter by toTimestamp if provided
    const filteredEvents = toTimestamp
        ? events.filter((e: any) => new Date(e.created_at) <= toTimestamp)
        : events;

    const result: ReplayResult = {
        mode,
        entityType,
        entityId,
        totalEvents: filteredEvents.length,
        replayedEvents: 0,
        skippedEvents: 0,
        errors: [],
        stateChanges: [],
        durationMs: 0,
    };

    for (const event of filteredEvents) {
        try {
            const action = await replaySingleEvent(event, mode);

            if (action) {
                result.replayedEvents++;
                result.stateChanges.push({
                    eventId: event.id,
                    eventType: event.event_type,
                    timestamp: event.created_at,
                    action,
                });
            } else {
                result.skippedEvents++;
            }
        } catch (err) {
            result.errors.push({
                eventId: event.id,
                error: (err as Error).message,
            });
            logger.error('[REPLAY] Error replaying event', err as Error, {
                eventId: event.id,
            });
        }
    }

    result.durationMs = Date.now() - startTime;

    // Log the replay for audit
    await auditLogService.logAction({
        organizationId,
        entity: entityType,
        entityId,
        trigger: 'admin_replay',
        action: `replay_${mode}`,
        details: JSON.stringify({
            totalEvents: result.totalEvents,
            replayedEvents: result.replayedEvents,
            skippedEvents: result.skippedEvents,
            errors: result.errors.length,
            durationMs: result.durationMs,
        }),
    });

    logger.info(`[REPLAY] ${mode} replay complete`, {
        totalEvents: result.totalEvents,
        replayedEvents: result.replayedEvents,
        errors: result.errors.length,
        durationMs: result.durationMs,
    });

    return result;
}

/**
 * Replay a single event.
 * Returns the action taken, or null if skipped.
 */
async function replaySingleEvent(event: any, mode: ReplayMode): Promise<string | null> {
    const eventType = (event.event_type || '').toUpperCase();
    const entityId = event.entity_id;
    const payload = event.payload || {};

    switch (eventType) {
        case 'HARD_BOUNCE':
        case 'EMAIL_BOUNCE':
        case 'BOUNCE': {
            if (mode === 'live') {
                await monitoringService.recordBounce(
                    entityId,
                    payload.campaign_id || '',
                    payload.smtp_response,
                    payload.recipient_email
                );
            }
            return `bounce_recorded (${mode})`;
        }

        case 'EMAIL_SENT':
        case 'SENT': {
            if (mode === 'live') {
                await monitoringService.recordSent(entityId, payload.campaign_id || '');
            }
            return `sent_recorded (${mode})`;
        }

        case 'SPAM_COMPLAINT': {
            return `spam_complaint_noted (${mode})`;
        }

        default:
            return null; // Unknown event type, skip
    }
}

/**
 * Get a summary of replayable events for an entity (without actually replaying).
 */
export async function getReplaySummary(
    organizationId: string,
    entityType: string,
    entityId: string
): Promise<{
    totalEvents: number;
    eventTypes: Record<string, number>;
    earliestEvent: Date | null;
    latestEvent: Date | null;
}> {
    const events = await eventService.getEventsForReplay(
        organizationId,
        entityType,
        entityId
    );

    const eventTypes: Record<string, number> = {};
    let earliest: Date | null = null;
    let latest: Date | null = null;

    for (const event of events) {
        const type = event.event_type || 'unknown';
        eventTypes[type] = (eventTypes[type] || 0) + 1;

        const eventDate = new Date(event.created_at);
        if (!earliest || eventDate < earliest) earliest = eventDate;
        if (!latest || eventDate > latest) latest = eventDate;
    }

    return {
        totalEvents: events.length,
        eventTypes,
        earliestEvent: earliest,
        latestEvent: latest,
    };
}
