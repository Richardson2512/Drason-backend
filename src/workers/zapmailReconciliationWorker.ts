/**
 * Zapmail Reconciliation Worker
 *
 * Sweeps every 15 minutes for two classes of stuck ConnectedAccount rows
 * left behind by the Zapmail Custom-OAuth flow:
 *
 *   1. Abandoned `oauth_pending` rows (Zapmail orchestration was triggered
 *      but the consent walk never completed). After 60 minutes we treat the
 *      attempt as dead, flip to `oauth_failed`, and surface a reason so the
 *      user can re-import. The 60-min bound matches the importStatus poll
 *      expiry on the front-end so UI and DB stay aligned.
 *
 *   2. Orphan `provisioning_failed` rows (OAuth completed but creating the
 *      shadow Mailbox/Domain failed). We re-run provisioning idempotently;
 *      success flips the row back to `active`.
 *
 * Both sweeps are bounded (LIMIT 50/run) so a backlog can't starve the
 * worker loop. Status is exposed via getZapmailReconciliationStatus() for
 * the admin/observability endpoints.
 */

import { prisma } from '../prisma';
import { logger } from '../services/observabilityService';
import { provisionMailboxForConnectedAccount } from '../services/mailboxProvisioningService';

const INTERVAL_MS = 15 * 60 * 1000;
const OAUTH_PENDING_EXPIRY_MS = 60 * 60 * 1000;
const SWEEP_LIMIT = 50;

let scheduled: NodeJS.Timeout | null = null;
let lastRunAt: Date | null = null;
let lastError: string | null = null;
let totalRuns = 0;
let totalOauthExpired = 0;
let totalProvisioningRecovered = 0;
let totalProvisioningStillFailing = 0;

interface SweepResult {
    oauthExpired: number;
    provisioningRecovered: number;
    provisioningStillFailing: number;
}

export const runZapmailReconciliation = async (): Promise<SweepResult> => {
    const result: SweepResult = {
        oauthExpired: 0,
        provisioningRecovered: 0,
        provisioningStillFailing: 0,
    };

    // ── Sweep 1: abandoned oauth_pending rows ────────────────────────────
    const expiryCutoff = new Date(Date.now() - OAUTH_PENDING_EXPIRY_MS);
    const stuckPending = await prisma.connectedAccount.findMany({
        where: {
            connection_status: 'oauth_pending',
            oauth_initiated_at: { lt: expiryCutoff },
        },
        select: { id: true, email: true, organization_id: true, zapmail_export_id: true },
        take: SWEEP_LIMIT,
    });

    if (stuckPending.length > 0) {
        const ids = stuckPending.map((r) => r.id);
        const updated = await prisma.connectedAccount.updateMany({
            where: { id: { in: ids }, connection_status: 'oauth_pending' },
            data: {
                connection_status: 'oauth_failed',
                last_error: 'oauth_expired: Custom OAuth consent did not complete within 60 minutes',
            },
        });
        result.oauthExpired = updated.count;
        logger.info(`[ZAPMAIL-RECON] Marked ${updated.count} stuck oauth_pending rows as oauth_failed`, {
            ids,
            exportIds: stuckPending.map((r) => r.zapmail_export_id).filter(Boolean),
        });
    }

    // ── Sweep 2: provisioning_failed rows — re-attempt ───────────────────
    const orphanProvisioning = await prisma.connectedAccount.findMany({
        where: { connection_status: 'provisioning_failed' },
        select: { id: true, email: true, display_name: true, organization_id: true },
        take: SWEEP_LIMIT,
    });

    for (const row of orphanProvisioning) {
        try {
            await provisionMailboxForConnectedAccount({
                connectedAccountId: row.id,
                organizationId: row.organization_id,
                email: row.email,
                displayName: row.display_name,
            });
            await prisma.connectedAccount.update({
                where: { id: row.id },
                data: { connection_status: 'active', last_error: null },
            });
            result.provisioningRecovered++;
            logger.info(`[ZAPMAIL-RECON] Recovered provisioning_failed row ${row.id} (${row.email})`);
        } catch (err) {
            result.provisioningStillFailing++;
            logger.warn('[ZAPMAIL-RECON] Provisioning re-attempt still failing', {
                accountId: row.id,
                email: row.email,
                error: err instanceof Error ? err.message : String(err),
            });
            await prisma.connectedAccount.update({
                where: { id: row.id },
                data: {
                    last_error: `provisioning_retry: ${err instanceof Error ? err.message : String(err)}`,
                },
            }).catch(() => undefined);
        }
    }

    lastRunAt = new Date();
    totalRuns++;
    totalOauthExpired += result.oauthExpired;
    totalProvisioningRecovered += result.provisioningRecovered;
    totalProvisioningStillFailing += result.provisioningStillFailing;
    return result;
};

export const scheduleZapmailReconciliationWorker = (): void => {
    const tick = async () => {
        try {
            await runZapmailReconciliation();
            lastError = null;
        } catch (err: unknown) {
            const e = err as { message?: string };
            lastError = (e?.message || 'unknown').slice(0, 200);
            logger.error('[ZAPMAIL-RECON] Sweep error', err instanceof Error ? err : new Error(String(err)));
        }
        scheduled = setTimeout(tick, INTERVAL_MS);
    };

    // Delay first run so server boot isn't blocked by a long sweep.
    scheduled = setTimeout(tick, 60 * 1000);
    logger.info(`[ZAPMAIL-RECON] Scheduled — sweep every ${INTERVAL_MS / 60000}m`);
};

export const stopZapmailReconciliationWorker = (): void => {
    if (scheduled) {
        clearTimeout(scheduled);
        scheduled = null;
        logger.info('[ZAPMAIL-RECON] Stopped');
    }
};

export const getZapmailReconciliationStatus = () => ({
    lastRunAt,
    lastError,
    totalRuns,
    totalOauthExpired,
    totalProvisioningRecovered,
    totalProvisioningStillFailing,
    intervalMinutes: INTERVAL_MS / 60000,
});
