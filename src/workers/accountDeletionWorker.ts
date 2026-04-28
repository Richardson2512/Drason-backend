/**
 * Account Deletion Worker
 *
 * Executes pending DSAR account-deletion requests after their 30-day grace
 * period. Scans the AuditLog stream for `entity='account_deletion'`
 * `action='deletion_requested'` rows whose timestamp + grace_period_days has
 * elapsed, and that have NOT been cancelled by a later `deletion_cancelled`
 * row. For each, calls `eraseOrganization` and writes a `deletion_executed`
 * AuditLog row when complete.
 *
 * Required for GDPR Art. 17 compliance — without this worker, deletion
 * requests would queue forever and we'd be in violation.
 */

import { prisma } from '../index';
import { logger } from '../services/observabilityService';
import { eraseOrganization } from '../services/piiErasureService';

const RUN_INTERVAL_MS = 6 * 60 * 60 * 1000;     // 6h — deletion is not time-critical
const FIRST_RUN_DELAY_MS = 5 * 60 * 1000;       // 5min after boot

let scheduled: NodeJS.Timeout | null = null;
let lastRunAt: Date | null = null;
let lastError: string | null = null;
let totalRuns = 0;
let totalErased = 0;

interface DeletionRequest {
    auditLogId: string;
    organizationId: string;
    userId: string | null;
    requestedAt: Date;
    cancellationToken: string | null;
    graceDays: number;
}

function tryParseDetails(json: string | null): { cancellation_token?: string; grace_period_days?: number } {
    if (!json) return {};
    try { return JSON.parse(json); } catch { return {}; }
}

/**
 * Scan + execute one cycle. Idempotent — if it crashes mid-run, the next
 * cycle will retry whatever didn't complete (we write `deletion_executed`
 * only on success).
 */
export async function runOnce(): Promise<{ executed: number; errors: number }> {
    let executed = 0;
    let errors = 0;

    // Pull all pending requests across all orgs. Each org's request lives in
    // its own AuditLog stream so we can't filter by org_id; we scan globally
    // by entity type.
    const requests = await prisma.auditLog.findMany({
        where: {
            entity: 'account_deletion',
            action: 'deletion_requested',
        },
        orderBy: { timestamp: 'asc' },
        select: {
            id: true,
            organization_id: true,
            entity_id: true,
            user_id: true,
            timestamp: true,
            details: true,
        },
    });

    if (requests.length === 0) {
        return { executed: 0, errors: 0 };
    }

    for (const req of requests) {
        const details = tryParseDetails(req.details);
        const graceDays = details.grace_period_days ?? 30;
        const executesAfter = new Date(req.timestamp.getTime() + graceDays * 24 * 60 * 60 * 1000);
        if (executesAfter > new Date()) {
            // Still in grace period.
            continue;
        }

        // Was the request cancelled? Look for a later cancelled row with the
        // same entity_id (userId).
        const cancelled = await prisma.auditLog.findFirst({
            where: {
                organization_id: req.organization_id,
                entity: 'account_deletion',
                entity_id: req.entity_id,
                action: 'deletion_cancelled',
                timestamp: { gt: req.timestamp },
            },
            select: { id: true },
        });
        if (cancelled) {
            // Write a one-time "skipped" marker so we don't re-evaluate every cycle.
            await prisma.auditLog.create({
                data: {
                    organization_id: req.organization_id,
                    entity: 'account_deletion',
                    entity_id: req.entity_id,
                    trigger: 'system',
                    action: 'deletion_skipped_cancelled',
                    details: JSON.stringify({ original_request_id: req.id }),
                },
            }).catch(() => { /* best effort */ });
            // Also delete the original request row so we don't keep finding it.
            await prisma.auditLog.delete({ where: { id: req.id } }).catch(() => {});
            continue;
        }

        // Was this request already executed? (Some prior cycle may have
        // erased the org but failed to delete the original AuditLog row.)
        const alreadyExecuted = await prisma.auditLog.findFirst({
            where: {
                organization_id: req.organization_id,
                entity: 'account_deletion',
                entity_id: req.entity_id,
                action: 'deletion_executed',
            },
            select: { id: true },
        });
        if (alreadyExecuted) {
            await prisma.auditLog.delete({ where: { id: req.id } }).catch(() => {});
            continue;
        }

        // Execute. eraseOrganization scrubs PII + deletes the Organization row.
        try {
            const summary = await eraseOrganization(req.organization_id);
            await prisma.auditLog.create({
                data: {
                    // The Organization is deleted; this row's FK relation will SetNull.
                    organization_id: req.organization_id,
                    entity: 'account_deletion',
                    entity_id: req.entity_id,
                    trigger: 'system',
                    action: 'deletion_executed',
                    details: JSON.stringify({
                        ...summary,
                        executed_at: new Date().toISOString(),
                        original_request_id: req.id,
                        grace_days: graceDays,
                    }),
                },
            });
            executed++;
            totalErased++;
        } catch (err) {
            errors++;
            logger.error(
                '[ACCOUNT-DELETION-WORKER] Org erasure failed',
                err instanceof Error ? err : new Error(String(err)),
                { organizationId: req.organization_id, requestId: req.id },
            );
        }
    }

    return { executed, errors };
}

export function scheduleAccountDeletionWorker(): void {
    const tick = async () => {
        try {
            const result = await runOnce();
            lastError = null;
            if (result.executed > 0 || result.errors > 0) {
                logger.info('[ACCOUNT-DELETION-WORKER] Cycle complete', result);
            }
        } catch (err: any) {
            lastError = err.message?.slice(0, 200) || 'unknown';
            logger.error('[ACCOUNT-DELETION-WORKER] Cycle threw', err);
        }
        lastRunAt = new Date();
        totalRuns++;
        scheduled = setTimeout(tick, RUN_INTERVAL_MS);
    };

    scheduled = setTimeout(tick, FIRST_RUN_DELAY_MS);
    logger.info(`[ACCOUNT-DELETION-WORKER] Scheduled — sweep every ${RUN_INTERVAL_MS / 3600_000}h`);
}

export function stopAccountDeletionWorker(): void {
    if (scheduled) {
        clearTimeout(scheduled);
        scheduled = null;
        logger.info('[ACCOUNT-DELETION-WORKER] Stopped');
    }
}

export function getAccountDeletionWorkerStatus() {
    return { lastRunAt, lastError, totalRuns, totalErased };
}
