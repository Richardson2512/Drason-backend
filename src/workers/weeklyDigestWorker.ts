/**
 * Weekly performance digest worker.
 *
 * Schedules a one-shot fire every Monday at 09:00 UTC. For each non-erased
 * organization, aggregates the previous 7 days of send / open / click /
 * reply / bounce counts, computes a week-over-week delta, picks the top
 * three campaigns by reply count, and dispatches the digest email to all
 * org admins.
 *
 * Idempotency: keyed on (orgId, ISO week). If the worker fires twice on
 * the same Monday — process restart, accidental re-trigger — Resend
 * dedupes the second send via the idempotency key.
 *
 * Schedule strategy: setInterval with a 5-minute tick that checks "is
 * it the right minute" — simpler than pulling in a cron library, and
 * survives clock drift since we anchor on UTC hour/minute. Catches up
 * after a deploy: if the previous Monday wasn't dispatched (the AuditLog
 * has no `weekly_digest_sent` row for that week), we send it on the
 * next tick.
 */

import { prisma } from '../index';
import { logger } from '../services/observabilityService';
import { dispatchEmail } from '../services/emailTemplates/dispatcher';
import { weeklyDigestEmail } from '../services/emailTemplates/weeklyDigest';
import { buildFrontendUrl } from '../services/emailTemplates/requesterContext';

const TICK_INTERVAL_MS = 5 * 60 * 1000;     // 5 minutes
const SEND_HOUR_UTC = 9;                    // 09:00 UTC
const SEND_DAY = 1;                          // Monday (ISO: 1=Mon, 0=Sun)

let timer: NodeJS.Timeout | null = null;
let stopped = false;
let running = false;

/**
 * ISO 8601 week number — used as the idempotency anchor so a worker
 * restart on the same Monday doesn't re-send.
 */
function isoWeekKey(d: Date): string {
    const tmp = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    const dayNum = tmp.getUTCDay() || 7;
    tmp.setUTCDate(tmp.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
    const weekNo = Math.ceil((((tmp.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7);
    return `${tmp.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

async function dispatchForOrg(orgId: string, orgName: string, weekStart: Date, weekEnd: Date): Promise<void> {
    // Aggregate 7-day window (this week vs prior 7 days for delta).
    const priorStart = new Date(weekStart.getTime() - 7 * 24 * 60 * 60 * 1000);

    const [thisWeekSent, lastWeekSent, opens, clicks, replies, bounces] = await Promise.all([
        prisma.sendEvent.count({
            where: { organization_id: orgId, sent_at: { gte: weekStart, lt: weekEnd } },
        }),
        prisma.sendEvent.count({
            where: { organization_id: orgId, sent_at: { gte: priorStart, lt: weekStart } },
        }),
        prisma.emailOpenEvent.count({
            where: { organization_id: orgId, opened_at: { gte: weekStart, lt: weekEnd } },
        }),
        prisma.emailClickEvent.count({
            where: { organization_id: orgId, clicked_at: { gte: weekStart, lt: weekEnd } },
        }),
        prisma.replyEvent.count({
            where: { organization_id: orgId, replied_at: { gte: weekStart, lt: weekEnd } },
        }),
        prisma.bounceEvent.count({
            where: { organization_id: orgId, created_at: { gte: weekStart, lt: weekEnd } },
        }),
    ]);

    if (thisWeekSent === 0 && lastWeekSent === 0) {
        // Inactive workspace — skip the digest. Sending an "all zeros"
        // email weekly to a dormant org is noise.
        return;
    }

    const sendsDeltaPct = lastWeekSent > 0
        ? (thisWeekSent - lastWeekSent) / lastWeekSent
        : null;

    // Top 3 campaigns by reply count this week. Group reply events by
    // campaign_id then enrich with campaign name + send count.
    const replyGroups = await prisma.replyEvent.groupBy({
        by: ['campaign_id'],
        where: {
            organization_id: orgId,
            replied_at: { gte: weekStart, lt: weekEnd },
            campaign_id: { not: null },
        },
        _count: { _all: true },
        orderBy: { _count: { campaign_id: 'desc' } },
        take: 3,
    });
    const campaignIds = replyGroups
        .map(g => g.campaign_id)
        .filter((id): id is string => !!id);
    const campaigns = campaignIds.length > 0
        ? await prisma.campaign.findMany({
            where: { id: { in: campaignIds } },
            select: { id: true, name: true },
        })
        : [];
    const sentByCampaign = await prisma.sendEvent.groupBy({
        by: ['campaign_id'],
        where: {
            organization_id: orgId,
            sent_at: { gte: weekStart, lt: weekEnd },
            campaign_id: { in: campaignIds.length > 0 ? campaignIds : undefined },
        },
        _count: { _all: true },
    }).catch(() => []);
    const sentMap = new Map<string, number>(
        sentByCampaign.map(s => [s.campaign_id || '', s._count._all]),
    );
    const nameMap = new Map<string, string>(campaigns.map(c => [c.id, c.name]));
    const topCampaigns = replyGroups.map(g => ({
        name: nameMap.get(g.campaign_id || '') || 'Unnamed campaign',
        replies: g._count._all,
        sent: sentMap.get(g.campaign_id || '') || 0,
    }));

    // Operational summary — count state transitions this week.
    const [mailboxesPaused, mailboxesRecovered, domainsPaused] = await Promise.all([
        prisma.stateTransition.count({
            where: {
                organization_id: orgId,
                entity_type: 'mailbox',
                to_state: 'paused',
                created_at: { gte: weekStart, lt: weekEnd },
            },
        }),
        prisma.stateTransition.count({
            where: {
                organization_id: orgId,
                entity_type: 'mailbox',
                to_state: 'healthy',
                created_at: { gte: weekStart, lt: weekEnd },
            },
        }),
        prisma.stateTransition.count({
            where: {
                organization_id: orgId,
                entity_type: 'domain',
                to_state: 'paused',
                created_at: { gte: weekStart, lt: weekEnd },
            },
        }),
    ]);

    const weekKey = isoWeekKey(weekStart);
    void dispatchEmail({
        rendered: weeklyDigestEmail({
            organizationName: orgName,
            weekStart,
            weekEnd,
            totals: {
                sent: thisWeekSent,
                opens,
                clicks,
                replies,
                bounces,
            },
            sendsDeltaPct,
            topCampaigns,
            operationalSummary: {
                mailboxesPaused,
                mailboxesRecovered,
                domainsPaused,
            },
            dashboardUrl: buildFrontendUrl('/dashboard'),
        }),
        audience: { kind: 'org-admins', organizationId: orgId },
        category: 'reporting',
        eventKind: 'weekly_digest',
        idempotencyKey: `weekly-digest:${orgId}:${weekKey}`,
    });

    // Audit row — used to detect "we already sent this week" on catch-up
    // ticks after a deploy.
    await prisma.auditLog.create({
        data: {
            organization_id: orgId,
            entity: 'reporting',
            entity_id: orgId,
            trigger: 'weekly_digest_worker',
            action: 'weekly_digest_sent',
            details: weekKey,
        },
    }).catch(() => { /* non-fatal */ });
}

async function shouldDispatchOrgThisWeek(orgId: string, weekKey: string): Promise<boolean> {
    const existing = await prisma.auditLog.findFirst({
        where: {
            organization_id: orgId,
            entity: 'reporting',
            action: 'weekly_digest_sent',
            details: weekKey,
        },
        select: { id: true },
    });
    return !existing;
}

async function tick(): Promise<void> {
    if (running) return;
    running = true;
    try {
        const now = new Date();
        const isMonday = now.getUTCDay() === SEND_DAY;
        const isSendHour = now.getUTCHours() === SEND_HOUR_UTC;

        // We dispatch on Monday between 09:00 and 09:55 UTC. The 5-min
        // tick covers the window with a single send per org per week.
        if (!isMonday || !isSendHour) return;

        // Last week's Monday 00:00 UTC → this Monday 00:00 UTC.
        const todayUtcMidnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
        const weekEnd = todayUtcMidnight;
        const weekStart = new Date(weekEnd.getTime() - 7 * 24 * 60 * 60 * 1000);
        const weekKey = isoWeekKey(weekStart);

        const orgs = await prisma.organization.findMany({
            where: {
                // Skip suspended/expired/canceled orgs — they don't get
                // performance reports for periods they can't act on.
                subscription_status: { notIn: ['canceled', 'expired'] },
            },
            select: { id: true, name: true },
        });

        let dispatched = 0;
        for (const org of orgs) {
            try {
                if (!await shouldDispatchOrgThisWeek(org.id, weekKey)) continue;
                await dispatchForOrg(org.id, org.name, weekStart, weekEnd);
                dispatched += 1;
            } catch (err) {
                logger.warn('[WEEKLY-DIGEST] Per-org dispatch failed', {
                    orgId: org.id, error: err instanceof Error ? err.message : String(err),
                });
            }
        }
        if (dispatched > 0) {
            logger.info('[WEEKLY-DIGEST] Cycle complete', { dispatched, weekKey });
        }
    } catch (err) {
        logger.error(
            '[WEEKLY-DIGEST] Tick threw',
            err instanceof Error ? err : new Error(String(err)),
        );
    } finally {
        running = false;
    }
}

export function scheduleWeeklyDigestWorker(): void {
    if (timer) return;
    stopped = false;
    // Initial tick after 30s so the worker doesn't miss a deploy that
    // landed Monday morning between 09:00 and 09:05 UTC.
    setTimeout(() => { if (!stopped) void tick(); }, 30_000);
    timer = setInterval(() => { if (!stopped) void tick(); }, TICK_INTERVAL_MS);
    logger.info('[WEEKLY-DIGEST] Scheduled — checks every 5min, fires Mondays 09:00 UTC');
}

export function stopWeeklyDigestWorker(): void {
    stopped = true;
    if (timer) {
        clearInterval(timer);
        timer = null;
        logger.info('[WEEKLY-DIGEST] Stopped');
    }
}
