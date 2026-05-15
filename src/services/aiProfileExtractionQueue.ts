/**
 * AI Profile Extraction Queue - BullMQ-backed async pipeline for
 * `extractAndCacheProfile`.
 *
 * Why a queue:
 *   - Profile extraction takes seconds (Jina + OpenAI). At 100 concurrent
 *     orgs, the synchronous endpoint becomes a wall of long-held HTTP
 *     connections. Queueing lets the request return in ~1ms with a job
 *     id; the frontend polls until done.
 *   - BullMQ rate-limits + retries + tracks state so the controller stays
 *     thin.
 *   - Concurrency is bounded at the queue level (not just the in-process
 *     semaphore), so a single Node process can't spawn unbounded
 *     in-flight calls.
 *
 * Job lifecycle:
 *   waiting → active → completed   (success path)
 *   waiting → active → failed      (retried up to attempts; permanent fail)
 *
 * Job result (on completion):
 *   { profile: BusinessProfileV1, source_urls: string[] }
 *
 * Job error (on failure):
 *   The error message is stored on the BullMQ job record; controllers
 *   surface it verbatim to the dashboard.
 */

import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import IORedis from 'ioredis';
import { logger } from './observabilityService';
import { extractAndCacheProfile } from './aiCopywritingService';

// Queue names cannot contain ':' - see eventQueue.ts for the gotcha.
const QUEUE_NAME = 'drason-ai-profile-extraction';

interface JobPayload {
    organizationId: string;
    urls: string[];
}

interface JobResult {
    profile: any; // BusinessProfileV1
    source_urls: string[];
    extracted_at: string;
}

let queue: Queue<JobPayload, JobResult> | null = null;
let worker: Worker<JobPayload, JobResult> | null = null;
let connection: IORedis | null = null;

/** Lazy connection so the queue + worker share one Redis client. */
function getConnection(): ConnectionOptions {
    if (!process.env.REDIS_URL) {
        throw new Error('REDIS_URL is not configured - required for AI profile extraction queue');
    }
    if (!connection) {
        connection = new IORedis(process.env.REDIS_URL, {
            // BullMQ requires this to be null so it can run blocking commands.
            maxRetriesPerRequest: null,
        });
    }
    return connection;
}

export function getExtractionQueue(): Queue<JobPayload, JobResult> {
    if (!queue) {
        queue = new Queue<JobPayload, JobResult>(QUEUE_NAME, {
            connection: getConnection(),
            defaultJobOptions: {
                // 3 attempts total - one initial + two retries - with
                // exponential backoff. The OpenAI client wrapper has its
                // own retry/backoff; this layer protects against truly
                // transient failures (network, redis blips) at the job
                // boundary so a one-bad-jina-fetch job doesn't go red on
                // first try.
                attempts: 3,
                backoff: { type: 'exponential', delay: 5_000 },
                // Keep completed jobs for 24h so the dashboard can poll
                // status well after extraction finished. Failed jobs kept
                // for 7d for debugging.
                removeOnComplete: { age: 24 * 60 * 60 },
                removeOnFail: { age: 7 * 24 * 60 * 60 },
            },
        });
    }
    return queue;
}

/**
 * Enqueue an extraction job. Returns the job id immediately; caller
 * should respond 202 Accepted with the id. The frontend polls
 * `/api/ai/profile/jobs/:id` to track state.
 *
 * Per-org dedup: if an org already has an active or waiting extraction
 * job, the existing job id is returned instead of creating a duplicate.
 * This prevents the user from spamming the button and queuing 10x the
 * same work.
 */
export async function enqueueExtraction(payload: JobPayload): Promise<string> {
    const q = getExtractionQueue();

    // Dedup - look for an existing active/waiting job for this org.
    const existing = await q.getJobs(['waiting', 'waiting-children', 'active', 'delayed', 'paused']);
    for (const job of existing) {
        if (job.data?.organizationId === payload.organizationId) {
            logger.info('[AI_PROFILE_QUEUE] dedup - returning existing job', {
                orgId: payload.organizationId,
                jobId: job.id,
            });
            return String(job.id);
        }
    }

    const job = await q.add('extract', payload, {
        jobId: `${payload.organizationId}:${Date.now()}`,
    });
    logger.info('[AI_PROFILE_QUEUE] job enqueued', {
        orgId: payload.organizationId,
        jobId: job.id,
        urlCount: payload.urls.length,
    });
    return String(job.id);
}

export interface JobStatusResponse {
    id: string;
    state: 'waiting' | 'active' | 'completed' | 'failed' | 'delayed' | 'unknown';
    progress?: number;
    result?: JobResult;
    error?: string;
    /** Fast-path for the frontend so it can stop polling. */
    finished: boolean;
}

/**
 * Read the current state of a job. Org-scoped: a leaked job id from
 * another tenant won't reveal that tenant's profile because we verify
 * the stored `organizationId` matches before returning the result.
 */
export async function getJobStatus(jobId: string, organizationId: string): Promise<JobStatusResponse | null> {
    const q = getExtractionQueue();
    const job = await q.getJob(jobId);
    if (!job) return null;
    if (job.data?.organizationId !== organizationId) {
        // Pretend it doesn't exist so we don't leak job-id space.
        return null;
    }

    const rawState = await job.getState();
    const state = (rawState as JobStatusResponse['state']) ?? 'unknown';

    const finished = state === 'completed' || state === 'failed';
    const out: JobStatusResponse = {
        id: String(job.id),
        state,
        progress: typeof job.progress === 'number' ? job.progress : undefined,
        finished,
    };

    if (state === 'completed' && job.returnvalue) {
        out.result = job.returnvalue as JobResult;
    }
    if (state === 'failed' && job.failedReason) {
        out.error = job.failedReason;
    }

    return out;
}

// ────────────────────────────────────────────────────────────────────
// Worker - processes queued jobs.
//
// Concurrency: bounded at QUEUE_CONCURRENCY. Each call inside still
// passes through openaiClient's per-process semaphore, so this layer
// caps WORK initiated by the queue and the underlying client cap
// applies across all OpenAI users (queue + sync paths).
// ────────────────────────────────────────────────────────────────────

const QUEUE_CONCURRENCY = parseInt(process.env.AI_EXTRACTION_QUEUE_CONCURRENCY || '5', 10);

export function startExtractionWorker(): void {
    if (worker) return;
    if (!process.env.REDIS_URL) {
        logger.warn('[AI_PROFILE_QUEUE] REDIS_URL not set - extraction worker disabled (sync fallback only)');
        return;
    }

    worker = new Worker<JobPayload, JobResult>(
        QUEUE_NAME,
        async (job) => {
            const { organizationId, urls } = job.data;
            if (!Array.isArray(urls) || urls.length === 0) {
                throw new Error('Job payload missing urls[]');
            }
            logger.info('[AI_PROFILE_QUEUE] processing job', { orgId: organizationId, jobId: job.id, urls: urls.length });
            await job.updateProgress(10);

            const profile = await extractAndCacheProfile(organizationId, urls);
            await job.updateProgress(100);

            const result: JobResult = {
                profile,
                source_urls: urls,
                extracted_at: new Date().toISOString(),
            };
            logger.info('[AI_PROFILE_QUEUE] job completed', { orgId: organizationId, jobId: job.id });
            return result;
        },
        {
            connection: getConnection(),
            concurrency: QUEUE_CONCURRENCY,
        },
    );

    worker.on('failed', (job, err) => {
        logger.warn('[AI_PROFILE_QUEUE] job failed', {
            jobId: job?.id,
            attempt: job?.attemptsMade,
            of: job?.opts?.attempts,
            err: err?.message?.slice(0, 300),
        });
    });

    logger.info('[AI_PROFILE_EXTRACTION_WORKER] started', { concurrency: QUEUE_CONCURRENCY });
}

export async function stopExtractionWorker(): Promise<void> {
    if (worker) {
        await worker.close();
        worker = null;
    }
    if (queue) {
        await queue.close();
        queue = null;
    }
    if (connection) {
        connection.disconnect();
        connection = null;
    }
}
