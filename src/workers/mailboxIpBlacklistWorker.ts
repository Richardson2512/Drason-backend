/**
 * Mailbox Sending-IP Blacklist Worker
 *
 * Periodically checks every mailbox's resolved sending IP against the same
 * DNSBL lists the domain assessor uses. Stores summary on Mailbox so the
 * UI can show "this mailbox's IP is listed on N critical blacklists."
 *
 * Cadence: every 6 hours (matches espPerformanceWorker - same workload
 * shape, both heavy + non-urgent).
 *
 * Skip rules:
 *   - sending_ip null OR sending_ip_source='oauth_shared' → skip (Gmail/MS
 *     shared infra; not actionable)
 *   - last_ip_blacklist_check within last 5h → skip (cadence guard so two
 *     boots in a row don't burn lookups)
 *
 * DNSBL coverage is comprehensive at every tier - protection is a flat
 * capability, not a metered one.
 */

import { prisma } from '../index';
import { logger } from '../services/observabilityService';
import * as dnsbl from '../services/dnsblService';

const LOG_TAG = 'MAILBOX_IP_BL';
const RUN_INTERVAL_MS = 6 * 60 * 60 * 1000;     // 6 hours
const MIN_GAP_BETWEEN_CHECKS_MS = 5 * 60 * 60 * 1000; // 5h - guards against double-runs

let interval: NodeJS.Timeout | null = null;

export function scheduleMailboxIpBlacklist(): NodeJS.Timeout {
    // Run shortly after boot so a fresh deploy gets coverage, then on cadence.
    setTimeout(() => runOnce().catch(err => logger.error(`[${LOG_TAG}] initial run failed`, err)), 90_000);
    interval = setInterval(() => {
        runOnce().catch(err => logger.error(`[${LOG_TAG}] scheduled run failed`, err));
    }, RUN_INTERVAL_MS);
    logger.info(`[${LOG_TAG}] Scheduled (every ${RUN_INTERVAL_MS / 3600_000}h)`);
    return interval;
}

export function stopMailboxIpBlacklist(): void {
    if (interval) clearInterval(interval);
    interval = null;
}

/**
 * One full pass - pulls eligible mailboxes per-org, runs DNSBL checks, writes
 * results back. Exposed publicly so an admin endpoint or a test can trigger
 * an immediate run without waiting for the timer.
 */
export async function runOnce(): Promise<{ checked: number; listed: number; skipped: number }> {
    logger.info(`[${LOG_TAG}] Starting cycle`);
    const cutoff = new Date(Date.now() - MIN_GAP_BETWEEN_CHECKS_MS);

    const orgs = await prisma.organization.findMany({ select: { id: true } });

    // Comprehensive list set used for every org. Fetched once per cycle so
    // a 1000-mailbox sweep doesn't burn 1000 redundant DB reads.
    const lists = await dnsbl.getListsForRun('comprehensive');

    let totalChecked = 0;
    let totalListed = 0;
    let totalSkipped = 0;

    for (const org of orgs) {

        const mailboxes = await prisma.mailbox.findMany({
            where: {
                organization_id: org.id,
                sending_ip: { not: null },
                NOT: { sending_ip_source: 'oauth_shared' },
                OR: [
                    { last_ip_blacklist_check: null },
                    { last_ip_blacklist_check: { lt: cutoff } },
                ],
            },
            select: { id: true, email: true, sending_ip: true, status: true },
            take: 500, // safety bound per org per cycle
        });

        if (mailboxes.length === 0) continue;

        logger.info(`[${LOG_TAG}] org=${org.id} processing ${mailboxes.length} mailboxes (${lists.length} lists)`);

        // Sequential per org. The semaphore inside dnsblService caps parallel
        // DNS queries already; running mailboxes in parallel here would just
        // bunch up at that semaphore.
        for (const mb of mailboxes) {
            if (!mb.sending_ip) { totalSkipped++; continue; }

            try {
                const result = await dnsbl.checkIpBlacklists(mb.sending_ip, mb.id, lists);

                // Reshape summary into the columns we store on Mailbox. The
                // dnsblService summary already aggregates by tier - we keep
                // the same shape for parity with Domain.blacklist_results so
                // a single UI component can render either.
                const summary = result.summary as Record<string, any>;
                const ipBlacklistResults = {
                    critical_listed: summary.critical_listed || 0,
                    critical_checked: summary.critical_checked || 0,
                    major_listed: summary.major_listed || 0,
                    major_checked: summary.major_checked || 0,
                    minor_listed: summary.minor_listed || 0,
                    minor_checked: summary.minor_checked || 0,
                    total_checked: summary.total_checked || 0,
                };

                // ── Door B infrastructure gate ─────────────────────────────
                // A confirmed blocking sending-IP listing makes this mailbox NOT
                // sendable via infra_status - a dedicated advisory flag that is
                // SEPARATE from status/recovery_phase (the healing pipeline).
                // IP-blacklist blocks are deliberately NO LONGER routed through
                // pauseMailbox/correlation: an unauthenticated infrastructure
                // problem is not a "burned by sending" event, and forcing it into
                // healing trapped never-sent mailboxes (no clean sends to
                // graduate on -> permanent quarantine). Writing 'ready' when the
                // IP is clean means this same 6h sweep auto-clears the flag once
                // the IP is delisted - no manual step, no deadlock. This worker is
                // the sole writer of Mailbox.infra_status (domain-level listings
                // live on Domain.infra_status), so clearing here is safe.
                const policy = dnsbl.isBlockingBlacklisted(result.results, lists);
                const ipBlocked = policy.shouldPause;

                await prisma.mailbox.update({
                    where: { id: mb.id },
                    data: {
                        ip_blacklist_results: ipBlacklistResults as any,
                        ip_blacklist_score: result.penalty,
                        last_ip_blacklist_check: new Date(),
                        infra_status: ipBlocked ? 'action_required' : 'ready',
                        infra_reason: ipBlocked
                            ? `Sending IP on blocking blacklist: ${policy.reason}. Delist the IP, then re-check to resume sending.`
                            : null,
                    },
                });

                totalChecked++;
                if (ipBlacklistResults.critical_listed > 0 || ipBlacklistResults.major_listed > 0) {
                    totalListed++;
                }
            } catch (err) {
                logger.warn(`[${LOG_TAG}] mailbox ${mb.id} check failed`, { error: (err as Error)?.message });
            }
        }
    }

    logger.info(`[${LOG_TAG}] Cycle complete: ${totalChecked} checked, ${totalListed} listed, ${totalSkipped} skipped`);
    return { checked: totalChecked, listed: totalListed, skipped: totalSkipped };
}
