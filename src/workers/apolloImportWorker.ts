/**
 * Apollo / lead-source import worker.
 *
 * Polls LeadSourceImportJob rows in `pending` or `running` state,
 * resolves the right provider via the lead-source registry, paginates
 * one page per tick, upserts contacts as Superkabe leads, and updates
 * progress counters. Resumes mid-flight via the cursor column.
 *
 * Idempotent on (organization_id, email). Honors the per-job `cap` so
 * a misclick doesn't drain the customer's Apollo credits.
 */

import { prisma } from '../prisma';
import { logger } from '../services/observabilityService';
import { getLeadSourceFactory } from '../services/leadSources/registry';
import {
    getLeadSourceConnection,
    markLeadSourceConnectionFailed,
} from '../services/leadSources/connectionService';
import type {
    LeadSourceContact,
    LeadSourceFilter,
    LeadSourceProvider,
} from '../services/leadSources/types';
import { LeadSourceError } from '../services/leadSources/types';
import { dispatchEmail } from '../services/emailTemplates/dispatcher';
import { importCompletedEmail } from '../services/emailTemplates/integrations';
import { buildFrontendUrl } from '../services/emailTemplates/requesterContext';

const POLL_INTERVAL_MS = 30_000;
const PAGE_SIZE = 100;

let running = false;
let stopped = false;
let timer: NodeJS.Timeout | null = null;

async function processJob(jobId: string): Promise<void> {
    const job = await prisma.leadSourceImportJob.findUnique({ where: { id: jobId } });
    if (!job || (job.state !== 'pending' && job.state !== 'running')) return;

    const connRow = await prisma.leadSourceConnection.findUnique({
        where: { id: job.lead_source_connection_id },
    });
    if (!connRow || connRow.status !== 'active' || connRow.disconnected_at) {
        await prisma.leadSourceImportJob.update({
            where: { id: job.id },
            data: {
                state: 'cancelled',
                error_message: 'Lead-source connection inactive',
                finished_at: new Date(),
            },
        });
        return;
    }

    const factory = getLeadSourceFactory(connRow.provider as LeadSourceProvider);
    if (!factory) return; // wrong process — skip

    const decrypted = await getLeadSourceConnection(connRow.id, connRow.organization_id);
    if (!decrypted) {
        await prisma.leadSourceImportJob.update({
            where: { id: job.id },
            data: {
                state: 'failed',
                error_message: 'Connection vanished',
                finished_at: new Date(),
            },
        });
        return;
    }

    const client = factory.create({ apiKey: decrypted.apiKey });
    const filter = job.parsed_filters as unknown as LeadSourceFilter | null;
    if (!filter || typeof filter !== 'object' || !('kind' in filter)) {
        await prisma.leadSourceImportJob.update({
            where: { id: job.id },
            data: {
                state: 'failed',
                error_message: 'Missing or malformed parsed_filters',
                finished_at: new Date(),
            },
        });
        return;
    }

    if (job.state === 'pending') {
        await prisma.leadSourceImportJob.update({
            where: { id: job.id },
            data: { state: 'running', started_at: new Date() },
        });
    }

    let cursor = job.cursor ?? null;
    let totalProcessed = job.total_processed;
    let totalCreated = job.total_created;
    let totalUpdated = job.total_updated;
    let totalSkipped = job.total_skipped;
    let totalFailed = job.total_failed;
    let creditsConsumed = job.credits_consumed;
    const cap = job.cap;

    try {
        // Don't fetch a page if we'd blow past the cap. Just complete.
        if (cap !== null && cap !== undefined && totalProcessed >= cap) {
            await finalize(job.id, connRow.id, {
                totalProcessed, totalCreated, totalUpdated, totalSkipped, totalFailed,
                creditsConsumed,
            });
            return;
        }

        const remaining = cap !== null && cap !== undefined
            ? Math.max(0, cap - totalProcessed)
            : PAGE_SIZE;
        const limit = Math.min(PAGE_SIZE, remaining);

        const page = await client.listContacts({
            filter,
            cursor,
            limit,
            revealPersonalEmails: job.reveal_personal_emails,
        });

        // bulk_match (when reveal is on) consumes one credit per contact returned.
        if (job.reveal_personal_emails) {
            creditsConsumed += page.contacts.length;
        }

        for (const contact of page.contacts) {
            if (cap !== null && cap !== undefined && totalProcessed >= cap) break;

            if (!contact.email) {
                totalSkipped += 1;
                continue;
            }
            try {
                const r = await upsertLead(connRow.organization_id, connRow.provider, contact);
                if (r === 'created') totalCreated += 1;
                else if (r === 'updated') totalUpdated += 1;
                else totalSkipped += 1;
                totalProcessed += 1;
            } catch (err) {
                totalFailed += 1;
                logger.warn('[LEAD_SOURCE_IMPORT] per-contact failure', {
                    jobId: job.id,
                    email: contact.email,
                    err: (err as Error).message?.slice(0, 200),
                });
            }
        }

        // Track total_estimated on the first page if the provider returned it.
        const totalEstimated = page.totalCount ?? null;

        cursor = page.nextCursor;

        const reachedCap = cap !== null && cap !== undefined && totalProcessed >= cap;
        if (!cursor || reachedCap) {
            await finalize(job.id, connRow.id, {
                totalProcessed, totalCreated, totalUpdated, totalSkipped, totalFailed,
                creditsConsumed, totalEstimated,
            });
            logger.info('[LEAD_SOURCE_IMPORT] job completed', {
                jobId: job.id,
                provider: connRow.provider,
                totalProcessed, totalCreated, totalUpdated, totalSkipped, totalFailed,
                reachedCap,
            });
        } else {
            await prisma.leadSourceImportJob.update({
                where: { id: job.id },
                data: {
                    cursor,
                    page: { increment: 1 },
                    total_processed: totalProcessed,
                    total_created: totalCreated,
                    total_updated: totalUpdated,
                    total_skipped: totalSkipped,
                    total_failed: totalFailed,
                    credits_consumed: creditsConsumed,
                    ...(totalEstimated !== null ? { total_estimated: totalEstimated } : {}),
                },
            });
        }
    } catch (err) {
        const message = (err as Error).message?.slice(0, 500) ?? 'Unknown import error';
        const retryable = err instanceof LeadSourceError ? err.retryable : false;
        const code = err instanceof LeadSourceError ? err.providerCode : undefined;

        if (retryable) {
            // Bump error counter but leave the job in `running` so the next
            // tick retries from the same cursor.
            await prisma.leadSourceImportJob.update({
                where: { id: job.id },
                data: {
                    error_message: message,
                    error_count: { increment: 1 },
                    total_processed: totalProcessed,
                    total_created: totalCreated,
                    total_updated: totalUpdated,
                    total_skipped: totalSkipped,
                    total_failed: totalFailed,
                    credits_consumed: creditsConsumed,
                },
            });
            logger.warn('[LEAD_SOURCE_IMPORT] retryable failure', { jobId: job.id, code, msg: message });
        } else {
            await prisma.leadSourceImportJob.update({
                where: { id: job.id },
                data: {
                    state: 'failed',
                    error_message: message,
                    error_count: { increment: 1 },
                    finished_at: new Date(),
                    total_processed: totalProcessed,
                    total_created: totalCreated,
                    total_updated: totalUpdated,
                    total_skipped: totalSkipped,
                    total_failed: totalFailed,
                    credits_consumed: creditsConsumed,
                },
            });
            if (code === 'invalid_key' || code === 'unauthorized') {
                await markLeadSourceConnectionFailed(
                    connRow.id,
                    'expired',
                    'Auth failed during import',
                );
            }
            logger.error(
                '[LEAD_SOURCE_IMPORT] job failed',
                err instanceof Error ? err : new Error(String(err)),
            );
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
        totalSkipped: number;
        totalFailed: number;
        creditsConsumed: number;
        totalEstimated?: number | null;
    },
): Promise<void> {
    const finishedAt = new Date();
    // `provider` lives on the parent LeadSourceConnection, not the job row.
    const job = await prisma.leadSourceImportJob.findUnique({
        where: { id: jobId },
        select: {
            organization_id: true,
            started_at: true,
            connection: { select: { provider: true } },
        },
    });
    await prisma.leadSourceImportJob.update({
        where: { id: jobId },
        data: {
            state: 'completed',
            cursor: null,
            total_processed: counters.totalProcessed,
            total_created: counters.totalCreated,
            total_updated: counters.totalUpdated,
            total_skipped: counters.totalSkipped,
            total_failed: counters.totalFailed,
            credits_consumed: counters.creditsConsumed,
            ...(counters.totalEstimated != null ? { total_estimated: counters.totalEstimated } : {}),
            finished_at: finishedAt,
        },
    });
    await prisma.leadSourceConnection.update({
        where: { id: connectionId },
        data: { last_used_at: new Date() },
    });

    // Import-complete email — fire-and-forget. Idempotent on jobId so a
    // duplicate finalize call can't double-send.
    if (job) {
        try {
            const org = await prisma.organization.findUnique({
                where: { id: job.organization_id },
                select: { name: true },
            });
            const durationMs = job.started_at ? finishedAt.getTime() - job.started_at.getTime() : 0;
            const sourceLabel = labelForSource(job.connection?.provider || 'unknown');
            void dispatchEmail({
                rendered: importCompletedEmail({
                    organizationName: org?.name || 'Your account',
                    sourceLabel,
                    totalProcessed: counters.totalProcessed,
                    totalCreated: counters.totalCreated,
                    totalUpdated: counters.totalUpdated,
                    totalSkipped: counters.totalSkipped,
                    totalFailed: counters.totalFailed,
                    durationLabel: formatImportDuration(durationMs),
                    creditsConsumed: counters.creditsConsumed,
                    contactsUrl: buildFrontendUrl('/dashboard/sequencer/contacts'),
                }),
                audience: { kind: 'org-admins', organizationId: job.organization_id },
                category: 'integration',
                eventKind: 'import_completed',
                idempotencyKey: `import-completed:${jobId}`,
            });
        } catch (err) {
            logger.warn('[APOLLO-IMPORT] Failed to dispatch completion email', { jobId, error: String(err) });
        }
    }
}

function labelForSource(provider: string): string {
    if (provider === 'apollo') return 'Apollo';
    if (provider === 'zoominfo') return 'ZoomInfo';
    if (provider === 'clay') return 'Clay';
    if (provider === 'smartlead') return 'Smartlead';
    if (provider === 'instantly') return 'Instantly';
    return provider.charAt(0).toUpperCase() + provider.slice(1);
}

function formatImportDuration(ms: number): string | null {
    if (ms <= 0) return null;
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remSec = seconds % 60;
    if (minutes < 60) return remSec > 0 ? `${minutes}m ${remSec}s` : `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    const remMin = minutes % 60;
    return remMin > 0 ? `${hours}h ${remMin}m` : `${hours}h`;
}

async function upsertLead(
    organizationId: string,
    provider: string,
    contact: LeadSourceContact,
): Promise<'created' | 'updated'> {
    const email = contact.email.toLowerCase().trim();
    const source = `${provider}_import`;

    const existing = await prisma.lead.findFirst({
        where: { organization_id: organizationId, email },
        select: { id: true },
    });

    if (existing) {
        await prisma.lead.update({
            where: { id: existing.id },
            data: {
                first_name: contact.firstName ?? undefined,
                last_name: contact.lastName ?? undefined,
                full_name: contact.fullName ?? undefined,
                company: contact.company ?? undefined,
                title: contact.title ?? undefined,
                phone: contact.phone ?? undefined,
                linkedin_url: contact.linkedinUrl ?? undefined,
                company_linkedin_url: contact.companyLinkedinUrl ?? undefined,
                source,
                import_external_id: contact.externalId,
            },
        });
        return 'updated';
    }

    await prisma.lead.create({
        data: {
            organization_id: organizationId,
            email,
            first_name: contact.firstName ?? null,
            last_name: contact.lastName ?? null,
            full_name: contact.fullName ?? null,
            company: contact.company ?? null,
            title: contact.title ?? null,
            phone: contact.phone ?? null,
            linkedin_url: contact.linkedinUrl ?? null,
            company_linkedin_url: contact.companyLinkedinUrl ?? null,
            persona: contact.title || contact.firstName || 'general',
            source,
            status: 'held',
            lead_score: 50,
            import_external_id: contact.externalId,
        },
    });
    return 'created';
}

async function tick(): Promise<void> {
    if (running || stopped) return;
    running = true;
    try {
        const jobs = await prisma.leadSourceImportJob.findMany({
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
                    '[LEAD_SOURCE_IMPORT] processJob crashed',
                    err instanceof Error ? err : new Error(String(err)),
                );
            }
        }
    } finally {
        running = false;
    }
}

export function startLeadSourceImportWorker(): void {
    if (timer) return;
    stopped = false;
    timer = setInterval(() => { tick().catch(() => undefined); }, POLL_INTERVAL_MS);
    logger.info('[LEAD_SOURCE_IMPORT_WORKER] started');
}

export function stopLeadSourceImportWorker(): void {
    stopped = true;
    if (timer) {
        clearInterval(timer);
        timer = null;
        logger.info('[LEAD_SOURCE_IMPORT_WORKER] stopped');
    }
}
