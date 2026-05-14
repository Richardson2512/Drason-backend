/**
 * Outreach.io export worker.
 *
 * Polls OutreachExportJob rows in `pending` or `running` state, walks
 * their lead_ids snapshot one chunk per tick, upserts each lead as an
 * Outreach prospect, and adds the prospect to the chosen sequence
 * under the chosen mailbox. Resumes mid-flight via the cursor index.
 *
 * Idempotent on email — re-exporting the same lead returns the existing
 * prospect, and re-adding to the same sequence/mailbox is a no-op.
 */

import { prisma } from '../prisma';
import { logger } from '../services/observabilityService';
import {
    getOutreachConnection,
    updateRefreshedTokens,
    markOutreachConnectionFailed,
} from '../services/outreach/connectionService';
import { OutreachClient } from '../services/outreach/client';
import { OutreachError } from '../services/outreach/types';

const POLL_INTERVAL_MS = 15_000;
const CHUNK_PER_TICK = 25; // ~25 prospects per tick — keeps worker responsive

let running = false;
let stopped = false;
let timer: NodeJS.Timeout | null = null;

async function processJob(jobId: string): Promise<void> {
    const job = await prisma.outreachExportJob.findUnique({ where: { id: jobId } });
    if (!job || (job.state !== 'pending' && job.state !== 'running')) return;

    const decrypted = await getOutreachConnection(job.outreach_connection_id, job.organization_id);
    if (!decrypted || decrypted.status !== 'active' || decrypted.disconnectedAt) {
        await prisma.outreachExportJob.update({
            where: { id: job.id },
            data: {
                state: 'cancelled',
                error_message: 'Outreach connection inactive',
                finished_at: new Date(),
            },
        });
        return;
    }

    const client = new OutreachClient({
        accessToken: decrypted.accessToken,
        refreshToken: decrypted.refreshToken,
        onTokensRefreshed: async (fresh) => {
            await updateRefreshedTokens(decrypted.id, {
                accessToken: fresh.access_token,
                refreshToken: fresh.refresh_token,
                tokenExpiresAt: fresh.expires_at,
            });
        },
    });

    if (job.state === 'pending') {
        await prisma.outreachExportJob.update({
            where: { id: job.id },
            data: { state: 'running', started_at: new Date() },
        });
    }

    let cursor = job.cursor;
    let totalProcessed = job.total_processed;
    let totalCreated = job.total_prospects_created;
    let totalUpdated = job.total_prospects_updated;
    let totalAdded = job.total_added_to_sequence;
    let totalSkipped = job.total_skipped;
    let totalFailed = job.total_failed;

    const slice = job.prospect_ids.slice(cursor, cursor + CHUNK_PER_TICK);
    if (slice.length === 0) {
        await finalize(job.id, decrypted.id, {
            totalProcessed, totalCreated, totalUpdated, totalAdded, totalSkipped, totalFailed,
        });
        return;
    }

    // Pull CampaignLead rows for this chunk + the matching Lead row (when
    // present) so we can pick up phone/linkedin from the broader Lead record.
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
            select: { email: true, phone: true, linkedin_url: true, full_name: true },
        })
        : [];
    const leadByEmail = new Map(leadRows.map(l => [l.email.toLowerCase(), l]));
    const cLeadById = new Map(campaignLeads.map(c => [c.id, c]));

    try {
        for (const id of slice) {
            const cl = cLeadById.get(id);
            if (!cl || !cl.email) {
                totalSkipped += 1;
                totalProcessed += 1;
                continue;
            }
            const enriched = leadByEmail.get(cl.email.toLowerCase());
            try {
                const result = await client.upsertProspect({
                    email: cl.email,
                    firstName: cl.first_name,
                    lastName: cl.last_name,
                    title: cl.title,
                    company: cl.company,
                    phone: enriched?.phone ?? null,
                    linkedinUrl: enriched?.linkedin_url ?? null,
                    tags: ['Superkabe'],
                });
                if (result.created) totalCreated += 1; else totalUpdated += 1;

                const seq = await client.addProspectToSequence({
                    prospectId: result.id,
                    sequenceId: job.sequence_id,
                    mailboxId: job.add_to_mailbox_id ?? '',
                });
                if (seq.added || seq.alreadyIn) totalAdded += 1;
            } catch (err) {
                totalFailed += 1;
                if (err instanceof OutreachError && (err.providerCode === 'unauthorized' || err.status === 401)) {
                    // Auth dead — bail the whole job, don't burn through the chunk.
                    throw err;
                }
                logger.warn('[OUTREACH_EXPORT] per-prospect failure', {
                    jobId: job.id,
                    campaignLeadId: id,
                    msg: (err as Error).message?.slice(0, 200),
                });
            }
            totalProcessed += 1;
        }

        cursor += slice.length;

        if (cursor >= job.prospect_ids.length) {
            await finalize(job.id, decrypted.id, {
                totalProcessed, totalCreated, totalUpdated, totalAdded, totalSkipped, totalFailed,
            });
            logger.info('[OUTREACH_EXPORT] job completed', {
                jobId: job.id,
                totalProcessed, totalCreated, totalUpdated, totalAdded, totalSkipped, totalFailed,
            });
        } else {
            await prisma.outreachExportJob.update({
                where: { id: job.id },
                data: {
                    cursor,
                    total_processed: totalProcessed,
                    total_prospects_created: totalCreated,
                    total_prospects_updated: totalUpdated,
                    total_added_to_sequence: totalAdded,
                    total_skipped: totalSkipped,
                    total_failed: totalFailed,
                },
            });
        }
    } catch (err) {
        const message = (err as Error).message?.slice(0, 500) ?? 'Unknown export error';
        const retryable = err instanceof OutreachError ? err.retryable : false;
        const code = err instanceof OutreachError ? err.providerCode : undefined;

        if (retryable) {
            await prisma.outreachExportJob.update({
                where: { id: job.id },
                data: {
                    cursor,
                    error_message: message,
                    error_count: { increment: 1 },
                    total_processed: totalProcessed,
                    total_prospects_created: totalCreated,
                    total_prospects_updated: totalUpdated,
                    total_added_to_sequence: totalAdded,
                    total_skipped: totalSkipped,
                    total_failed: totalFailed,
                },
            });
            logger.warn('[OUTREACH_EXPORT] retryable failure', { jobId: job.id, code, msg: message });
        } else {
            await prisma.outreachExportJob.update({
                where: { id: job.id },
                data: {
                    cursor,
                    state: 'failed',
                    error_message: message,
                    error_count: { increment: 1 },
                    finished_at: new Date(),
                    total_processed: totalProcessed,
                    total_prospects_created: totalCreated,
                    total_prospects_updated: totalUpdated,
                    total_added_to_sequence: totalAdded,
                    total_skipped: totalSkipped,
                    total_failed: totalFailed,
                },
            });
            if (code === 'unauthorized' || code === 'invalid_token') {
                await markOutreachConnectionFailed(decrypted.id, 'expired', 'OAuth refresh failed during export');
            }
            logger.error('[OUTREACH_EXPORT] job failed', err instanceof Error ? err : new Error(String(err)));
        }
    }
}

async function finalize(
    jobId: string,
    connectionId: string,
    counters: {
        totalProcessed: number;
        totalCreated: number;
        totalUpdated: number;
        totalAdded: number;
        totalSkipped: number;
        totalFailed: number;
    },
): Promise<void> {
    await prisma.outreachExportJob.update({
        where: { id: jobId },
        data: {
            state: 'completed',
            total_processed: counters.totalProcessed,
            total_prospects_created: counters.totalCreated,
            total_prospects_updated: counters.totalUpdated,
            total_added_to_sequence: counters.totalAdded,
            total_skipped: counters.totalSkipped,
            total_failed: counters.totalFailed,
            finished_at: new Date(),
        },
    });
    await prisma.outreachConnection.update({
        where: { id: connectionId },
        data: { last_used_at: new Date() },
    });
}

async function tick(): Promise<void> {
    if (running || stopped) return;
    running = true;
    try {
        const jobs = await prisma.outreachExportJob.findMany({
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
                    '[OUTREACH_EXPORT] processJob crashed',
                    err instanceof Error ? err : new Error(String(err)),
                );
            }
        }
    } finally {
        running = false;
    }
}

export function startOutreachExportWorker(): void {
    if (timer) return;
    stopped = false;
    timer = setInterval(() => { tick().catch(() => undefined); }, POLL_INTERVAL_MS);
    logger.info('[OUTREACH_EXPORT_WORKER] started');
}

export function stopOutreachExportWorker(): void {
    stopped = true;
    if (timer) {
        clearInterval(timer);
        timer = null;
        logger.info('[OUTREACH_EXPORT_WORKER] stopped');
    }
}
