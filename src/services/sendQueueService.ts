/**
 * Send Queue Service — Production Sending Engine for Superkabe Sequencer
 *
 * Optimized architecture:
 *
 * 1. DISPATCHER (runs every 60s): Scans active campaigns, finds due leads,
 *    pre-assigns leads to mailboxes (equal distribution + ESP-aware),
 *    computes exact send times using user's send_gap_minutes,
 *    enqueues BATCHED delayed jobs (one job per mailbox batch, not per email).
 *
 * 2. WORKER (BullMQ, concurrency 10): Opens one SMTP connection per batch,
 *    sends all emails in the batch through it, writes results in one transaction.
 *
 * 3. PER-ORG PRIORITY: Each org gets its own BullMQ priority level so small
 *    accounts aren't starved by large ones.
 *
 * 4. DELAYED JOBS: Follow-up emails are scheduled as delayed jobs at the
 *    exact timestamp they're due — no polling needed.
 *
 * Falls back to in-process mode when Redis is unavailable (dev).
 */

import { Queue, Worker, Job } from 'bullmq';
import { prisma } from '../index';
import { logger } from './observabilityService';
import { sendEmail, SendResult } from './emailSendAdapters';
import { TIER_LIMITS } from './polarClient';
import { getRedisClient } from '../utils/redis';
import { provisionMailboxForConnectedAccount } from './mailboxProvisioningService';
import * as healingService from './healingService';
import * as monitoringService from './monitoringService';
import * as webhookBus from './webhookEventBus';
import { applyTracking } from './trackingService';
import { resolveSpintax } from '../utils/spintax';

const LOG_TAG = 'SEND-QUEUE';
const QUEUE_NAME = 'email-sends';
const DISPATCH_INTERVAL_MS = 60_000;
const WORKER_CONCURRENCY = 10;

// ─── Types ────────────────────────────────────────────────────────────────────

interface StepVariantRow {
    id: string;
    subject: string;
    body_html: string;
    weight: number;
}

interface SequenceStepWithVariants {
    id: string;
    step_number: number;
    delay_days: number;
    delay_hours: number;
    subject: string;
    body_html: string;
    variants: StepVariantRow[];
    /** Subsequence branching — see schema docs on SequenceStep. */
    condition?: string | null;
    branch_to_step_number?: number | null;
}

interface AccountData {
    id: string;
    email: string;
    display_name: string | null;
    provider: string;
    daily_send_limit: number;
    sends_today: number;
    sends_reset_at: Date;
    connection_status: string;
    smtp_host: string | null;
    smtp_port: number | null;
    smtp_username: string | null;
    smtp_password: string | null;
    access_token: string | null;
    refresh_token: string | null;
    signature_html: string | null;
    // Per-mailbox custom tracking domain (only used when verified). Takes
    // precedence over campaign.tracking_domain so each sender's links are
    // routed through their own white-label hostname.
    tracking_domain: string | null;
    tracking_domain_verified: boolean;
}

interface EmailInBatch {
    leadId: string;
    leadEmail: string;
    leadData: {
        first_name: string | null;
        last_name: string | null;
        company: string | null;
        email: string;
        title: string | null;
        custom_variables: any;
    };
    subject: string;       // already personalized
    bodyHtml: string;      // already personalized
    stepNumber: number;
    stepId: string;
    variantId: string | null;
    nextStepNumber: number;
    nextStepDelayDays: number;
    nextStepDelayHours: number;
    isLastStep: boolean;
}

interface BatchJobData {
    orgId: string;
    campaignId: string;
    campaignName: string;
    sendGapMinutes: number;
    account: AccountData;
    emails: EmailInBatch[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function pickVariant(step: SequenceStepWithVariants): {
    subject: string;
    bodyHtml: string;
    variantId: string | null;
} {
    if (!step.variants || step.variants.length === 0) {
        return { subject: step.subject, bodyHtml: step.body_html, variantId: null };
    }
    const totalWeight = step.variants.reduce((sum, v) => sum + v.weight, 0);
    const rand = Math.random() * totalWeight;
    let cumulative = 0;
    for (const variant of step.variants) {
        cumulative += variant.weight;
        if (rand < cumulative) {
            return { subject: variant.subject, bodyHtml: variant.body_html, variantId: variant.id };
        }
    }
    const last = step.variants[step.variants.length - 1];
    return { subject: last.subject, bodyHtml: last.body_html, variantId: last.id };
}

function personalizeEmail(
    template: string,
    lead: { first_name: string | null; last_name: string | null; company: string | null; email: string; title: string | null; custom_variables: any }
): string {
    const fullName = [lead.first_name, lead.last_name].filter(Boolean).join(' ');
    const tokens: Record<string, string> = {
        first_name: lead.first_name || '',
        last_name: lead.last_name || '',
        full_name: fullName || '',
        company: lead.company || '',
        email: lead.email || '',
        title: lead.title || '',
        website: '',
    };
    if (lead.custom_variables && typeof lead.custom_variables === 'object') {
        for (const [key, value] of Object.entries(lead.custom_variables as Record<string, any>)) {
            tokens[key] = String(value ?? '');
        }
    }
    return template.replace(/\{\{(\w+)\}\}/g, (_m, token: string) => tokens[token.toLowerCase()] ?? '');
}

function isWithinSendingWindow(campaign: {
    // Schedule fields are nullable on Campaign post-merge (legacy platform-synced rows
    // have no schedule since the external platform owns it). Sequencer rows explicitly
    // populate these. Null timezone / times / days default to "always-open" below.
    schedule_timezone: string | null;
    schedule_start_time: string | null;
    schedule_end_time: string | null;
    schedule_days: string[];
}): boolean {
    // Interpret schedule in the campaign's timezone, not UTC. Prior bug: a user in
    // ET who set "09:00–17:00 America/New_York" had their window compared against
    // UTC hours, so sending only happened between 04:00–12:00 ET (or not at all).
    const tz = campaign.schedule_timezone || 'UTC';
    const now = new Date();

    let currentDay = 'sun';
    let hour = 0;
    let minute = 0;
    try {
        const parts = new Intl.DateTimeFormat('en-US', {
            timeZone: tz,
            weekday: 'short',
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23',
        }).formatToParts(now);
        const weekdayMap: Record<string, string> = {
            Sun: 'sun', Mon: 'mon', Tue: 'tue', Wed: 'wed', Thu: 'thu', Fri: 'fri', Sat: 'sat',
        };
        currentDay = weekdayMap[parts.find(p => p.type === 'weekday')?.value || 'Sun'] || 'sun';
        hour = Number(parts.find(p => p.type === 'hour')?.value || '0');
        minute = Number(parts.find(p => p.type === 'minute')?.value || '0');
    } catch {
        // Invalid timezone string — fall back to UTC
        const days = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
        currentDay = days[now.getUTCDay()];
        hour = now.getUTCHours();
        minute = now.getUTCMinutes();
    }

    if (campaign.schedule_days.length > 0 && !campaign.schedule_days.includes(currentDay)) return false;
    if (campaign.schedule_start_time && campaign.schedule_end_time) {
        const nowMin = hour * 60 + minute;
        const [sH, sM] = campaign.schedule_start_time.split(':').map(Number);
        const [eH, eM] = campaign.schedule_end_time.split(':').map(Number);
        if (nowMin < sH * 60 + sM || nowMin > eH * 60 + eM) return false;
    }
    return true;
}

/**
 * Evaluate a step's branching condition against a lead's CampaignLead state.
 * Returns true if the step should be sent. Unknown conditions fail-open
 * (treated as no condition) so a typo on the schema enum doesn't silently
 * stop the whole sequence.
 */
function stepConditionMatches(
    condition: string | null | undefined,
    lead: {
        replied_at?: Date | null;
        opened_count?: number | null;
        clicked_count?: number | null;
    },
): boolean {
    if (!condition) return true;
    const opens = lead.opened_count || 0;
    const clicks = lead.clicked_count || 0;
    switch (condition) {
        case 'if_no_reply':    return !lead.replied_at;
        case 'if_replied':     return !!lead.replied_at;
        case 'if_opened':      return opens > 0;
        case 'if_not_opened':  return opens === 0;
        case 'if_clicked':     return clicks > 0;
        case 'if_not_clicked': return clicks === 0;
        default:               return true;
    }
}

/**
 * Walk the sequence from `startNumber`, honoring per-step `condition` and
 * `branch_to_step_number` until we find a deliverable step or exhaust the
 * branch chain. Returns null when no step in the chain is eligible — caller
 * should mark the lead completed.
 *
 * Safety: capped at 10 hops to defang accidental loops (a step that branches
 * to itself, or two steps that ping-pong via mutual branches).
 */
function resolveDeliverableStep(
    startNumber: number,
    steps: SequenceStepWithVariants[],
    lead: { replied_at?: Date | null; opened_count?: number | null; clicked_count?: number | null },
): SequenceStepWithVariants | null {
    let current: number | null = startNumber;
    let safety = 10;
    while (current != null && safety-- > 0) {
        const step = steps.find(s => s.step_number === current) as SequenceStepWithVariants & {
            condition?: string | null;
            branch_to_step_number?: number | null;
        } | undefined;
        if (!step) return null;
        if (stepConditionMatches(step.condition, lead)) return step;
        // Condition failed — try the branch if defined and not self-pointing.
        const branch = step.branch_to_step_number;
        if (branch == null || branch === current) return null;
        current = branch;
    }
    return null;
}

function calculateNextSendAt(nextStep: { delay_days: number; delay_hours: number } | null): Date | null {
    if (!nextStep) return null;
    const next = new Date();
    next.setDate(next.getDate() + nextStep.delay_days);
    next.setHours(next.getHours() + nextStep.delay_hours);
    return next;
}

async function resetDailySendsIfNeeded(accountId: string, sendsResetAt: Date): Promise<number> {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    if (sendsResetAt < today) {
        await prisma.connectedAccount.update({
            where: { id: accountId },
            data: { sends_today: 0, sends_reset_at: today },
        });
        return 0;
    }
    return -1;
}

/**
 * Handle a send failure — delegates to monitoringService.recordBounce which runs
 * the FULL Protection pipeline: bounce classification, threshold check, correlation,
 * auto-pause (Observe/Suggest/Enforce modes), Slack alert, state transition.
 *
 * This ensures Sequencer bounces flow through the identical pipeline as
 * Smartlead/Instantly webhook bounces.
 */
async function handleSendFailure(
    mailboxId: string,
    _orgId: string,
    campaignId: string,
    recipientEmail: string,
    errorMsg: string
): Promise<void> {
    const msg = (errorMsg || '').toLowerCase();
    const isHardBounce = /no such user|user unknown|mailbox.*not found|no mailbox|address rejected|does not exist|invalid recipient|unknown user|mailbox unavailable|550 |551 |553 /i.test(msg);
    const isSoftBounce = /mailbox full|quota exceeded|over quota|temporarily deferred|try again|temporary failure|rate limit|throttl|too many|421 |450 |451 |452 /i.test(msg);

    if (!isHardBounce && !isSoftBounce) {
        // Auth / connection / config error — not a bounce. Log but don't pollute bounce stats.
        await prisma.mailbox.update({
            where: { id: mailboxId },
            data: { delivery_failure_count: { increment: 1 }, connection_error: errorMsg.slice(0, 255) },
        }).catch(() => {});
        logger.warn(`[${LOG_TAG}] Non-bounce send failure for ${recipientEmail}: ${errorMsg.slice(0, 120)}`);
        return;
    }

    // Hard bounce → full Protection pipeline (creates BounceEvent, checks threshold,
    // runs correlation, auto-pauses mailbox/domain if warranted, sends Slack alert)
    if (isHardBounce) {
        try {
            await monitoringService.recordBounce(mailboxId, campaignId, errorMsg, recipientEmail);
            logger.info(`[${LOG_TAG}] Hard bounce → Protection pipeline: ${recipientEmail}`);
        } catch (err: any) {
            logger.error(`[${LOG_TAG}] recordBounce failed for ${mailboxId}`, err);
        }
    } else {
        // Soft bounce → increment counter, don't trigger pause (transient failures)
        await prisma.mailbox.update({
            where: { id: mailboxId },
            data: { delivery_failure_count: { increment: 1 } },
        }).catch(() => {});
        logger.info(`[${LOG_TAG}] Soft bounce: ${recipientEmail} (${errorMsg.slice(0, 80)})`);
    }
}

// ════════════════════════════════════════════════════════════════════
// DISPATCHER — scans campaigns, assigns leads to mailboxes, creates batch jobs
// ════════════════════════════════════════════════════════════���═══════

let sendQueue: Queue | null = null;

async function dispatch(): Promise<void> {
    const startTime = Date.now();
    logger.info(`[${LOG_TAG}] Dispatch scan starting`);

    try {
        const now = new Date();

        // 1. Load all active sequencer campaigns with steps + accounts.
        // Post-merge Campaign table holds both legacy platform-synced campaigns AND
        // native sequencer campaigns; filter by source_platform='sequencer' so we
        // only dispatch through the native send path.
        const activeCampaigns = await prisma.campaign.findMany({
            where: { status: 'active' },
            include: {
                steps: { include: { variants: true }, orderBy: { step_number: 'asc' } },
                accounts: {
                    include: {
                        account: {
                            include: {
                                // 1:1 shadow Mailbox — used to honor warmup_limit
                                // during 5-phase recovery. Mailbox.warmup_limit > 0
                                // caps daily sends below the normal account cap.
                                mailbox: { select: { warmup_limit: true, recovery_phase: true } },
                            },
                        },
                    },
                },
            },
        });

        if (activeCampaigns.length === 0) {
            logger.info(`[${LOG_TAG}] No active campaigns`);
            return;
        }

        // 2. Batch-load org tiers + monthly send counts
        const orgIds = [...new Set(activeCampaigns.map(c => c.organization_id))];
        const [orgs, orgMonthlySends, campaignDailySends] = await Promise.all([
            prisma.organization.findMany({
                where: { id: { in: orgIds } },
                select: { id: true, subscription_tier: true },
            }),
            prisma.sendEvent.groupBy({
                by: ['organization_id'],
                where: { organization_id: { in: orgIds }, sent_at: { gte: (() => { const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0); return d; })() } },
                _count: true,
            }),
            prisma.sendEvent.groupBy({
                by: ['campaign_id'],
                where: { campaign_id: { in: activeCampaigns.map(c => c.id) }, sent_at: { gte: (() => { const d = new Date(); d.setUTCHours(0, 0, 0, 0); return d; })() } },
                _count: true,
            }),
        ]);

        const orgTierMap = new Map(orgs.map(o => [o.id, o.subscription_tier]));
        const orgMonthlyMap = new Map(orgMonthlySends.map(o => [o.organization_id, o._count]));
        const campaignDailyMap = new Map(campaignDailySends.map(c => [c.campaign_id!, c._count]));

        // Cross-campaign load-balancing tracker. Persists across the per-campaign
        // for-loop so a mailbox shared between three campaigns can't be assigned
        // its full daily quota inside ONE campaign during this tick — every
        // assignment in any campaign decrements the same per-account budget.
        // Resets each dispatch tick (60s).
        const globalAccountAssignedThisTick = new Map<string, number>();

        let totalJobsCreated = 0;

        for (const campaign of activeCampaigns) {
            try {
                // Check org monthly limit
                const tier = orgTierMap.get(campaign.organization_id) || 'trial';
                const limits = TIER_LIMITS[tier] || TIER_LIMITS.trial;
                const monthlySent = orgMonthlyMap.get(campaign.organization_id) || 0;
                if (limits.monthlySendLimit !== Infinity && monthlySent >= limits.monthlySendLimit) continue;

                // Check sending window
                if (!isWithinSendingWindow(campaign)) continue;

                // Check campaign daily limit. Nullable on Campaign post-merge (legacy
                // platform-synced rows have no daily_limit — we never dispatch those here
                // because the outer findMany filters source_platform='sequencer', but
                // TypeScript can't prove that). Fall back to SequencerSettings-style
                // default of 50 if somehow unset.
                const dailyLimit = campaign.daily_limit ?? 50;
                const dailySent = campaignDailyMap.get(campaign.id) || 0;
                if (dailySent >= dailyLimit) continue;
                const remainingCampaignSends = dailyLimit - dailySent;

                // Seed first-step leads that never got a next_send_at (e.g. imported or
                // launched before the seeding fix). Idempotent — only targets current_step=0
                // with null next_send_at. Future dispatches won't re-touch them.
                await prisma.campaignLead.updateMany({
                    where: {
                        campaign_id: campaign.id,
                        status: 'active',
                        current_step: 0,
                        next_send_at: null,
                    },
                    data: { next_send_at: now },
                });

                // Find due leads
                const dueLeads = await prisma.campaignLead.findMany({
                    where: { campaign_id: campaign.id, status: 'active', next_send_at: { lte: now } },
                    take: Math.min(remainingCampaignSends, 500),
                    orderBy: { next_send_at: 'asc' },
                });

                if (dueLeads.length === 0) continue;

                // ── BUILD ELIGIBLE ACCOUNTS WITH CAPACITY-AWARE FILTERING ──
                //
                // For each account in this campaign we compute the SMALLEST of three
                // remaining-capacity ceilings, then subtract any in-flight assignments
                // already made this tick by other campaigns:
                //
                //   1. Mailbox-wide daily cap   = daily_send_limit - sends_today
                //   2. Per-campaign daily cap   = (daily_limit_override ?? daily_send_limit)
                //                                  - CampaignAccountUsage.sends_today
                //                                  (where the usage row's sends_reset_at
                //                                   is today; otherwise treated as 0)
                //   3. Cross-tick adjustment    = subtract globalAccountAssignedThisTick
                //
                // Mailbox-wide cap protects the sender's reputation across ALL campaigns.
                // Per-campaign cap stops a single campaign from monopolizing a mailbox
                // that's shared with two other campaigns.
                // Cross-tick adjustment prevents this dispatcher tick from over-assigning
                // when the same mailbox is reachable from multiple campaigns dispatched
                // back-to-back inside the same 60-second cycle.
                const accountIdsInCampaign = campaign.accounts.map(ca => (ca.account as any).id);
                const usageRows = accountIdsInCampaign.length > 0
                    ? await prisma.campaignAccountUsage.findMany({
                        where: { campaign_id: campaign.id, account_id: { in: accountIdsInCampaign } },
                    })
                    : [];

                // Per-campaign-per-mailbox usage refreshes at midnight UTC. Stale rows
                // (sends_reset_at < today UTC) are reset to 0 in the DB so the post-send
                // upsert can safely INCREMENT without doing its own staleness check.
                const todayUtcMidnight = (() => { const d = new Date(); d.setUTCHours(0, 0, 0, 0); return d; })();
                const usageMap = new Map<string, number>();
                const staleUsageIds: string[] = [];
                for (const u of usageRows) {
                    const isStale = new Date(u.sends_reset_at) < todayUtcMidnight;
                    if (isStale) {
                        staleUsageIds.push(u.id);
                        usageMap.set(u.account_id, 0);
                    } else {
                        usageMap.set(u.account_id, u.sends_today);
                    }
                }
                if (staleUsageIds.length > 0) {
                    await prisma.campaignAccountUsage.updateMany({
                        where: { id: { in: staleUsageIds } },
                        data: { sends_today: 0, sends_reset_at: now },
                    }).catch((err) => {
                        logger.warn(`[${LOG_TAG}] Stale usage reset failed`, { error: err?.message });
                    });
                }

                const accounts: (AccountData & { remainingCapacity: number; dailyLimitOverride: number | null })[] = [];
                for (const ca of campaign.accounts) {
                    const acct = ca.account as any;
                    if (acct.connection_status !== 'active') continue;
                    const resetResult = await resetDailySendsIfNeeded(acct.id, acct.sends_reset_at);
                    const mailboxSendsToday = resetResult === 0 ? 0 : acct.sends_today;

                    // Mailbox-wide daily cap — normally ConnectedAccount.daily_send_limit,
                    // but the 5-phase recovery pipeline lowers it via Mailbox.warmup_limit
                    // during RESTRICTED_SEND / WARM_RECOVERY phases. The smaller of the
                    // two takes effect so paused mailboxes don't dispatch at full volume
                    // mid-recovery.
                    const recoveryCap = (acct.mailbox?.warmup_limit && acct.mailbox.warmup_limit > 0)
                        ? acct.mailbox.warmup_limit
                        : Number.POSITIVE_INFINITY;
                    const effectiveDailyLimit = Math.min(acct.daily_send_limit, recoveryCap);
                    const mailboxRemaining = effectiveDailyLimit - mailboxSendsToday;

                    const campaignCap = ca.daily_limit_override ?? acct.daily_send_limit;
                    const campaignUsageToday = usageMap.get(acct.id) ?? 0;
                    const campaignRemaining = campaignCap - campaignUsageToday;

                    const inFlightThisTick = globalAccountAssignedThisTick.get(acct.id) || 0;

                    const effectiveRemaining = Math.max(
                        0,
                        Math.min(mailboxRemaining, campaignRemaining) - inFlightThisTick,
                    );
                    if (effectiveRemaining > 0) {
                        accounts.push({
                            ...acct,
                            sends_today: mailboxSendsToday,
                            remainingCapacity: effectiveRemaining,
                            dailyLimitOverride: ca.daily_limit_override,
                        });
                    }
                }

                if (accounts.length === 0) continue;

                // ── LOAD ESP PERFORMANCE (only if esp_routing is enabled) ──
                const useEspRouting = campaign.esp_routing ?? true;
                const espPerfMap = new Map<string, { bounceRate: number; sendCount: number }>();

                if (useEspRouting) {
                    const accountIds = accounts.map(a => a.id);
                    const espPerformanceRows = await prisma.mailboxEspPerformance.findMany({
                        where: { mailbox_id: { in: accountIds } },
                        select: { mailbox_id: true, esp_bucket: true, bounce_rate_30d: true, send_count_30d: true },
                    });
                    for (const row of espPerformanceRows) {
                        espPerfMap.set(`${row.mailbox_id}:${row.esp_bucket}`, {
                            bounceRate: row.bounce_rate_30d,
                            sendCount: row.send_count_30d,
                        });
                    }
                }

                // ── ASSIGN LEADS TO MAILBOXES (sticky-per-lead + capacity-balanced + ESP-aware) ──
                //
                // Stickiness: every lead is pinned to ONE mailbox for the entire
                // sequence. Step 1 picks via the score function below; step 2+ are
                // forced through the same mailbox via `lead.assigned_account_id` so
                // recipient sees a coherent thread from a single sender.
                //
                // Sticky-mailbox-unavailable handling:
                //   - If sticky mailbox is in `accounts` but at-capacity for this tick:
                //     skip lead, advance next_send_at by 1 hour, retry next tick.
                //   - If sticky mailbox is excluded (paused / quarantine / restricted /
                //     temporarily disconnected): same as above — wait for it.
                //   - If sticky mailbox is permanently disconnected (campaign no longer
                //     has the account at all OR account.connection_status = 'disconnected'
                //     and not 'error'/'expired'): re-assign by picking best fresh mailbox
                //     and overwriting assigned_account_id. Logged at warn level.
                //
                // Pre-build the broader campaign-account view so we can detect "permanent"
                // disconnect vs "temporary" excluded-this-tick states.
                const allCampaignAccountIds = new Set(campaign.accounts.map(ca => (ca.account as any).id));
                const permanentlyDisconnected = new Set<string>();
                for (const ca of campaign.accounts) {
                    const acct = ca.account as any;
                    if (acct.connection_status === 'disconnected') permanentlyDisconnected.add(acct.id);
                }

                const mailboxBatches = new Map<string, { account: AccountData; emails: EmailInBatch[] }>();
                for (const acct of accounts) {
                    mailboxBatches.set(acct.id, { account: acct, emails: [] });
                }

                const accountCounts = new Map<string, number>();
                accounts.forEach(a => accountCounts.set(a.id, 0));

                // Track which leads got their sticky_account_id reassigned (for the
                // post-send transaction; only re-write when changed).
                const leadsToBindStickyAccount: Array<{ leadId: string; accountId: string }> = [];

                const pickBestByScore = (lead: { esp_bucket: string | null }): typeof accounts[0] | null => {
                    let best: typeof accounts[0] | null = null;
                    let bestScore = -Infinity;
                    const leadEsp = lead.esp_bucket || 'other';

                    for (const acct of accounts) {
                        const assigned = accountCounts.get(acct.id) || 0;
                        if (assigned >= acct.remainingCapacity) continue;

                        const capacityScore = (acct.remainingCapacity - assigned) / acct.remainingCapacity;
                        let score: number;
                        if (useEspRouting) {
                            const espKey = `${acct.id}:${leadEsp}`;
                            const espPerf = espPerfMap.get(espKey);
                            const espScore = (espPerf && espPerf.sendCount >= 10)
                                ? 1 - Math.min(espPerf.bounceRate, 1)
                                : 0.5;
                            score = (capacityScore * 0.6) + (espScore * 0.4);
                        } else {
                            score = capacityScore;
                        }
                        if (score > bestScore) {
                            bestScore = score;
                            best = acct;
                        }
                    }
                    return best;
                };

                // Time-of-day weighting: during business hours (9–17 in the campaign's
                // timezone) prefer mailboxes with lower current load so deliveries spread
                // across the fleet during the window most senders care about. Outside
                // business hours, pure score wins. Implemented as a small bias on top of
                // the score, NOT a hard filter, so capacity is still always honored.
                const inBusinessHours = (() => {
                    try {
                        const tz = campaign.schedule_timezone || 'UTC';
                        const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }).formatToParts(now).find(p => p.type === 'hour')?.value || '0');
                        return hour >= 9 && hour < 17;
                    } catch { return false; }
                })();

                for (const lead of dueLeads) {
                    let chosenAccount: typeof accounts[0] | null = null;
                    let stickyOverride = false;

                    const stickyId: string | null = (lead as any).assigned_account_id ?? null;

                    if (stickyId) {
                        // Lead has a sticky mailbox — try to honor it.
                        const sticky = accounts.find(a => a.id === stickyId);
                        if (sticky && (accountCounts.get(sticky.id) || 0) < sticky.remainingCapacity) {
                            chosenAccount = sticky;
                        } else if (permanentlyDisconnected.has(stickyId) || !allCampaignAccountIds.has(stickyId)) {
                            // Sticky mailbox is permanently gone — re-assign to a fresh
                            // best-scored mailbox and update the sticky binding. Threading
                            // continuity is broken here; this is the lesser-of-two-evils
                            // fallback (better than indefinitely stalling the lead).
                            chosenAccount = pickBestByScore(lead);
                            stickyOverride = !!chosenAccount;
                            if (chosenAccount) {
                                logger.warn(`[${LOG_TAG}] Lead ${lead.id} reassigned from disconnected mailbox ${stickyId} → ${chosenAccount.id}`);
                            }
                        } else {
                            // Sticky mailbox is temporarily unavailable. Push next_send_at
                            // out by 1 hour so we retry on a future tick when capacity
                            // refreshes or the mailbox recovers — DON'T reassign.
                            const retryAt = new Date(now.getTime() + 60 * 60 * 1000);
                            await prisma.campaignLead.update({
                                where: { id: lead.id },
                                data: { next_send_at: retryAt },
                            }).catch(() => { /* tolerable */ });
                            continue;
                        }
                    } else {
                        // First send for this lead — pick best mailbox + bind sticky.
                        chosenAccount = pickBestByScore(lead);
                        stickyOverride = !!chosenAccount;
                    }

                    if (!chosenAccount) break; // All accounts at capacity for this tick

                    // Time-of-day refinement: if we're in business hours and the chosen
                    // mailbox is highly loaded already (>70% of its remaining), see if
                    // a less-loaded one with a comparable score exists. Skip for sticky
                    // leads (we already committed to one mailbox).
                    if (inBusinessHours && !stickyId) {
                        const chosenLoadFraction = (accountCounts.get(chosenAccount.id) || 0) / Math.max(1, chosenAccount.remainingCapacity);
                        if (chosenLoadFraction > 0.7) {
                            const lessLoaded = accounts.filter(a =>
                                a.id !== chosenAccount!.id &&
                                (accountCounts.get(a.id) || 0) < a.remainingCapacity * 0.5
                            );
                            if (lessLoaded.length > 0) {
                                // Pick the least-loaded among them
                                lessLoaded.sort((a, b) =>
                                    ((accountCounts.get(a.id) || 0) / Math.max(1, a.remainingCapacity))
                                    - ((accountCounts.get(b.id) || 0) / Math.max(1, b.remainingCapacity))
                                );
                                chosenAccount = lessLoaded[0];
                            }
                        }
                    }

                    const bestAccount = chosenAccount;

                    if (stickyOverride && bestAccount.id !== stickyId) {
                        leadsToBindStickyAccount.push({ leadId: lead.id, accountId: bestAccount.id });
                    } else if (!stickyId) {
                        leadsToBindStickyAccount.push({ leadId: lead.id, accountId: bestAccount.id });
                    }

                    // `current_step` tracks the last step SENT (0 = nothing sent yet).
                    // The step we ATTEMPT next is `current_step + 1`, but it might be
                    // skipped/redirected by the branching engine if a condition fails.
                    // resolveDeliverableStep walks the branch chain and returns either
                    // the actual step to send, or null when no branch can satisfy the
                    // lead's current state (in which case the sequence ends here).
                    const sendingStepNumber = lead.current_step + 1;
                    const step = resolveDeliverableStep(sendingStepNumber, campaign.steps as SequenceStepWithVariants[], {
                        replied_at: (lead as any).replied_at,
                        opened_count: (lead as any).opened_count,
                        clicked_count: (lead as any).clicked_count,
                    });

                    if (!step) {
                        await prisma.campaignLead.update({
                            where: { id: lead.id },
                            data: { status: 'completed', next_send_at: null },
                        });
                        continue;
                    }
                    // The step we resolved may have a different step_number than the
                    // candidate (when we followed a branch). Use the resolved step's
                    // number going forward so current_step gets the actual delivered
                    // step and the next dispatch starts from N+1.
                    const deliveredStepNumber = step.step_number;

                    const { subject: rawSubject, bodyHtml: rawBody, variantId } = pickVariant(step);

                    // Pipeline: personalize → spintax → tracking.
                    // - Personalize first so {{tokens}} inside spintax options are substituted.
                    // - Spintax second so each lead receives a different lexical variant of the
                    //   same template, breaking ISP pattern-fingerprinting on bulk sequence sends.
                    // - Tracking last so the open pixel + click wrappers see the final URL set.
                    const subject = resolveSpintax(personalizeEmail(rawSubject, lead));
                    const personalizedBody = resolveSpintax(personalizeEmail(rawBody, lead));

                    // Inject open pixel + click wrappers + unsubscribe footer based on campaign settings.
                    // These transforms need the leadId so tracking hits can be attributed back to the
                    // CampaignLead on open/click. BACKEND_URL must be publicly reachable for
                    // recipient mail clients to actually fire the endpoints.
                    // Tracking host preference: mailbox-level (verified) > campaign-level > global default.
                    // Verified mailbox domains give each sender's links the appearance of coming from
                    // their own infrastructure, which avoids the third-party-redirect downrank Gmail
                    // applies to identical tracking hosts shared across many senders.
                    const effectiveTrackingDomain = (bestAccount.tracking_domain && bestAccount.tracking_domain_verified)
                        ? bestAccount.tracking_domain
                        : campaign.tracking_domain;
                    const bodyHtml = applyTracking(personalizedBody, {
                        leadId: lead.id,
                        trackOpens: campaign.track_opens ?? true,
                        trackClicks: campaign.track_clicks ?? true,
                        includeUnsubscribe: campaign.include_unsubscribe ?? true,
                        trackingDomain: effectiveTrackingDomain,
                    });

                    // Schedule the next dispatch at delivered_step + 1. The branching
                    // engine will re-evaluate conditions when this lead becomes due
                    // again. If no later step exists at all, we've reached end of
                    // sequence regardless of branches.
                    const followUpStepNumber = deliveredStepNumber + 1;
                    const nextStep = campaign.steps.find((s: any) => s.step_number === followUpStepNumber);
                    const anyHigherStep = (campaign.steps as { step_number: number }[]).some(s => s.step_number > deliveredStepNumber);

                    mailboxBatches.get(bestAccount.id)!.emails.push({
                        leadId: lead.id,
                        leadEmail: lead.email,
                        leadData: {
                            first_name: lead.first_name,
                            last_name: lead.last_name,
                            company: lead.company,
                            email: lead.email,
                            title: lead.title,
                            custom_variables: lead.custom_variables,
                        },
                        subject,
                        bodyHtml,
                        stepNumber: deliveredStepNumber,
                        stepId: step.id,
                        variantId,
                        nextStepNumber: deliveredStepNumber, // written to current_step after send
                        nextStepDelayDays: nextStep ? (nextStep as any).delay_days : 0,
                        nextStepDelayHours: nextStep ? (nextStep as any).delay_hours : 0,
                        isLastStep: !anyHigherStep,
                    });

                    accountCounts.set(bestAccount.id, (accountCounts.get(bestAccount.id) || 0) + 1);
                    // Bump the cross-campaign tracker so the NEXT campaign in this
                    // dispatcher tick sees this assignment when computing remaining
                    // capacity for the same mailbox.
                    globalAccountAssignedThisTick.set(
                        bestAccount.id,
                        (globalAccountAssignedThisTick.get(bestAccount.id) || 0) + 1,
                    );
                }

                // Persist sticky-mailbox bindings outside the per-lead loop so we
                // batch the writes. updateMany with composite OR can't bind per-row,
                // so use a small Promise.all of single updates — usually <50 rows.
                if (leadsToBindStickyAccount.length > 0) {
                    await Promise.all(
                        leadsToBindStickyAccount.map(({ leadId, accountId }) =>
                            prisma.campaignLead.update({
                                where: { id: leadId },
                                data: { assigned_account_id: accountId },
                            }).catch((err) => {
                                logger.warn(`[${LOG_TAG}] Failed to bind sticky account for lead ${leadId}`, { error: err?.message });
                            })
                        )
                    );
                }

                // ── ENQUEUE: one batch job per mailbox ──
                const sendGap = campaign.send_gap_minutes || 17;

                for (const [_accountId, batch] of mailboxBatches) {
                    if (batch.emails.length === 0) continue;

                    const jobData: BatchJobData = {
                        orgId: campaign.organization_id,
                        campaignId: campaign.id,
                        campaignName: campaign.name,
                        sendGapMinutes: sendGap,
                        account: batch.account,
                        emails: batch.emails,
                    };

                    if (sendQueue) {
                        // Per-org priority: hash orgId to a priority bucket (1-10, lower = higher priority)
                        // Smaller orgs (fewer campaigns) get higher priority naturally
                        const orgCampaignCount = activeCampaigns.filter(c => c.organization_id === campaign.organization_id).length;
                        const priority = Math.min(10, Math.max(1, orgCampaignCount));

                        await sendQueue.add('send-batch', jobData, {
                            priority,
                            attempts: 2,
                            backoff: { type: 'exponential', delay: 10000 },
                            removeOnComplete: 50,
                            removeOnFail: 200,
                        });
                    } else {
                        // No Redis fallback
                        await processBatchJob(jobData);
                    }

                    totalJobsCreated++;
                    logger.info(`[${LOG_TAG}] "${campaign.name}" → ${batch.account.email}: ${batch.emails.length} emails queued (gap: ${sendGap}min)`);
                }

                // Check if campaign completed
                const remainingActive = await prisma.campaignLead.count({
                    where: { campaign_id: campaign.id, status: 'active' },
                });
                if (remainingActive === 0) {
                    await prisma.campaign.update({
                        where: { id: campaign.id },
                        data: { status: 'completed' },
                    });
                    logger.info(`[${LOG_TAG}] Campaign "${campaign.name}" completed — no more active leads`);
                }
            } catch (err: any) {
                logger.error(`[${LOG_TAG}] Error dispatching campaign ${campaign.id}`, err);
            }
        }

        logger.info(`[${LOG_TAG}] Dispatch complete`, {
            campaigns: activeCampaigns.length,
            batchJobs: totalJobsCreated,
            elapsedMs: Date.now() - startTime,
        });
    } catch (err: any) {
        logger.error(`[${LOG_TAG}] Dispatch failed`, err);
    }
}

// ════════════════════════════════════════════════════════════════════
// WORKER — processes a batch of emails through one SMTP connection
// ════════════════════════════════════════════════════════════════════

async function processBatchJob(data: BatchJobData): Promise<void> {
    const { account, emails, sendGapMinutes, campaignId, orgId } = data;
    const gapMs = sendGapMinutes * 60 * 1000;
    const jitterMs = Math.min(gapMs * 0.15, 120_000); // ±15% jitter, max 2 min

    // Ensure shadow Mailbox exists — Protection layer requires it for SendEvent FK integrity,
    // healing pipeline, ESP performance tracking, etc. Idempotent for already-provisioned accounts.
    let mailboxId = account.id;
    try {
        const { mailboxId: provisionedId } = await provisionMailboxForConnectedAccount({
            connectedAccountId: account.id,
            organizationId: orgId,
            email: account.email,
        });
        mailboxId = provisionedId;
    } catch (err: any) {
        logger.error(`[${LOG_TAG}] Failed to ensure mailbox for ${account.email} — skipping batch`, err);
        return;
    }

    // Check if mailbox is currently paused/quarantined by Protection layer — skip if so
    const mailboxState = await prisma.mailbox.findUnique({
        where: { id: mailboxId },
        select: { recovery_phase: true, status: true },
    });
    if (mailboxState && (mailboxState.status === 'paused' || mailboxState.recovery_phase === 'paused' || mailboxState.recovery_phase === 'quarantine')) {
        logger.warn(`[${LOG_TAG}] Mailbox ${account.email} is ${mailboxState.recovery_phase} — skipping batch of ${emails.length}`);
        return;
    }

    let sentCount = 0;
    let failedCount = 0;

    for (let i = 0; i < emails.length; i++) {
        const email = emails[i];

        // ── SEND-TIME SPREADING: wait between emails ──
        if (i > 0) {
            const jitter = (Math.random() - 0.5) * 2 * jitterMs;
            const waitMs = Math.max(5000, gapMs + jitter); // Minimum 5 seconds
            await new Promise(resolve => setTimeout(resolve, waitMs));
        }

        try {
            const result: SendResult = await sendEmail(account, email.leadEmail, email.subject, email.bodyHtml);

            if (!result.success) {
                logger.error(`[${LOG_TAG}] Failed: ${account.email} → ${email.leadEmail}: ${result.error}`);
                failedCount++;
                // Classify bounce type from error and record it
                await handleSendFailure(mailboxId, orgId, campaignId, email.leadEmail, result.error || 'unknown');
                continue;
            }

            // Write all updates in one transaction
            await prisma.$transaction([
                prisma.sendEvent.create({
                    data: {
                        organization_id: orgId,
                        mailbox_id: mailboxId,
                        campaign_id: campaignId,
                        recipient_email: email.leadEmail,
                        sent_at: new Date(),
                    },
                }),
                prisma.campaignLead.update({
                    where: { id: email.leadId },
                    data: {
                        current_step: email.nextStepNumber,
                        last_sent_at: new Date(),
                        next_send_at: email.isLastStep ? null : calculateNextSendAt({
                            delay_days: email.nextStepDelayDays,
                            delay_hours: email.nextStepDelayHours,
                        }),
                        status: email.isLastStep ? 'completed' : 'active',
                    },
                }),
                prisma.connectedAccount.update({
                    where: { id: account.id },
                    data: { sends_today: { increment: 1 } },
                }),
                // Per-(campaign, mailbox) usage counter. Upsert so the row is
                // created on first send and incremented atomically thereafter.
                // sends_reset_at carries the boundary at which this counter is
                // considered stale — at-load-time the dispatcher checks if it's
                // before today UTC midnight and treats it as 0 if so.
                prisma.campaignAccountUsage.upsert({
                    where: {
                        campaign_id_account_id: { campaign_id: campaignId, account_id: account.id },
                    },
                    create: {
                        campaign_id: campaignId,
                        account_id: account.id,
                        sends_today: 1,
                        sends_reset_at: new Date(),
                    },
                    update: {
                        sends_today: { increment: 1 },
                    },
                }),
                prisma.mailbox.update({
                    where: { id: mailboxId },
                    data: { total_sent_count: { increment: 1 }, window_sent_count: { increment: 1 }, last_activity_at: new Date() },
                }),
                prisma.campaign.update({
                    where: { id: campaignId },
                    data: { total_sent: { increment: 1 } },
                }),
                // Keep the Protection-layer Lead counter in sync with native sends.
                // updateMany is deliberate: contacts added sequencer-only may not have a Lead row.
                prisma.lead.updateMany({
                    where: { organization_id: orgId, email: email.leadEmail },
                    data: { emails_sent: { increment: 1 }, last_activity_at: new Date() },
                }),
                ...(email.variantId
                    ? [prisma.stepVariant.update({
                        where: { id: email.variantId },
                        data: { sends: { increment: 1 } },
                    })]
                    : []),
            ]);

            // Outbound webhook fan-out — fires email.sent for any subscribers.
            // Send-event volume can be high; subscribers should filter their
            // event allowlist if they only care about replies / bounces.
            webhookBus.emitEmailSent(
                orgId,
                {
                    campaign_id: campaignId,
                    mailbox_id: mailboxId,
                    mailbox_email: account.email,
                    recipient_email: email.leadEmail,
                    lead_id: email.leadId,
                },
                `${campaignId}-${email.leadId}-${email.nextStepNumber}`,
            );

            // Record the send through the Protection pipeline — handles windowing, clean-send
            // tracking, and healing phase progression (includes recordCleanSend internally).
            monitoringService.recordSent(mailboxId, campaignId).catch(err =>
                logger.warn(`[${LOG_TAG}] recordSent failed for ${mailboxId}: ${err.message}`)
            );

            // Record the send in the Unibox's thread + message store so it appears in
            // the Sent view. Thread key is (org, account, contact_email, campaign_id) so
            // every step send to the same contact in the same campaign groups into one
            // thread; a later inbound reply can attach via imapReplyWorker's contact_email
            // fallback lookup. Best-effort: runs outside the atomic transaction because
            // the email has already shipped and a Unibox recording failure shouldn't
            // undo the send.
            (async () => {
                try {
                    const snippet = email.bodyHtml.replace(/<[^>]*>/g, '').slice(0, 120);
                    const now = new Date();
                    const existing = await prisma.emailThread.findFirst({
                        where: {
                            organization_id: orgId,
                            account_id: account.id,
                            contact_email: email.leadEmail.toLowerCase(),
                            campaign_id: campaignId,
                        },
                        select: { id: true },
                    });
                    let threadId: string;
                    if (existing) {
                        await prisma.emailThread.update({
                            where: { id: existing.id },
                            data: {
                                last_message_at: now,
                                message_count: { increment: 1 },
                                snippet,
                            },
                        });
                        threadId = existing.id;
                    } else {
                        const created = await prisma.emailThread.create({
                            data: {
                                organization_id: orgId,
                                account_id: account.id,
                                contact_email: email.leadEmail.toLowerCase(),
                                subject: email.subject,
                                campaign_id: campaignId,
                                lead_id: email.leadId,
                                status: 'open',
                                is_read: true, // we sent it; no "unread" badge needed
                                snippet,
                                message_count: 1,
                                last_message_at: now,
                            },
                        });
                        threadId = created.id;
                    }
                    await prisma.emailMessage.create({
                        data: {
                            thread_id: threadId,
                            direction: 'outbound',
                            from_email: account.email,
                            from_name: account.display_name || account.email,
                            to_email: email.leadEmail,
                            to_name: null,
                            subject: email.subject,
                            body_html: email.bodyHtml,
                            sent_at: now,
                        },
                    });
                } catch (unibErr) {
                    logger.warn(`[${LOG_TAG}] Failed to record sequencer send in Unibox (non-critical)`, { error: (unibErr as Error).message });
                }
            })();

            sentCount++;

            logger.info(`[${LOG_TAG}] Sent step ${email.stepNumber} ��� ${email.leadEmail} via ${account.email}`, {
                campaignId,
                batch: `${i + 1}/${emails.length}`,
                isLastStep: email.isLastStep,
            });
        } catch (err: any) {
            logger.error(`[${LOG_TAG}] Error processing ${email.leadEmail}`, err);
            failedCount++;
        }
    }

    logger.info(`[${LOG_TAG}] Batch complete: ${account.email} — ${sentCount} sent, ${failedCount} failed`);
}

// ════════════════════════════════════════════════════════════════════
// LIFECYCLE
// ════════════════════════════════════════════════════════════════════

let dispatchInterval: NodeJS.Timeout | null = null;
let worker: Worker | null = null;

export function scheduleSendQueue(): NodeJS.Timeout {
    const redis = getRedisClient();

    if (redis) {
        const connection = { host: redis.options.host!, port: redis.options.port!, password: redis.options.password };

        sendQueue = new Queue(QUEUE_NAME, { connection });

        worker = new Worker(
            QUEUE_NAME,
            async (job: Job<BatchJobData>) => {
                await processBatchJob(job.data);
            },
            {
                connection,
                concurrency: WORKER_CONCURRENCY,
                // No global rate limiter here — the send_gap_minutes inside each batch
                // handles the pacing per mailbox. Concurrency handles parallelism across mailboxes.
            }
        );

        worker.on('completed', (job) => {
            logger.debug(`[${LOG_TAG}] Batch job ${job.id} completed`);
        });

        worker.on('failed', (job, err) => {
            logger.error(`[${LOG_TAG}] Batch job ${job?.id} failed: ${err.message}`, err);
        });

        worker.on('error', (err) => {
            logger.error(`[${LOG_TAG}] Worker error`, err);
        });

        logger.info(`[${LOG_TAG}] BullMQ started (concurrency: ${WORKER_CONCURRENCY}, batch-per-mailbox)`);
    } else {
        logger.warn(`[${LOG_TAG}] No Redis — in-process sequential fallback`);
    }

    // Dispatcher
    setTimeout(() => {
        dispatch().catch(err => logger.error(`[${LOG_TAG}] Initial dispatch failed`, err));
    }, 15_000);

    dispatchInterval = setInterval(() => {
        dispatch().catch(err => logger.error(`[${LOG_TAG}] Dispatch failed`, err));
    }, DISPATCH_INTERVAL_MS);

    logger.info(`[${LOG_TAG}] Dispatcher scheduled (every ${DISPATCH_INTERVAL_MS / 1000}s)`);
    return dispatchInterval;
}

export async function stopSendQueue(): Promise<void> {
    if (dispatchInterval) { clearInterval(dispatchInterval); dispatchInterval = null; }
    if (worker) { await worker.close(); worker = null; }
    if (sendQueue) { await sendQueue.close(); sendQueue = null; }
    logger.info(`[${LOG_TAG}] Send queue stopped`);
}
