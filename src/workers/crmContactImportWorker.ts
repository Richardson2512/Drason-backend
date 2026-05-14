/**
 * CRM contact-import worker.
 *
 * Polls CrmSyncJob rows in `pending` or `running` state with type
 * `initial_import` (or `incremental_import`) and pulls contacts from
 * the CRM into Superkabe leads. Provider-blind — uses the registry to
 * resolve the right CrmClient.
 *
 * Resumes mid-flight via the cursor column. Idempotent on email — if a
 * lead already exists for the org/email, we update it rather than dupe.
 */

import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { logger } from '../services/observabilityService';
import { getFactory } from '../services/crm/registry';
import { getConnection, updateRefreshedTokens, markConnectionFailed } from '../services/crm/connectionService';
import type { CrmContact, CrmContactFilter } from '../services/crm/types';

const POLL_INTERVAL_MS = 30_000;
const PAGE_SIZE = 100;

let running = false;
let stopped = false;

async function applyFieldMapping(
    connectionId: string,
    contact: CrmContact,
): Promise<Record<string, string | undefined>> {
    // Read import-direction mappings once per call site (caller may cache).
    const mappings = await prisma.crmFieldMapping.findMany({
        where: { crm_connection_id: connectionId, direction: { in: ['import', 'bidirectional'] } },
    });

    // Defaults — these always import even if the user didn't add a mapping.
    const out: Record<string, string | undefined> = {
        email: contact.email,
        first_name: contact.firstName,
        last_name: contact.lastName,
        company: contact.company,
        title: contact.title,
        phone: contact.phone,
    };

    // Apply user-defined mappings on top.
    const all = (contact.customFields ?? {}) as Record<string, unknown>;
    for (const m of mappings) {
        const raw = all[m.crm_field];
        if (raw !== undefined && raw !== null) {
            out[m.superkabe_field] = String(raw);
        }
    }

    return out;
}

async function processJob(jobId: string): Promise<void> {
    const job = await prisma.crmSyncJob.findUnique({ where: { id: jobId } });
    if (!job || (job.state !== 'pending' && job.state !== 'running')) return;

    const conn = await prisma.crmConnection.findUnique({ where: { id: job.crm_connection_id } });
    if (!conn || conn.status !== 'active' || conn.disconnected_at) {
        await prisma.crmSyncJob.update({
            where: { id: job.id },
            data: { state: 'cancelled', error_message: 'Connection inactive', finished_at: new Date() },
        });
        return;
    }

    const factory = getFactory(conn.provider as any);
    if (!factory) return; // wrong process — skip

    const decrypted = await getConnection(conn.id, conn.organization_id);
    if (!decrypted) {
        await prisma.crmSyncJob.update({
            where: { id: job.id },
            data: { state: 'failed', error_message: 'Connection vanished', finished_at: new Date() },
        });
        return;
    }

    const client = factory.create({
        accessToken: decrypted.accessToken,
        refreshToken: decrypted.refreshToken,
        instanceUrl: decrypted.instanceUrl,
        onTokensRefreshed: async (fresh) => {
            await updateRefreshedTokens(decrypted.id, fresh);
        },
    });

    const filter: CrmContactFilter = (job.source_filter as any) ?? { kind: 'all' };

    // Mark running on first tick.
    if (job.state === 'pending') {
        await prisma.crmSyncJob.update({
            where: { id: job.id },
            data: { state: 'running', started_at: new Date() },
        });
    }

    let cursor = job.cursor ?? null;
    let totalProcessed = job.records_processed;
    let totalCreated = job.records_created;
    let totalUpdated = job.records_updated;
    let totalSkipped = job.records_skipped;
    let totalFailed = job.records_failed;

    try {
        // Pull one page per tick — keeps the worker responsive and bounds
        // the per-job work between polls. The same job re-enters on next tick.
        const page = await client.listContacts({
            filter,
            cursor,
            limit: PAGE_SIZE,
        });

        for (const contact of page.contacts) {
            if (!contact.email) {
                totalSkipped += 1;
                continue;
            }
            try {
                const mapped = await applyFieldMapping(conn.id, contact);
                const email = String(mapped.email ?? contact.email).toLowerCase().trim();

                const existing = await prisma.lead.findFirst({
                    where: { organization_id: conn.organization_id, email },
                    select: { id: true },
                });

                if (existing) {
                    await prisma.lead.update({
                        where: { id: existing.id },
                        data: {
                            persona: mapped.title || mapped.first_name || undefined,
                            source: 'hubspot_import',
                        },
                    });
                    totalUpdated += 1;
                    await upsertLink(conn.id, existing.id, contact.externalId);
                } else {
                    const created = await prisma.lead.create({
                        data: {
                            organization_id: conn.organization_id,
                            email,
                            persona: mapped.title || mapped.first_name || 'general',
                            source: `${conn.provider}_import`,
                            status: 'held',
                            lead_score: 50,
                        },
                    });
                    totalCreated += 1;
                    await upsertLink(conn.id, created.id, contact.externalId);
                }
                totalProcessed += 1;
            } catch (err) {
                totalFailed += 1;
                logger.warn('[CRM_IMPORT] per-contact failure', {
                    jobId: job.id,
                    email: contact.email,
                    err: (err as Error).message,
                });
            }
        }

        cursor = page.nextCursor;

        if (!cursor) {
            // Done.
            await prisma.crmSyncJob.update({
                where: { id: job.id },
                data: {
                    state: 'completed',
                    cursor: null,
                    records_processed: totalProcessed,
                    records_created: totalCreated,
                    records_updated: totalUpdated,
                    records_skipped: totalSkipped,
                    records_failed: totalFailed,
                    finished_at: new Date(),
                },
            });
            await prisma.crmConnection.update({
                where: { id: conn.id },
                data: { last_sync_at: new Date() },
            });
            logger.info('[CRM_IMPORT] job completed', {
                jobId: job.id,
                totalProcessed, totalCreated, totalUpdated, totalSkipped, totalFailed,
            });
        } else {
            await prisma.crmSyncJob.update({
                where: { id: job.id },
                data: {
                    cursor,
                    records_processed: totalProcessed,
                    records_created: totalCreated,
                    records_updated: totalUpdated,
                    records_skipped: totalSkipped,
                    records_failed: totalFailed,
                },
            });
        }
    } catch (err) {
        const message = (err as Error).message?.slice(0, 500) ?? 'Unknown import error';
        await prisma.crmSyncJob.update({
            where: { id: job.id },
            data: {
                state: 'failed',
                error_message: message,
                error_count: { increment: 1 },
                finished_at: new Date(),
            },
        });
        if (/refresh.*failed|invalid_grant/i.test(message)) {
            await markConnectionFailed(conn.id, 'expired', 'OAuth refresh failed during import');
        }
        logger.error('[CRM_IMPORT] job failed', err instanceof Error ? err : new Error(String(err)));
    }
}

async function upsertLink(connectionId: string, leadId: string, crmContactId: string): Promise<void> {
    try {
        await prisma.crmContactLink.upsert({
            where: {
                crm_connection_id_superkabe_lead_id: {
                    crm_connection_id: connectionId,
                    superkabe_lead_id: leadId,
                },
            },
            create: {
                crm_connection_id: connectionId,
                superkabe_lead_id: leadId,
                crm_contact_id: crmContactId,
                last_pulled_at: new Date(),
            },
            update: {
                crm_contact_id: crmContactId,
                last_pulled_at: new Date(),
            },
        });
    } catch (err) {
        // P2002 on (connectionId, crmContactId) — link to a different lead in
        // the same org for the same CRM contact. Rare. Log and move on.
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
            logger.warn('[CRM_IMPORT] crmContactLink unique conflict', { leadId, crmContactId });
            return;
        }
        throw err;
    }
}

async function tick(): Promise<void> {
    if (running || stopped) return;
    running = true;
    try {
        const jobs = await prisma.crmSyncJob.findMany({
            where: {
                type: { in: ['initial_import', 'incremental_import'] },
                state: { in: ['pending', 'running'] },
            },
            orderBy: { created_at: 'asc' },
            take: 5,
            select: { id: true },
        });
        for (const j of jobs) {
            if (stopped) break;
            try {
                await processJob(j.id);
            } catch (err) {
                logger.error('[CRM_IMPORT] processJob crashed', err instanceof Error ? err : new Error(String(err)));
            }
        }
    } finally {
        running = false;
    }
}

let timer: NodeJS.Timeout | null = null;

export function startCrmContactImportWorker(): void {
    if (timer) return;
    stopped = false;
    timer = setInterval(() => { tick().catch(() => undefined); }, POLL_INTERVAL_MS);
    logger.info('[CRM_IMPORT_WORKER] started');
}

export function stopCrmContactImportWorker(): void {
    stopped = true;
    if (timer) {
        clearInterval(timer);
        timer = null;
        logger.info('[CRM_IMPORT_WORKER] stopped');
    }
}
