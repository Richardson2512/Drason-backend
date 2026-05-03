/**
 * JustCall.io export worker.
 *
 * Walks JustCallExportJob rows in `pending` or `running` state and uses
 * JustCall's bulk_import endpoint (max 250 contacts/call) to push
 * Superkabe leads into a sales-dialer campaign. One JustCall call per
 * tick keeps the worker responsive and stays well inside the per-minute
 * burst quota even on the lowest plan (30/min).
 *
 * Idempotency: re-running the same job from cursor=N will re-import the
 * same chunk. JustCall dedupes by phone number on the campaign side,
 * so a re-import lands as "skipped" rather than producing duplicates.
 *
 * Failure modes:
 *   - 401/403 → mark connection failed, finalize job as `failed`
 *   - 422     → record per-job error, finalize as `failed` (validation)
 *   - 429     → handled inside JustCallClient (retry once)
 *   - 5xx     → keep job `running`, increment error_count, retry next tick
 */

import { prisma } from '../index';
import { logger } from '../services/observabilityService';
import {
    getJustCallConnection,
    markJustCallConnectionFailed,
} from '../services/justcall/connectionService';
import { JustCallClient } from '../services/justcall/client';
import { JustCallError, type JustCallContactInput } from '../services/justcall/types';

const POLL_INTERVAL_MS = 15_000;
/** One bulk_import call per tick. Max payload is 250 contacts.
 *  At the lowest plan (30 req/min) this leaves ample budget for the
 *  parallel /campaigns or /users calls a connected user might trigger
 *  from the dashboard. */
const CHUNK_PER_TICK = 250;

let running = false;
let stopped = false;
let timer: NodeJS.Timeout | null = null;

async function processJob(jobId: string): Promise<void> {
    const job = await prisma.justCallExportJob.findUnique({ where: { id: jobId } });
    if (!job || (job.state !== 'pending' && job.state !== 'running')) return;

    const decrypted = await getJustCallConnection(job.justcall_connection_id, job.organization_id);
    if (!decrypted || decrypted.status !== 'active' || decrypted.disconnectedAt) {
        await prisma.justCallExportJob.update({
            where: { id: job.id },
            data: {
                state: 'cancelled',
                error_message: 'JustCall connection inactive',
                finished_at: new Date(),
            },
        });
        return;
    }

    const client = new JustCallClient({
        apiKey: decrypted.apiKey,
        apiSecret: decrypted.apiSecret,
    });

    if (job.state === 'pending') {
        await prisma.justCallExportJob.update({
            where: { id: job.id },
            data: { state: 'running', started_at: new Date() },
        });
    }

    let cursor = job.cursor;
    let totalProcessed = job.total_processed;
    let totalAdded = job.total_added;
    let totalSkipped = job.total_skipped;
    let totalFailed = job.total_failed;

    const slice = job.prospect_ids.slice(cursor, cursor + CHUNK_PER_TICK);
    if (slice.length === 0) {
        await finalize(job.id, decrypted.id, {
            totalProcessed, totalAdded, totalSkipped, totalFailed,
        });
        return;
    }

    // Pull CampaignLead rows for this chunk and the matching Lead row
    // (when present) so phone numbers from the broader Lead record can
    // backfill any missing campaign-level data.
    const campaignLeads = await prisma.campaignLead.findMany({
        where: {
            id: { in: slice },
            campaign: { organization_id: job.organization_id },
        },
        select: {
            id: true,
            email: true,
            first_name: true,
            last_name: true,
            company: true,
            title: true,
        },
    });
    const emails = campaignLeads.map(c => c.email).filter((e): e is string => !!e);
    const leadRows = emails.length > 0
        ? await prisma.lead.findMany({
            where: {
                email: { in: emails },
                organization_id: job.organization_id,
            },
            select: { email: true, phone: true },
        })
        : [];
    const leadByEmail = new Map(leadRows.map(l => [l.email.toLowerCase(), l]));
    const cLeadById = new Map(campaignLeads.map(c => [c.id, c]));

    // Build the JustCall contact payload. Skip rows missing a phone —
    // a sales-dialer campaign without a phone number is meaningless and
    // JustCall would 422 the whole batch.
    const contacts: JustCallContactInput[] = [];
    let skippedNoPhone = 0;
    for (const id of slice) {
        const cl = cLeadById.get(id);
        if (!cl) {
            skippedNoPhone += 1;
            continue;
        }
        const enriched = cl.email ? leadByEmail.get(cl.email.toLowerCase()) : undefined;
        const phone = enriched?.phone?.trim();
        if (!phone) {
            skippedNoPhone += 1;
            continue;
        }
        const name = [cl.first_name, cl.last_name].filter(Boolean).join(' ').trim()
            || cl.email
            || 'Superkabe lead';
        contacts.push({
            name,
            phone_number: phone,
            email: cl.email ?? undefined,
            company: cl.company ?? undefined,
            title: cl.title ?? undefined,
        });
    }

    try {
        if (contacts.length > 0) {
            const result = await client.bulkImportContacts({
                campaignId: job.campaign_id,
                contacts,
            });
            totalAdded += result.added;
            totalSkipped += result.skipped + skippedNoPhone;
            totalFailed += result.failed;
        } else {
            // Whole chunk had no usable phones — count and move on.
            totalSkipped += skippedNoPhone;
        }
        totalProcessed += slice.length;
        cursor += slice.length;

        if (cursor >= job.prospect_ids.length) {
            await finalize(job.id, decrypted.id, {
                totalProcessed, totalAdded, totalSkipped, totalFailed,
            });
            logger.info('[JUSTCALL_EXPORT] job completed', {
                jobId: job.id,
                totalProcessed, totalAdded, totalSkipped, totalFailed,
            });
        } else {
            await prisma.justCallExportJob.update({
                where: { id: job.id },
                data: {
                    cursor,
                    total_processed: totalProcessed,
                    total_added: totalAdded,
                    total_skipped: totalSkipped,
                    total_failed: totalFailed,
                },
            });
        }
    } catch (err) {
        const message = err instanceof Error ? err.message?.slice(0, 500) : 'Unknown export error';
        const retryable = err instanceof JustCallError ? err.retryable : false;
        const code = err instanceof JustCallError ? err.providerCode : undefined;
        const status = err instanceof JustCallError ? err.status : undefined;

        if (retryable) {
            await prisma.justCallExportJob.update({
                where: { id: job.id },
                data: {
                    cursor,
                    error_message: message ?? null,
                    error_count: { increment: 1 },
                    total_processed: totalProcessed,
                    total_added: totalAdded,
                    total_skipped: totalSkipped,
                    total_failed: totalFailed,
                },
            });
            logger.warn('[JUSTCALL_EXPORT] retryable failure — will retry', { jobId: job.id, code, status, msg: message });
        } else {
            await prisma.justCallExportJob.update({
                where: { id: job.id },
                data: {
                    cursor,
                    state: 'failed',
                    error_message: message ?? null,
                    error_count: { increment: 1 },
                    finished_at: new Date(),
                    total_processed: totalProcessed,
                    total_added: totalAdded,
                    total_skipped: totalSkipped,
                    total_failed: totalFailed,
                },
            });
            if (code === 'unauthorized') {
                await markJustCallConnectionFailed(decrypted.id, message ?? 'JustCall rejected the credentials');
            }
            logger.error('[JUSTCALL_EXPORT] job failed', err instanceof Error ? err : new Error(String(err)));
        }
    }
}

async function finalize(
    jobId: string,
    connectionId: string,
    counters: {
        totalProcessed: number;
        totalAdded: number;
        totalSkipped: number;
        totalFailed: number;
    },
): Promise<void> {
    await prisma.justCallExportJob.update({
        where: { id: jobId },
        data: {
            state: 'completed',
            total_processed: counters.totalProcessed,
            total_added: counters.totalAdded,
            total_skipped: counters.totalSkipped,
            total_failed: counters.totalFailed,
            finished_at: new Date(),
        },
    });
    await prisma.justCallConnection.update({
        where: { id: connectionId },
        data: { last_used_at: new Date() },
    });
}

async function tick(): Promise<void> {
    if (running || stopped) return;
    running = true;
    try {
        const jobs = await prisma.justCallExportJob.findMany({
            where: { state: { in: ['pending', 'running'] } },
            orderBy: { created_at: 'asc' },
            take: 5,
            select: { id: true },
        });
        for (const j of jobs) {
            if (stopped) break;
            try {
                await processJob(j.id);
            } catch (err) {
                logger.error(
                    '[JUSTCALL_EXPORT] processJob crashed',
                    err instanceof Error ? err : new Error(String(err)),
                );
            }
        }
    } finally {
        running = false;
    }
}

export function startJustCallExportWorker(): void {
    if (timer) return;
    stopped = false;
    timer = setInterval(() => { tick().catch(() => undefined); }, POLL_INTERVAL_MS);
    logger.info('[JUSTCALL_EXPORT_WORKER] started');
}

export function stopJustCallExportWorker(): void {
    stopped = true;
    if (timer) {
        clearInterval(timer);
        timer = null;
        logger.info('[JUSTCALL_EXPORT_WORKER] stopped');
    }
}
