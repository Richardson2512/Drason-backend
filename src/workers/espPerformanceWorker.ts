/**
 * ESP Performance Aggregation Worker
 *
 * Runs every 6 hours. Aggregates SendEvent + BounceEvent data from the last
 * 30 days into per-mailbox × per-ESP performance scores in MailboxEspPerformance.
 *
 * This data powers the ESP-aware routing: when a lead is pushed to a campaign,
 * the routing layer picks mailboxes with the lowest bounce rate for the
 * recipient's ESP bucket.
 */

import { prisma } from '../index';
import { logger } from '../services/observabilityService';

const RUN_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

/**
 * Aggregate 30-day send + bounce data per mailbox × per ESP bucket.
 */
async function aggregateEspPerformance(): Promise<{ updated: number; orgs: number }> {
    const logTag = 'ESP-PERF-WORKER';
    logger.info(`[${logTag}] Starting ESP performance aggregation`);

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    // Get all orgs that have send events in the last 30 days
    const orgsWithSends = await prisma.sendEvent.groupBy({
        by: ['organization_id'],
        where: { sent_at: { gte: thirtyDaysAgo } },
    });

    let totalUpdated = 0;

    for (const { organization_id: orgId } of orgsWithSends) {
        try {
            // Aggregate sends per mailbox × ESP
            const sendAgg = await prisma.sendEvent.groupBy({
                by: ['mailbox_id', 'recipient_esp'],
                where: {
                    organization_id: orgId,
                    sent_at: { gte: thirtyDaysAgo },
                    recipient_esp: { not: null },
                },
                _count: true,
            });

            // Aggregate bounces per mailbox × recipient ESP
            // BounceEvent has email_address — we need to classify its ESP
            // Since we may not have recipient_esp on BounceEvent, join via domain insight
            const bounceRows = await prisma.$queryRaw<Array<{
                mailbox_id: string;
                esp_bucket: string;
                bounce_count: bigint;
            }>>`
                SELECT
                    be.mailbox_id,
                    COALESCE(di.esp_bucket, 'other') as esp_bucket,
                    COUNT(*)::bigint as bounce_count
                FROM "BounceEvent" be
                LEFT JOIN "DomainInsight" di
                    ON di.domain = SPLIT_PART(be.email_address, '@', 2)
                    AND di.organization_id = be.organization_id
                WHERE be.organization_id = ${orgId}
                    AND be.created_at >= ${thirtyDaysAgo}
                    AND be.mailbox_id IS NOT NULL
                    AND be.bounce_type = 'hard_bounce'
                GROUP BY be.mailbox_id, di.esp_bucket
            `;

            // Build a lookup map for bounces: mailbox_id:esp → count
            const bounceMap = new Map<string, number>();
            for (const row of bounceRows) {
                bounceMap.set(`${row.mailbox_id}:${row.esp_bucket}`, Number(row.bounce_count));
            }

            // Aggregate replies per mailbox × ESP from ReplyEvent
            const replyAgg = await prisma.replyEvent.groupBy({
                by: ['mailbox_id', 'recipient_esp'],
                where: {
                    organization_id: orgId,
                    replied_at: { gte: thirtyDaysAgo },
                    recipient_esp: { not: null },
                },
                _count: true,
            });
            const replyMap = new Map<string, number>();
            for (const row of replyAgg) {
                if (row.recipient_esp) {
                    replyMap.set(`${row.mailbox_id}:${row.recipient_esp}`, row._count);
                }
            }

            // Upsert MailboxEspPerformance rows
            for (const sendRow of sendAgg) {
                if (!sendRow.recipient_esp) continue;
                const key = `${sendRow.mailbox_id}:${sendRow.recipient_esp}`;
                const sendCount = sendRow._count;
                const bounceCount = bounceMap.get(key) || 0;
                const replyCount = replyMap.get(key) || 0;
                const bounceRate = sendCount > 0 ? bounceCount / sendCount : 0;

                await prisma.mailboxEspPerformance.upsert({
                    where: {
                        mailbox_id_esp_bucket: {
                            mailbox_id: sendRow.mailbox_id,
                            esp_bucket: sendRow.recipient_esp,
                        },
                    },
                    update: {
                        send_count_30d: sendCount,
                        bounce_count_30d: bounceCount,
                        reply_count_30d: replyCount,
                        bounce_rate_30d: bounceRate,
                        last_updated_at: new Date(),
                    },
                    create: {
                        organization_id: orgId,
                        mailbox_id: sendRow.mailbox_id,
                        esp_bucket: sendRow.recipient_esp,
                        send_count_30d: sendCount,
                        bounce_count_30d: bounceCount,
                        reply_count_30d: replyCount,
                        bounce_rate_30d: bounceRate,
                    },
                });
                totalUpdated++;
            }
        } catch (err: any) {
            logger.error(`[${logTag}] Failed to aggregate for org ${orgId}`, err);
        }
    }

    logger.info(`[${logTag}] Aggregation complete`, {
        orgs: orgsWithSends.length,
        cellsUpdated: totalUpdated,
    });

    return { updated: totalUpdated, orgs: orgsWithSends.length };
}

/**
 * Schedule the ESP performance worker to run every 6 hours.
 */
export const scheduleEspPerformanceAggregation = (): NodeJS.Timeout => {
    logger.info('[ESP-PERF-WORKER] Scheduling ESP performance aggregation (every 6 hours)');

    // Run once on startup after a delay (don't block server start)
    setTimeout(() => {
        aggregateEspPerformance().catch(error => {
            logger.error('[ESP-PERF-WORKER] Initial run failed', error);
        });
    }, 30_000); // 30 second delay

    // Then run every 6 hours
    const interval = setInterval(() => {
        aggregateEspPerformance().catch(error => {
            logger.error('[ESP-PERF-WORKER] Scheduled run failed', error);
        });
    }, RUN_INTERVAL_MS);

    return interval;
};

// Export for manual triggering from admin routes
export { aggregateEspPerformance };
