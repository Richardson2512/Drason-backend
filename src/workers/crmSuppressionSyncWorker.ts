/**
 * CRM suppression-sync worker.
 *
 * Pulls the CRM's opt-out / do-not-contact list every 6 hours per
 * active connection and blocks matching Superkabe leads. Provider-
 * blind - uses the registry to dispatch to HubSpot or Salesforce
 * client.listSuppressions().
 *
 * Cadence is enforced by reading the most recent completed
 * `suppression_pull` CrmSyncJob for the connection - no schema change
 * needed. Tick frequency is 30 minutes; per-connection sync only
 * runs when the prior one completed >6h ago.
 */

import { prisma } from '../prisma';
import { logger } from '../services/observabilityService';
import { getFactory } from '../services/crm/registry';
import { getConnection, updateRefreshedTokens, markConnectionFailed } from '../services/crm/connectionService';

const POLL_INTERVAL_MS = 30 * 60 * 1000;       // 30 minutes
const PER_CONNECTION_INTERVAL_MS = 6 * 60 * 60 * 1000;  // 6 hours
const PAGE_HARD_CAP = 50;                       // safety: never page more than 50 times in one run

let running = false;
let stopped = false;

async function syncOne(connectionId: string): Promise<void> {
    const conn = await prisma.crmConnection.findUnique({ where: { id: connectionId } });
    if (!conn || conn.status !== 'active' || conn.disconnected_at) return;

    const factory = getFactory(conn.provider as any);
    if (!factory) return;

    const decrypted = await getConnection(conn.id, conn.organization_id);
    if (!decrypted) return;

    const job = await prisma.crmSyncJob.create({
        data: {
            crm_connection_id: conn.id,
            type: 'suppression_pull',
            state: 'running',
            started_at: new Date(),
        },
    });

    const client = factory.create({
        accessToken: decrypted.accessToken,
        refreshToken: decrypted.refreshToken,
        instanceUrl: decrypted.instanceUrl,
        onTokensRefreshed: async (fresh) => updateRefreshedTokens(conn.id, fresh),
    });

    let cursor: string | null = null;
    let pageNum = 0;
    let totalSeen = 0;
    let totalBlocked = 0;

    try {
        do {
            const page = await client.listSuppressions(cursor);
            for (const email of page.emails) {
                totalSeen += 1;
                const normalized = email.toLowerCase().trim();
                if (!normalized) continue;

                const lead = await prisma.lead.findFirst({
                    where: { organization_id: conn.organization_id, email: normalized },
                    select: { id: true, status: true },
                });
                if (lead && lead.status !== 'blocked') {
                    await prisma.lead.update({
                        where: { id: lead.id },
                        data: { status: 'blocked' },
                    });
                    totalBlocked += 1;
                }
            }
            cursor = page.nextCursor;
            pageNum += 1;
            if (pageNum >= PAGE_HARD_CAP) {
                logger.warn('[CRM_SUPPRESSION] page cap hit; deferring rest to next tick', { connectionId, pageNum });
                break;
            }
        } while (cursor);

        await prisma.crmSyncJob.update({
            where: { id: job.id },
            data: {
                state: 'completed',
                cursor: cursor ?? null,
                records_processed: totalSeen,
                records_updated: totalBlocked,
                finished_at: new Date(),
            },
        });
        await prisma.crmConnection.update({
            where: { id: conn.id },
            data: { last_sync_at: new Date() },
        });
        logger.info('[CRM_SUPPRESSION] synced', {
            connectionId, provider: conn.provider, totalSeen, totalBlocked,
        });
    } catch (err) {
        const message = (err as Error).message?.slice(0, 500) ?? 'unknown';
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
            await markConnectionFailed(conn.id, 'expired', 'OAuth refresh failed during suppression sync');
        }
        logger.error('[CRM_SUPPRESSION] sync failed', err instanceof Error ? err : new Error(String(err)));
    }
}

async function tick(): Promise<void> {
    if (running || stopped) return;
    running = true;
    try {
        const connections = await prisma.crmConnection.findMany({
            where: { status: 'active', disconnected_at: null },
            select: { id: true },
        });

        for (const conn of connections) {
            if (stopped) break;

            const lastJob = await prisma.crmSyncJob.findFirst({
                where: { crm_connection_id: conn.id, type: 'suppression_pull', state: 'completed' },
                orderBy: { created_at: 'desc' },
                select: { created_at: true },
            });
            const ageMs = lastJob ? Date.now() - lastJob.created_at.getTime() : Number.POSITIVE_INFINITY;
            if (ageMs < PER_CONNECTION_INTERVAL_MS) continue;

            try {
                await syncOne(conn.id);
            } catch (err) {
                logger.error('[CRM_SUPPRESSION] syncOne crashed', err instanceof Error ? err : new Error(String(err)));
            }
        }
    } finally {
        running = false;
    }
}

let timer: NodeJS.Timeout | null = null;

export function startCrmSuppressionSyncWorker(): void {
    if (timer) return;
    stopped = false;
    timer = setInterval(() => { tick().catch(() => undefined); }, POLL_INTERVAL_MS);
    logger.info('[CRM_SUPPRESSION_WORKER] started');
}

export function stopCrmSuppressionSyncWorker(): void {
    stopped = true;
    if (timer) {
        clearInterval(timer);
        timer = null;
        logger.info('[CRM_SUPPRESSION_WORKER] stopped');
    }
}
