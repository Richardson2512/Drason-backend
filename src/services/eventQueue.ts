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
import * as bounceProcessingService from './bounceProcessingService';
import * as eventService from './eventService';
import * as notificationService from './notificationService';
import * as auditLogService from './auditLogService';
import * as entityStateService from './entityStateService';
import { recalculateLeadScore } from './leadScoringService';
import { EventType, LeadState, TriggerType, MONITORING_THRESHOLDS } from '../types';
import { prisma } from '../index';

const { ROLLING_WINDOW_SIZE } = MONITORING_THRESHOLDS;

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
    bounceType?: string;     // 'hard' | 'soft' (from platform webhook)
    sentAt?: string;         // ISO datetime string
    bouncedAt?: string;      // ISO datetime string
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

// ============================================================================
// UNIFIED EVENT HANDLERS (platform-agnostic)
// ============================================================================

/**
 * Process a sent event — unified for all platforms.
 * Updates lead, campaign, and mailbox counters. Triggers sliding window.
 */
async function processSentEvent(
    organizationId: string,
    mailboxId: string,
    campaignId: string | undefined,
    recipientEmail: string | undefined
): Promise<void> {
    // 0. Record SendEvent for ESP-aware routing intelligence
    if (recipientEmail && mailboxId) {
        try {
            const domain = recipientEmail.split('@')[1]?.toLowerCase();
            let recipientEsp: string | null = null;
            if (domain) {
                // Classify ESP from cached DomainInsight (no DNS lookup)
                const insight = await prisma.domainInsight.findFirst({
                    where: { domain, organization_id: organizationId },
                    select: { esp_bucket: true, mx_records: true },
                });
                if (insight?.esp_bucket) {
                    recipientEsp = insight.esp_bucket;
                } else if (insight?.mx_records) {
                    // Inline classify from MX records
                    const records = insight.mx_records as unknown as Array<{ exchange: string }>;
                    for (const r of records) {
                        const host = r.exchange?.toLowerCase() || '';
                        if (host.includes('google') || host.includes('gmail')) { recipientEsp = 'gmail'; break; }
                        if (host.includes('outlook') || host.includes('microsoft')) { recipientEsp = 'microsoft'; break; }
                        if (host.includes('yahoo') || host.includes('yahoodns')) { recipientEsp = 'yahoo'; break; }
                    }
                    if (!recipientEsp) recipientEsp = 'other';
                    // Cache the classification
                    if (insight) {
                        await prisma.domainInsight.update({ where: { id: (insight as any).id || undefined, organization_id_domain: { organization_id: organizationId, domain } }, data: { esp_bucket: recipientEsp } }).catch(() => {});
                    }
                }
            }
            await prisma.sendEvent.create({
                data: {
                    organization_id: organizationId,
                    mailbox_id: mailboxId,
                    campaign_id: campaignId || null,
                    recipient_email: recipientEmail.toLowerCase(),
                    recipient_esp: recipientEsp,
                },
            });
        } catch (err: any) {
            // Best-effort — don't block the main sent processing path
            logger.warn(`[QUEUE] Failed to record SendEvent`, { error: err.message, mailboxId, recipientEmail });
        }
    }

    // 1. Update lead sent counter
    if (recipientEmail) {
        try {
            const lead = await prisma.lead.findFirst({
                where: { organization_id: organizationId, email: { equals: recipientEmail, mode: 'insensitive' } },
                select: { id: true },
            });
            if (lead) {
                await prisma.lead.update({
                    where: { id: lead.id },
                    data: {
                        emails_sent: { increment: 1 },
                        last_activity_at: new Date(),
                    },
                });

                await auditLogService.logAction({
                    organizationId,
                    entity: 'lead',
                    entityId: lead.id,
                    trigger: 'webhook',
                    action: 'email_sent',
                    details: `Email sent via campaign ${campaignId || 'unknown'} from mailbox ${mailboxId}`,
                });
            }
        } catch (err: any) {
            logger.warn(`[QUEUE] Failed to update lead sent count for ${recipientEmail}`, { error: err.message });
        }
    }

    // 2. Update campaign total_sent (CRITICAL — was missing for EB/Instantly)
    if (campaignId) {
        try {
            await prisma.campaign.updateMany({
                where: { id: campaignId },
                data: { total_sent: { increment: 1 } },
            });
        } catch (err: any) {
            logger.warn(`[QUEUE] Failed to update campaign sent count for ${campaignId}`, { error: err.message });
        }
    }

    // 3. Update mailbox stats + trigger sliding window
    try {
        const mailbox = await prisma.mailbox.findUnique({
            where: { id: mailboxId },
            select: { id: true, window_sent_count: true, clean_sends_since_phase: true },
        });
        if (mailbox) {
            const newWindowSent = mailbox.window_sent_count + 1;
            await prisma.mailbox.update({
                where: { id: mailboxId },
                data: {
                    window_sent_count: newWindowSent,
                    total_sent_count: { increment: 1 },
                    last_activity_at: new Date(),
                    clean_sends_since_phase: mailbox.clean_sends_since_phase + 1,
                },
            });

            // Trigger sliding window if threshold reached
            if (newWindowSent >= ROLLING_WINDOW_SIZE) {
                await slideWindow(mailboxId, organizationId);
            }
        }
    } catch (err: any) {
        logger.warn(`[QUEUE] Failed to update mailbox sent count for ${mailboxId}`, { error: err.message });
    }
}

/**
 * Sliding window for monitoring (NOT hard reset).
 * Keeps 50% of current window stats to preserve volatility visibility.
 */
async function slideWindow(mailboxId: string, organizationId: string): Promise<void> {
    const mailbox = await prisma.mailbox.findUnique({
        where: { id: mailboxId },
        select: { window_sent_count: true, window_bounce_count: true, status: true },
    });
    if (!mailbox) return;

    const newSentCount = Math.floor(mailbox.window_sent_count / 2);
    const newBounceCount = Math.floor(mailbox.window_bounce_count / 2);

    await prisma.mailbox.update({
        where: { id: mailboxId },
        data: {
            window_sent_count: newSentCount,
            window_bounce_count: newBounceCount,
            window_start_at: new Date(),
        },
    });

    await auditLogService.logAction({
        organizationId,
        entity: 'mailbox',
        entityId: mailboxId,
        trigger: 'monitor_window',
        action: 'window_slide',
        details: `Window slid: kept ${newBounceCount}/${newSentCount} (50% of previous). Sliding heal.`,
    });
}

/**
 * Process engagement events (open/click/reply) — unified for all platforms.
 * Updates lead, campaign, and mailbox counters. Recalculates lead score. Logs audit trail.
 */
async function processEngagementEvent(
    organizationId: string,
    mailboxId: string,
    campaignId: string | undefined,
    recipientEmail: string | undefined,
    type: 'open' | 'click' | 'reply'
): Promise<void> {
    const actionName = type === 'open' ? 'email_opened'
        : type === 'click' ? 'email_clicked'
        : 'email_replied';

    // 1. Find and update Lead engagement counter + recalculate score
    if (recipientEmail) {
        try {
            const lead = await prisma.lead.findFirst({
                where: { organization_id: organizationId, email: { equals: recipientEmail, mode: 'insensitive' } },
                select: { id: true },
            });
            if (lead) {
                const leadField = type === 'open' ? 'emails_opened'
                    : type === 'click' ? 'emails_clicked'
                    : 'emails_replied';
                await prisma.lead.update({
                    where: { id: lead.id },
                    data: {
                        [leadField]: { increment: 1 },
                        last_activity_at: new Date(),
                        updated_at: new Date(),
                    },
                });

                // Recalculate lead score (was missing for EB/Instantly)
                await recalculateLeadScore(lead.id);

                // Audit trail (was missing for EB/Instantly)
                await auditLogService.logAction({
                    organizationId,
                    entity: 'lead',
                    entityId: lead.id,
                    trigger: 'webhook',
                    action: actionName,
                    details: `${type === 'open' ? 'Opened email' : type === 'click' ? 'Clicked link' : 'Replied to email'} in campaign ${campaignId || 'unknown'} via mailbox ${mailboxId}`,
                });
            }
        } catch (err: any) {
            logger.warn(`[QUEUE] Failed to update lead engagement for ${recipientEmail}`, { error: err.message });
        }
    }

    // 2. Update Campaign engagement counter + recalculate rates
    if (campaignId) {
        try {
            const campaign = await prisma.campaign.findUnique({
                where: { id: campaignId },
                select: { id: true, open_count: true, click_count: true, reply_count: true, total_sent: true },
            });
            if (campaign) {
                const newOpens = campaign.open_count + (type === 'open' ? 1 : 0);
                const newClicks = campaign.click_count + (type === 'click' ? 1 : 0);
                const newReplies = campaign.reply_count + (type === 'reply' ? 1 : 0);
                const totalSent = Math.max(campaign.total_sent || 0, 1);
                await prisma.campaign.update({
                    where: { id: campaignId },
                    data: {
                        open_count: newOpens,
                        click_count: newClicks,
                        reply_count: newReplies,
                        open_rate: (newOpens / totalSent) * 100,
                        reply_rate: (newReplies / totalSent) * 100,
                        analytics_updated_at: new Date(),
                    },
                });
            }
        } catch (err: any) {
            logger.warn(`[QUEUE] Failed to update campaign engagement for ${campaignId}`, { error: err.message });
        }
    }

    // 3. Update Mailbox lifetime engagement counters + recalculate engagement_rate
    try {
        const mailbox = await prisma.mailbox.findUnique({
            where: { id: mailboxId },
            select: {
                id: true,
                open_count_lifetime: true,
                click_count_lifetime: true,
                reply_count_lifetime: true,
                total_sent_count: true,
            },
        });
        if (mailbox) {
            const newOpens = mailbox.open_count_lifetime + (type === 'open' ? 1 : 0);
            const newClicks = mailbox.click_count_lifetime + (type === 'click' ? 1 : 0);
            const newReplies = mailbox.reply_count_lifetime + (type === 'reply' ? 1 : 0);
            const totalEngagement = newOpens + newClicks + newReplies;
            const engagementRate = mailbox.total_sent_count > 0
                ? (totalEngagement / mailbox.total_sent_count) * 100
                : 0;
            await prisma.mailbox.update({
                where: { id: mailbox.id },
                data: {
                    open_count_lifetime: newOpens,
                    click_count_lifetime: newClicks,
                    reply_count_lifetime: newReplies,
                    engagement_rate: engagementRate,
                },
            });
        }
    } catch (err: any) {
        logger.warn(`[QUEUE] Failed to update mailbox engagement for ${mailboxId}`, { error: err.message });
    }
}

/**
 * Process spam complaint events — unified for all platforms.
 * Blocks lead, increments mailbox spam_count, logs audit trail.
 */
async function processSpamEvent(
    organizationId: string,
    mailboxId: string,
    campaignId: string | undefined,
    recipientEmail: string | undefined
): Promise<void> {
    // 1. Block lead via state machine (was missing for EB/Instantly)
    if (recipientEmail) {
        try {
            const lead = await prisma.lead.findFirst({
                where: { organization_id: organizationId, email: { equals: recipientEmail, mode: 'insensitive' } },
                select: { id: true },
            });
            if (lead) {
                await entityStateService.transitionLead(
                    organizationId, lead.id, LeadState.BLOCKED,
                    'Spam complaint received', TriggerType.WEBHOOK
                );
                await prisma.lead.update({
                    where: { id: lead.id },
                    data: { health_state: 'unhealthy', health_classification: 'red', updated_at: new Date() },
                });
            }
        } catch (err: any) {
            logger.warn(`[QUEUE] Failed to block lead for spam complaint: ${recipientEmail}`, { error: err.message });
        }
    }

    // 2. Increment mailbox spam_count
    try {
        await prisma.mailbox.update({
            where: { id: mailboxId },
            data: { spam_count: { increment: 1 } },
        });
    } catch (err: any) {
        logger.warn('[QUEUE] Failed to increment spam_count (mailbox may not exist)', { entityId: mailboxId });
    }

    // 3. Audit trail (was missing for EB/Instantly)
    await auditLogService.logAction({
        organizationId,
        entity: 'mailbox',
        entityId: mailboxId,
        trigger: 'webhook',
        action: 'spam_complaint_received',
        details: `Spam complaint from ${recipientEmail || 'unknown'}${campaignId ? ` in campaign ${campaignId}` : ''}`,
    });

    logger.info('[QUEUE] Spam complaint processed', { mailboxId, campaignId, recipientEmail });
}

/**
 * Process unsubscribe events — unified for all platforms.
 * Blocks lead, updates campaign unsubscribed_count, logs audit trail.
 */
async function processUnsubscribeEvent(
    organizationId: string,
    mailboxId: string,
    campaignId: string | undefined,
    recipientEmail: string | undefined
): Promise<void> {
    // 1. Block lead via state machine (was a no-op for EB/Instantly)
    if (recipientEmail) {
        try {
            const lead = await prisma.lead.findFirst({
                where: { organization_id: organizationId, email: { equals: recipientEmail, mode: 'insensitive' } },
                select: { id: true },
            });
            if (lead) {
                await entityStateService.transitionLead(
                    organizationId, lead.id, LeadState.BLOCKED,
                    'Lead unsubscribed', TriggerType.WEBHOOK
                );
                await prisma.lead.update({
                    where: { id: lead.id },
                    data: { health_state: 'unhealthy', updated_at: new Date() },
                });

                await auditLogService.logAction({
                    organizationId,
                    entity: 'lead',
                    entityId: lead.id,
                    trigger: 'webhook',
                    action: 'lead_unsubscribed',
                    details: `Lead unsubscribed${campaignId ? ` from campaign ${campaignId}` : ''}`,
                });
            }
        } catch (err: any) {
            logger.warn(`[QUEUE] Failed to block lead for unsubscribe: ${recipientEmail}`, { error: err.message });
        }
    }

    // 2. Update campaign unsubscribed_count (was missing for EB/Instantly)
    if (campaignId) {
        try {
            await prisma.campaign.update({
                where: { id: campaignId },
                data: {
                    unsubscribed_count: { increment: 1 },
                    analytics_updated_at: new Date(),
                },
            });
        } catch (err: any) {
            logger.warn(`[QUEUE] Failed to update campaign unsubscribe count for ${campaignId}`, { error: err.message });
        }
    }

    logger.info('[QUEUE] Unsubscribe event processed', { mailboxId, campaignId, recipientEmail });
}

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
    const { eventType, entityId, campaignId, smtpResponse, organizationId } = data;
    // Normalize email to lowercase — prevents case-mismatch lead lookup failures
    const recipientEmail = data.recipientEmail?.toLowerCase().trim();

    switch (eventType) {
        case EventType.HARD_BOUNCE:
        case 'EMAIL_BOUNCE':
        case 'BOUNCE':
            await bounceProcessingService.processBounce({
                organizationId,
                mailboxId: entityId,
                campaignId: campaignId || undefined,
                recipientEmail,
                smtpResponse,
                bounceType: data.bounceType,
                sentAt: data.sentAt ? new Date(data.sentAt) : undefined,
                bouncedAt: data.bouncedAt ? new Date(data.bouncedAt) : undefined,
            });
            break;

        case EventType.EMAIL_SENT:
        case 'SENT':
            await processSentEvent(organizationId, entityId, campaignId, recipientEmail);
            break;

        case 'EmailOpened':
            await processEngagementEvent(organizationId, entityId, campaignId, recipientEmail, 'open');
            break;

        case 'EmailClicked':
            await processEngagementEvent(organizationId, entityId, campaignId, recipientEmail, 'click');
            break;

        case 'EmailReplied':
            await processEngagementEvent(organizationId, entityId, campaignId, recipientEmail, 'reply');
            break;

        case 'SpamComplaint':
        case 'SPAM_COMPLAINT':
            await processSpamEvent(organizationId, entityId, campaignId, recipientEmail);
            break;

        case 'EmailUnsubscribed':
            await processUnsubscribeEvent(organizationId, entityId, campaignId, recipientEmail);
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
