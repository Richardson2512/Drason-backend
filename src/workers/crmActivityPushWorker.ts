/**
 * CRM activity-push worker.
 *
 * Polls CrmActivityPushItem for `state='pending' AND next_attempt_at<=NOW()`,
 * resolves the right CrmClient via the provider registry, and pushes the
 * activity to the CRM. Provider-blind - no HubSpot or Salesforce code
 * here. Per-provider clients implement the actual HTTP.
 *
 * Retry policy (CrmPushError.retryable=true): exponential backoff up to
 * 6 attempts (1m, 5m, 15m, 1h, 4h, 12h). After that the row is marked
 * `failed` and surfaces in the dashboard's failed counter.
 */

import { prisma } from '../index';
import { logger } from '../services/observabilityService';
import { CrmPushError } from '../services/crm/types';
import { getFactory } from '../services/crm/registry';
import { getConnection, updateRefreshedTokens, markConnectionFailed } from '../services/crm/connectionService';
import { withWorkerLock } from '../utils/workerJobControl';

const POLL_INTERVAL_MS = 15_000; // every 15s - low enough to feel responsive, high enough to be cheap
const BATCH_SIZE = 25;
const MAX_ATTEMPTS = 6;
const RETRY_BACKOFF_MS = [
    60 * 1000,        // 1m
    5 * 60 * 1000,    // 5m
    15 * 60 * 1000,   // 15m
    60 * 60 * 1000,   // 1h
    4 * 60 * 60 * 1000,  // 4h
    12 * 60 * 60 * 1000, // 12h
];

// Distributed lock so only one backend instance drains this queue per tick.
const LOCK_KEY = 'worker:lock:crm_activity_push';
const LOCK_TTL_SECONDS = 300;

let running = false;
let stopped = false;

async function processOne(itemId: string): Promise<void> {
    const item = await prisma.crmActivityPushItem.findUnique({ where: { id: itemId } });
    if (!item || item.state !== 'pending') return;

    const conn = await prisma.crmConnection.findUnique({ where: { id: item.crm_connection_id } });
    if (!conn || conn.status !== 'active' || conn.disconnected_at) {
        await prisma.crmActivityPushItem.update({
            where: { id: item.id },
            data: { state: 'skipped', last_error: 'Connection inactive' },
        });
        return;
    }

    const factory = getFactory(conn.provider as any);
    if (!factory) {
        // Provider not registered in this process. Skip silently - another
        // pod with the right factory will pick it up. Don't burn an attempt.
        return;
    }

    const decrypted = await getConnection(conn.id, conn.organization_id);
    if (!decrypted) {
        await prisma.crmActivityPushItem.update({
            where: { id: item.id },
            data: { state: 'skipped', last_error: 'Connection vanished mid-push' },
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

    // Resolve CRM contact ID - if we don't have a link yet, try to find
    // the contact by email and create the link.
    let contactExternalId = item.crm_contact_id;
    if (!contactExternalId) {
        const link = await prisma.crmContactLink.findUnique({
            where: {
                crm_connection_id_superkabe_lead_id: {
                    crm_connection_id: conn.id,
                    superkabe_lead_id: item.superkabe_lead_id,
                },
            },
        });
        if (link) {
            contactExternalId = link.crm_contact_id;
        } else {
            // Look up by lead email
            const lead = await prisma.lead.findUnique({
                where: { id: item.superkabe_lead_id },
                select: { email: true },
            });
            if (!lead?.email) {
                await prisma.crmActivityPushItem.update({
                    where: { id: item.id },
                    data: { state: 'skipped', last_error: 'Lead has no email' },
                });
                return;
            }

            try {
                const externalId = await client.findContactIdByEmail(lead.email);
                if (!externalId) {
                    await prisma.crmActivityPushItem.update({
                        where: { id: item.id },
                        data: { state: 'skipped', last_error: 'Contact not found in CRM' },
                    });
                    return;
                }
                contactExternalId = externalId;
                await prisma.crmContactLink.upsert({
                    where: {
                        crm_connection_id_superkabe_lead_id: {
                            crm_connection_id: conn.id,
                            superkabe_lead_id: item.superkabe_lead_id,
                        },
                    },
                    create: {
                        crm_connection_id: conn.id,
                        superkabe_lead_id: item.superkabe_lead_id,
                        crm_contact_id: externalId,
                    },
                    update: { crm_contact_id: externalId },
                });
            } catch (err) {
                // Treat findContactIdByEmail failures as retryable.
                await scheduleRetry(item.id, item.attempts, err);
                return;
            }
        }
    }

    const payload = item.event_payload as Record<string, unknown>;
    const subject = typeof payload.subject === 'string' ? payload.subject : undefined;
    const body = typeof payload.body === 'string' ? payload.body : undefined;

    try {
        await client.pushActivity({
            contactExternalId,
            activity: {
                type: item.event_type as any,
                occurredAt: item.occurred_at,
                subject,
                body,
                metadata: payload,
            },
        });

        await prisma.crmActivityPushItem.update({
            where: { id: item.id },
            data: {
                state: 'pushed',
                pushed_at: new Date(),
                crm_contact_id: contactExternalId,
                last_error: null,
            },
        });
    } catch (err) {
        const isCrmErr = err instanceof CrmPushError;
        const retryable = isCrmErr ? err.retryable : true;
        const code = isCrmErr ? err.providerCode : undefined;

        // Refresh-failure → connection is probably permanently broken.
        if (code === 'refresh_failed') {
            await markConnectionFailed(conn.id, 'expired', 'OAuth refresh token rejected by provider');
        }

        if (!retryable) {
            await prisma.crmActivityPushItem.update({
                where: { id: item.id },
                data: {
                    state: 'failed',
                    attempts: item.attempts + 1,
                    last_error: (err as Error).message?.slice(0, 500) ?? 'Non-retryable failure',
                },
            });
            return;
        }

        await scheduleRetry(item.id, item.attempts, err);
    }
}

async function scheduleRetry(itemId: string, currentAttempts: number, err: unknown): Promise<void> {
    const nextAttempts = currentAttempts + 1;
    if (nextAttempts >= MAX_ATTEMPTS) {
        await prisma.crmActivityPushItem.update({
            where: { id: itemId },
            data: {
                state: 'failed',
                attempts: nextAttempts,
                last_error: ((err as Error).message ?? 'Failed after max attempts').slice(0, 500),
            },
        });
        return;
    }

    const delay = RETRY_BACKOFF_MS[Math.min(nextAttempts, RETRY_BACKOFF_MS.length - 1)];
    await prisma.crmActivityPushItem.update({
        where: { id: itemId },
        data: {
            attempts: nextAttempts,
            next_attempt_at: new Date(Date.now() + delay),
            last_error: ((err as Error).message ?? 'Retryable failure').slice(0, 500),
        },
    });
}

async function tick(): Promise<void> {
    if (running || stopped) return;
    running = true;
    try {
        await withWorkerLock(LOCK_KEY, LOCK_TTL_SECONDS, async () => {
            const candidates = await prisma.crmActivityPushItem.findMany({
                where: {
                    state: 'pending',
                    next_attempt_at: { lte: new Date() },
                },
                orderBy: { next_attempt_at: 'asc' },
                take: BATCH_SIZE,
                select: { id: true },
            });

            for (const c of candidates) {
                if (stopped) break;
                try {
                    await processOne(c.id);
                } catch (err) {
                    logger.error('[CRM_PUSH_WORKER] processOne crashed', err instanceof Error ? err : new Error(String(err)));
                }
            }
        });
    } finally {
        running = false;
    }
}

let timer: NodeJS.Timeout | null = null;

export function startCrmActivityPushWorker(): void {
    if (timer) return;
    stopped = false;
    timer = setInterval(() => { tick().catch(() => undefined); }, POLL_INTERVAL_MS);
    logger.info('[CRM_PUSH_WORKER] started');
}

export function stopCrmActivityPushWorker(): void {
    stopped = true;
    if (timer) {
        clearInterval(timer);
        timer = null;
        logger.info('[CRM_PUSH_WORKER] stopped');
    }
}
