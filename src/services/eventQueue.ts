/**
 * Event Queue Service
 * 
 * Implements async webhook processing via BullMQ.
 * 
 * Architecture:
 *   Webhook → validate → store RawEvent → enqueue job → return 200
 *   Worker → fetch RawEvent → process → mark processed/failed
 * 
 * Features:
 *   - 3 retries with exponential backoff (5s, 30s, 120s)
 *   - Dead-letter queue: failed jobs create notifications + mark event failed
 *   - Concurrency limit: 5 (prevents DB overload)
 *   - Sync fallback: if Redis unavailable, processes inline
 *   - Graceful shutdown: drains queue before exit
 */

import { Queue, Worker, Job } from 'bullmq';
import { logger } from './observabilityService';
import * as monitoringService from './monitoringService';
import * as eventService from './eventService';
import * as notificationService from './notificationService';
import { EventType } from '../types';

// ============================================================================
// TYPES
// ============================================================================

interface EventJobData {
    eventId: string;
    eventType: string;
    entityType: string;
    entityId: string;
    organizationId: string;
    campaignId?: string;
    smtpResponse?: string;
    recipientEmail?: string;
}

interface QueueStatus {
    isRunning: boolean;
    activeCount: number;
    waitingCount: number;
    failedCount: number;
    completedCount: number;
    lastProcessedAt: Date | null;
    lastError: string | null;
}

// ============================================================================
// QUEUE & WORKER INSTANCES
// ============================================================================

const QUEUE_NAME = 'drason:events';
let eventQueue: Queue | null = null;
let eventWorker: Worker | null = null;
let queueStatus: QueueStatus = {
    isRunning: false,
    activeCount: 0,
    waitingCount: 0,
    failedCount: 0,
    completedCount: 0,
    lastProcessedAt: null,
    lastError: null,
};

// ============================================================================
// INITIALIZATION
// ============================================================================

/**
 * Initialize the event queue and worker.
 * Requires REDIS_URL to be set. If not, queue features are disabled
 * and processing falls back to synchronous mode.
 */
export function initEventQueue(): boolean {
    const redisUrl = process.env.REDIS_URL;

    if (!redisUrl) {
        logger.warn('[QUEUE] REDIS_URL not set — async processing disabled, using sync fallback');
        return false;
    }

    try {
        // Parse Redis URL for BullMQ connection options
        const connection = parseRedisUrl(redisUrl);

        // Create queue
        eventQueue = new Queue(QUEUE_NAME, {
            connection,
            defaultJobOptions: {
                attempts: 3,
                backoff: {
                    type: 'exponential',
                    delay: 5000, // 5s → 30s → 120s effective
                },
                removeOnComplete: { count: 1000 },  // Keep last 1000 completed for inspection
                removeOnFail: false,                  // Keep failed jobs in DLQ
            },
        });

        // Create worker
        eventWorker = new Worker(QUEUE_NAME, processEventJob, {
            connection,
            concurrency: 5,
            limiter: {
                max: 50,
                duration: 1000, // Max 50 jobs per second
            },
        });

        // Wire up event handlers
        eventWorker.on('completed', (job: Job<EventJobData>) => {
            queueStatus.completedCount++;
            queueStatus.lastProcessedAt = new Date();
            logger.info('[QUEUE] Job completed', {
                jobId: job.id,
                eventId: job.data.eventId,
                eventType: job.data.eventType,
            });
        });

        eventWorker.on('failed', (job: Job<EventJobData> | undefined, err: Error) => {
            const isFinalFailure = job && job.attemptsMade >= (job.opts?.attempts || 3);

            if (isFinalFailure) {
                // DLQ — final failure after all retries exhausted
                queueStatus.failedCount++;
                queueStatus.lastError = err.message;
                handleDeadLetter(job!, err);
            } else {
                logger.warn('[QUEUE] Job failed, will retry', {
                    jobId: job?.id,
                    eventId: job?.data?.eventId,
                    attempt: job?.attemptsMade,
                    error: err.message,
                });
            }
        });

        eventWorker.on('error', (err: Error) => {
            logger.error('[QUEUE] Worker error', err);
        });

        queueStatus.isRunning = true;
        logger.info('[QUEUE] Event queue and worker initialized', { concurrency: 5 });
        return true;
    } catch (err) {
        logger.error('[QUEUE] Failed to initialize event queue', err as Error);
        return false;
    }
}

// ============================================================================
// ENQUEUE
// ============================================================================

/**
 * Enqueue an event for async processing.
 * Falls back to synchronous processing if queue is unavailable.
 * Returns true if enqueued, false if processed synchronously.
 */
export async function enqueueEvent(data: EventJobData): Promise<boolean> {
    if (!eventQueue || !queueStatus.isRunning) {
        // Sync fallback — process immediately
        logger.info('[QUEUE] Sync fallback — processing event inline', {
            eventId: data.eventId,
            eventType: data.eventType,
        });
        try {
            await processEventInline(data);
        } catch (err) {
            logger.error('[QUEUE] Sync fallback processing failed', err as Error);
            await eventService.markEventFailed(data.eventId, (err as Error).message);
        }
        return false;
    }

    await eventQueue.add('process-event', data, {
        jobId: `event:${data.eventId}`, // Prevents duplicate jobs for same event
    });

    return true;
}

// ============================================================================
// JOB PROCESSOR
// ============================================================================

/**
 * Process a single event job from the queue.
 * This is the BullMQ job handler — runs in the worker.
 */
async function processEventJob(job: Job<EventJobData>): Promise<void> {
    const { eventId, eventType, entityId, campaignId, smtpResponse, recipientEmail } = job.data;

    logger.info('[QUEUE] Processing event', {
        jobId: job.id,
        eventId,
        eventType,
        attempt: job.attemptsMade + 1,
    });

    await processEventInline(job.data);

    // Mark event as processed in DB
    await eventService.markEventProcessed(eventId);
}

/**
 * Inline event processing — shared between async worker and sync fallback.
 */
async function processEventInline(data: EventJobData): Promise<void> {
    const { eventType, entityId, campaignId, smtpResponse, recipientEmail } = data;

    switch (eventType) {
        case EventType.HARD_BOUNCE:
        case 'EMAIL_BOUNCE':
        case 'BOUNCE':
            await monitoringService.recordBounce(
                entityId,
                campaignId || '',
                smtpResponse,
                recipientEmail
            );
            break;

        case EventType.EMAIL_SENT:
        case 'SENT':
            await monitoringService.recordSent(entityId, campaignId || '');
            break;

        case 'SPAM_COMPLAINT':
            // Future: handle spam complaints
            logger.info('[QUEUE] Spam complaint received', { entityId });
            break;

        default:
            logger.info(`[QUEUE] Unhandled event type: ${eventType}`, { entityId });
    }
}

// ============================================================================
// DEAD-LETTER QUEUE HANDLING
// ============================================================================

/**
 * Handle a permanently failed job — all retries exhausted.
 * 1. Mark event as failed in DB
 * 2. Create a notification for the organization
 * 3. Log with full context
 */
async function handleDeadLetter(job: Job<EventJobData>, error: Error): Promise<void> {
    const { eventId, eventType, organizationId, entityId } = job.data;

    logger.error('[DLQ] Event permanently failed after all retries', error, {
        eventId,
        eventType,
        entityId,
        attempts: job.attemptsMade,
    });

    // Mark in DB
    try {
        await eventService.markEventFailed(eventId, error.message);
    } catch (err) {
        logger.error('[DLQ] Failed to mark event as failed in DB', err as Error);
    }

    // Create notification for the organization
    try {
        await notificationService.createNotification(organizationId, {
            type: 'ERROR',
            title: 'Event Processing Failed',
            message: `Failed to process ${eventType} event for entity ${entityId} after 3 attempts. Error: ${error.message}. Check system logs for details.`,
        });
    } catch (err) {
        logger.error('[DLQ] Failed to create failure notification', err as Error);
    }
}

// ============================================================================
// DLQ ADMIN OPERATIONS
// ============================================================================

/**
 * Get all failed jobs from the DLQ.
 */
export async function getDeadLetterJobs(limit: number = 50): Promise<any[]> {
    if (!eventQueue) return [];

    const failed = await eventQueue.getFailed(0, limit);
    return failed.map(job => ({
        jobId: job.id,
        eventId: job.data.eventId,
        eventType: job.data.eventType,
        entityId: job.data.entityId,
        organizationId: job.data.organizationId,
        error: job.failedReason,
        attempts: job.attemptsMade,
        failedAt: job.finishedOn ? new Date(job.finishedOn) : null,
    }));
}

/**
 * Retry a specific failed job from the DLQ.
 */
export async function retryDeadLetterJob(jobId: string): Promise<boolean> {
    if (!eventQueue) return false;

    const job = await eventQueue.getJob(jobId);
    if (!job) return false;

    await job.retry();
    logger.info('[DLQ] Job retried', { jobId });
    return true;
}

/**
 * Retry ALL failed jobs in the DLQ.
 */
export async function retryAllDeadLetterJobs(): Promise<number> {
    if (!eventQueue) return 0;

    const failed = await eventQueue.getFailed(0, 1000);
    let retried = 0;
    for (const job of failed) {
        try {
            await job.retry();
            retried++;
        } catch (err) {
            logger.warn('[DLQ] Could not retry job', { jobId: job.id, error: (err as Error).message });
        }
    }
    logger.info(`[DLQ] Retried ${retried}/${failed.length} failed jobs`);
    return retried;
}

// ============================================================================
// STATUS & HEALTH
// ============================================================================

/**
 * Get current queue status for health checks.
 */
export async function getQueueStatus(): Promise<QueueStatus> {
    if (!eventQueue) {
        return { ...queueStatus, isRunning: false };
    }

    try {
        const [active, waiting, failed, completed] = await Promise.all([
            eventQueue.getActiveCount(),
            eventQueue.getWaitingCount(),
            eventQueue.getFailedCount(),
            eventQueue.getCompletedCount(),
        ]);

        return {
            ...queueStatus,
            activeCount: active,
            waitingCount: waiting,
            failedCount: failed,
            completedCount: completed,
        };
    } catch {
        return queueStatus;
    }
}

// ============================================================================
// SHUTDOWN
// ============================================================================

/**
 * Gracefully shutdown the event queue and worker.
 * Drains current jobs before closing.
 */
export async function shutdownEventQueue(): Promise<void> {
    if (eventWorker) {
        logger.info('[QUEUE] Shutting down event worker...');
        await eventWorker.close();
        eventWorker = null;
    }

    if (eventQueue) {
        await eventQueue.close();
        eventQueue = null;
    }

    queueStatus.isRunning = false;
    logger.info('[QUEUE] Event queue shut down');
}

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Parse Redis URL into BullMQ connection options.
 */
function parseRedisUrl(url: string): { host: string; port: number; password?: string; tls?: any } {
    try {
        const parsed = new URL(url);
        const options: any = {
            host: parsed.hostname,
            port: parseInt(parsed.port || '6379', 10),
        };

        if (parsed.password) {
            options.password = parsed.password;
        }

        // Railway and other providers use rediss:// for TLS
        if (parsed.protocol === 'rediss:') {
            options.tls = { rejectUnauthorized: false };
        }

        return options;
    } catch (err) {
        logger.error('[QUEUE] Failed to parse REDIS_URL', err as Error);
        throw new Error('Invalid REDIS_URL format — cannot connect to Redis');
    }
}
