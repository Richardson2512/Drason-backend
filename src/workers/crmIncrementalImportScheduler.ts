/**
 * CRM incremental-import scheduler.
 *
 * Once every 24 hours per active connection, queues an
 * `incremental_import` CrmSyncJob that re-pulls the same source filter
 * the last completed import used. The contact-import worker handles
 * the actual fetching and is idempotent on email - net-new contacts
 * land as new Superkabe leads, existing leads update in place.
 *
 * Webhooks (object.creation / object.propertyChange) provide near-
 * real-time deltas; this scheduler is the safety net that catches
 * anything missed by webhook delivery failures.
 */

import { prisma } from '../index';
import { logger } from '../services/observabilityService';

const POLL_INTERVAL_MS = 60 * 60 * 1000;            // 1 hour
const PER_CONNECTION_INTERVAL_MS = 24 * 60 * 60 * 1000;  // 24 hours

let running = false;
let stopped = false;

async function tick(): Promise<void> {
    if (running || stopped) return;
    running = true;
    try {
        const connections = await prisma.crmConnection.findMany({
            where: { status: 'active', disconnected_at: null },
            select: { id: true, organization_id: true, provider: true },
        });

        for (const conn of connections) {
            if (stopped) break;

            // Find the most recent completed import (initial OR incremental)
            // - we reuse its source_filter so the cadence keeps pulling
            // from the same HubSpot list / Salesforce view.
            const lastImport = await prisma.crmSyncJob.findFirst({
                where: {
                    crm_connection_id: conn.id,
                    type: { in: ['initial_import', 'incremental_import'] },
                    state: 'completed',
                },
                orderBy: { created_at: 'desc' },
                select: { source_filter: true, created_at: true },
            });

            // No prior import → user hasn't kicked one off yet, skip.
            if (!lastImport) continue;

            const ageMs = Date.now() - lastImport.created_at.getTime();
            if (ageMs < PER_CONNECTION_INTERVAL_MS) continue;

            // Don't double-queue if a pending/running import already exists.
            const inflight = await prisma.crmSyncJob.findFirst({
                where: {
                    crm_connection_id: conn.id,
                    type: { in: ['initial_import', 'incremental_import'] },
                    state: { in: ['pending', 'running'] },
                },
                select: { id: true },
            });
            if (inflight) continue;

            await prisma.crmSyncJob.create({
                data: {
                    crm_connection_id: conn.id,
                    type: 'incremental_import',
                    state: 'pending',
                    source_filter: lastImport.source_filter ?? undefined,
                },
            });
            logger.info('[CRM_INCREMENTAL] scheduled', {
                connectionId: conn.id,
                orgId: conn.organization_id,
                provider: conn.provider,
            });
        }
    } finally {
        running = false;
    }
}

let timer: NodeJS.Timeout | null = null;

export function startCrmIncrementalImportScheduler(): void {
    if (timer) return;
    stopped = false;
    timer = setInterval(() => { tick().catch(() => undefined); }, POLL_INTERVAL_MS);
    logger.info('[CRM_INCREMENTAL_SCHEDULER] started');
}

export function stopCrmIncrementalImportScheduler(): void {
    stopped = true;
    if (timer) {
        clearInterval(timer);
        timer = null;
        logger.info('[CRM_INCREMENTAL_SCHEDULER] stopped');
    }
}
