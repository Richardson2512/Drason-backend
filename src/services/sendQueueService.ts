/**
 * Send Queue Service - Production Sending Engine for Superkabe Sequencer
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
 *    exact timestamp they're due - no polling needed.
 *
 * Falls back to in-process mode when Redis is unavailable (dev).
 */

import { Queue, Worker, Job } from 'bullmq';
import { prisma } from '../prisma';
import { logger, maskEmail } from './observabilityService';
import { sendEmail, SendResult } from './emailSendAdapters';
import { buildUnsubscribeUrl } from './trackingService';
import { TIER_LIMITS } from './polarClient';
import { getRedisClient, acquireLock, releaseLock } from '../utils/redis';
import { provisionMailboxForConnectedAccount } from './mailboxProvisioningService';
import * as healingService from './healingService';
import * as bounceProcessingService from './bounceProcessingService';
import * as executionGateService from './executionGateService';
import * as campaignHealthService from './campaignHealthService';
import { updateDomainLastSent } from './inactivityService';
import * as auditLogService from './auditLogService';
import { SlackAlertService } from './SlackAlertService';
import * as webhookBus from './webhookEventBus';
import { applyTracking } from './trackingService';
import { resolveSpintax } from '../utils/spintax';
import { resolveDeliverableStep, classifyStepOwner } from './sequencer/stepResolver';
import {
    computeProgression,
    writeProgression,
    completeLead,
    progressionWhere,
    progressionWriteData,
    ProgressionStepLite,
} from './sequencer/leadProgression';
import { MONITORING_THRESHOLDS } from '../types';

const { ROLLING_WINDOW_SIZE } = MONITORING_THRESHOLDS;

const LOG_TAG = 'SEND-QUEUE';
const QUEUE_NAME = 'email-sends';
const DISPATCH_INTERVAL_MS = 60_000;

// Distributed dispatch lock. The held-lead processor already uses this
// exact primitive (worker:lock:lead_processor) to stop overlapping runs;
// the send dispatcher previously had nothing, so a dispatch() that ran
// longer than the 60s tick (or a second instance) could re-select and
// re-enqueue leads that were already batched. TTL auto-expires so a
// crashed dispatch never deadlocks the next tick.
const DISPATCH_LOCK_KEY = 'worker:lock:send_dispatcher';
const DISPATCH_LOCK_TTL_SECONDS = 300;

// Safety margin added on top of a batch's worst-case drain time when we
// claim its leads (push next_send_at forward so later ticks can't
// re-pick an in-flight lead). Covers BullMQ pickup latency + the
// post-send transaction. Generous on purpose: a too-small margin would
// reintroduce the duplicate-send bug; a too-large one only delays
// retry of a genuinely lost batch.
const DISPATCH_CLAIM_MARGIN_MS = 10 * 60 * 1000;
const WORKER_CONCURRENCY = 10;

// ─── Types ────────────────────────────────────────────────────────────────────

interface StepVariantRow {
    id: string;
    subject: string;
    preheader: string;
    body_html: string;
    weight: number;
}

interface SequenceStepWithVariants {
    id: string;
    step_number: number;
    /** Channel/owner of this step. Email dispatcher owns 'email' (+ the
     *  'end' terminal); the LinkedIn worker owns every linkedin_* and the
     *  find_* utility steps. Present on every SequenceStep row (schema
     *  default 'email'); typed here so the ownership guard isn't a cast. */
    step_type: string;
    delay_days: number;
    delay_hours: number;
    subject: string;
    preheader: string;
    body_html: string;
    variants: StepVariantRow[];
    /** Subsequence branching - see schema docs on SequenceStep. */
    condition?: string | null;
    branch_to_step_number?: number | null;
}

interface AccountData {
    id: string;
    organization_id: string;
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
    /** Pre-computed RFC 8058 unsubscribe URL - passed verbatim into List-Unsubscribe
     *  headers by the send services. Required by Gmail's bulk-sender policy. */
    unsubscribeUrl: string;
    /** The step being delivered (== resolved deliverable step_number).
     *  Progression after delivery is derived from this + the batch-level
     *  `steps` skeleton via computeProgression at SEND time — never
     *  pre-baked here (the inter-step delay must count from actual
     *  delivery, not from enqueue). */
    stepNumber: number;
    stepId: string;
    variantId: string | null;
}

interface BatchJobData {
    orgId: string;
    campaignId: string;
    campaignName: string;
    sendGapMinutes: number;
    account: AccountData;
    emails: EmailInBatch[];
    /** Lightweight campaign step skeleton (one campaign per batch) so the
     *  worker can computeProgression at send time. Single source of
     *  progression math shared with the LinkedIn worker. */
    steps: ProgressionStepLite[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function pickVariant(step: SequenceStepWithVariants): {
    subject: string;
    bodyHtml: string;
    preheader: string;
    variantId: string | null;
} {
    // Variant preheader, when set, overrides the step preheader - same A/B
    // semantics as subject + body. Empty string at the variant level falls
    // back to the step-level preheader so users can author once and have
    // every variant pick it up.
    if (!step.variants || step.variants.length === 0) {
        return { subject: step.subject, bodyHtml: step.body_html, preheader: step.preheader || '', variantId: null };
    }
    const totalWeight = step.variants.reduce((sum, v) => sum + v.weight, 0);
    const rand = Math.random() * totalWeight;
    let cumulative = 0;
    for (const variant of step.variants) {
        cumulative += variant.weight;
        if (rand < cumulative) {
            return {
                subject: variant.subject,
                bodyHtml: variant.body_html,
                preheader: variant.preheader || step.preheader || '',
                variantId: variant.id,
            };
        }
    }
    const last = step.variants[step.variants.length - 1];
    return {
        subject: last.subject,
        bodyHtml: last.body_html,
        preheader: last.preheader || step.preheader || '',
        variantId: last.id,
    };
}

/**
 * Inject the inbox preview text as a hidden div at the top of the body.
 *
 * Pattern: matches the transactional email templates' preheader injection
 * (see transactionalEmailTemplates.ts) - display:none + zero-line-height +
 * mso-hide:all so Outlook on Windows/Mac, Gmail, Apple Mail, and Yahoo all
 * keep the text out of the rendered body while harvesting it for the
 * inbox-list snippet. The trailing &nbsp;&zwnj; run consumes additional
 * snippet space so body content can't bleed into the preview window.
 *
 * No-op when preheader is empty so existing campaigns keep their current
 * behavior (mail clients derive the snippet from the body).
 */
function injectPreheader(bodyHtml: string, preheader: string): string {
    const text = (preheader || '').trim();
    if (!text) return bodyHtml;
    const escaped = text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    const filler = '&nbsp;&zwnj;'.repeat(50);
    const hidden =
        `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:transparent;opacity:0;">${escaped}</div>` +
        `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${filler}</div>`;
    // Insert just inside <body> when present so semantic structure survives;
    // otherwise prepend. Case-insensitive match, single replace.
    if (/<body[^>]*>/i.test(bodyHtml)) {
        return bodyHtml.replace(/<body[^>]*>/i, (m) => m + hidden);
    }
    return hidden + bodyHtml;
}

function personalizeEmail(
    template: string,
    lead: { first_name: string | null; last_name: string | null; company: string | null; email: string; title: string | null; custom_variables: any; signal_icebreaker?: string | null }
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
        // AI-generated opener - written by signalIcebreakerService when
        // the lead was promoted by a LinkedIn engagement signal. Empty
        // string for CSV / manual imports; the template author should
        // write the step copy so it still reads cleanly when missing
        // (e.g. start the body with " " + the static line).
        signal_icebreaker: lead.signal_icebreaker || '',
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
        // Invalid timezone string - fall back to UTC
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

// stepConditionMatches + resolveDeliverableStep moved to the shared
// single-source-of-truth module ./sequencer/stepResolver. The next-step
// delay math (formerly calculateNextSendAt here) moved to
// ./sequencer/leadProgression (computeProgression / progressionFromNextStep)
// so the email dispatcher and the LinkedIn worker resolve AND schedule
// the next step identically and can never drift.

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
 * Handle a send failure - delegates to bounceProcessingService.processBounce
 * which runs the unified Protection pipeline: bounce classification, threshold
 * check, percentage-rate guard, correlation, auto-pause (Observe/Suggest/
 * Enforce modes), Slack alert, state transition.
 *
 * This ensures sequencer-originated SMTP bounces flow through the *exact same*
 * pipeline as Smartlead/Instantly/EmailBison/Reply.io webhook bounces - no
 * split-brain between sequencer and webhook bounce counters.
 */
async function handleSendFailure(
    mailboxId: string,
    orgId: string,
    campaignId: string,
    recipientEmail: string,
    errorMsg: string,
    smtpCode?: string,
    smtpResponse?: string,
): Promise<void> {
    // Prefer SMTP code (RFC 5321 / 3463) when available - it's authoritative.
    // Synchronous 5xx = hard, 4xx = soft. Only fall back to keyword-matching
    // when no SMTP code was captured (e.g. provider returned a generic API error).
    const numericCode = smtpCode ? parseInt(smtpCode.split('.')[0], 10) : NaN;
    let isHardBounce = numericCode >= 500 && numericCode < 600;
    let isSoftBounce = numericCode >= 400 && numericCode < 500;

    if (!isHardBounce && !isSoftBounce) {
        const msg = (errorMsg || '').toLowerCase();
        isHardBounce = /no such user|user unknown|mailbox.*not found|no mailbox|address rejected|does not exist|invalid recipient|unknown user|mailbox unavailable|550 |551 |553 /i.test(msg);
        isSoftBounce = /mailbox full|quota exceeded|over quota|temporarily deferred|try again|temporary failure|rate limit|throttl|too many|421 |450 |451 |452 /i.test(msg);
    }

    if (!isHardBounce && !isSoftBounce) {
        // Auth / connection / config error - not a bounce. Log but don't pollute bounce stats.
        await prisma.mailbox.update({
            where: { id: mailboxId },
            data: { delivery_failure_count: { increment: 1 }, connection_error: errorMsg.slice(0, 255) },
        }).catch(() => {});
        logger.warn(`[${LOG_TAG}] Non-bounce send failure for ${maskEmail(recipientEmail)}: ${errorMsg.slice(0, 120)}`);
        return;
    }

    // Hard bounce → unified Protection pipeline (creates BounceEvent, checks
    // threshold + percentage-rate, runs correlation, auto-pauses mailbox/domain
    // if warranted, sends Slack alert). Persist the raw SMTP transcript so
    // analytics can show exact reasons.
    if (isHardBounce) {
        try {
            await bounceProcessingService.processBounce({
                organizationId: orgId,
                mailboxId,
                campaignId,
                recipientEmail,
                smtpResponse: smtpResponse || errorMsg,
                bounceType: 'hard',
                bouncedAt: new Date(),
            });
            // Annotate the just-created BounceEvent with the SMTP transcript.
            // Best-effort: processBounce writes the row inside the same call, so
            // we look it up by (mailbox_id, recipient, recently created).
            if (smtpCode || smtpResponse) {
                await prisma.bounceEvent.updateMany({
                    where: {
                        mailbox_id: mailboxId,
                        email_address: recipientEmail,
                        bounced_at: { gte: new Date(Date.now() - 5_000) },
                    },
                    data: {
                        smtp_code: smtpCode,
                        smtp_response: smtpResponse,
                        bounce_source: 'smtp',
                    },
                }).catch(() => { /* annotation is best-effort */ });
            }
            logger.info(`[${LOG_TAG}] Hard bounce → unified pipeline: ${maskEmail(recipientEmail)} (${smtpCode || 'no-code'})`);
        } catch (err: any) {
            logger.error(`[${LOG_TAG}] processBounce failed for ${mailboxId}`, err);
        }
    } else {
        // Soft bounce → increment counter, don't trigger pause (transient failures)
        await prisma.mailbox.update({
            where: { id: mailboxId },
            data: { delivery_failure_count: { increment: 1 } },
        }).catch(() => {});
        logger.info(`[${LOG_TAG}] Soft bounce: ${maskEmail(recipientEmail)} (${smtpCode || 'no-code'}, ${errorMsg.slice(0, 80)})`);
    }
}

// ════════════════════════════════════════════════════════════════════
// DISPATCHER - scans campaigns, assigns leads to mailboxes, creates batch jobs
// ════════════════════════════════════════════════════════════���═══════

let sendQueue: Queue | null = null;

async function dispatch(): Promise<void> {
    const startTime = Date.now();

    // Skip this tick entirely if a prior dispatch is still running. Same
    // pattern as processHeldLeads — without it, a dispatch that outruns
    // the 60s interval lets the next tick re-select the same leads
    // before the first run has claimed them.
    const acquired = await acquireLock(DISPATCH_LOCK_KEY, DISPATCH_LOCK_TTL_SECONDS);
    if (!acquired) {
        logger.info(`[${LOG_TAG}] Dispatch already running — skipping this tick`);
        return;
    }

    logger.info(`[${LOG_TAG}] Dispatch scan starting`);

    try {
        const now = new Date();

        // 1. Load all active campaigns with steps + accounts. Campaign table is
        // unified post-Phase-B (2026-04-26) - every active row dispatches through
        // the native send path.
        const activeCampaigns = await prisma.campaign.findMany({
            where: { status: 'active' },
            include: {
                steps: { include: { variants: true }, orderBy: { step_number: 'asc' } },
                accounts: {
                    include: {
                        account: {
                            include: {
                                // 1:1 shadow Mailbox - used to honor warmup_limit
                                // during 5-phase recovery and to defend against a
                                // partially-cascaded domain pause: if the parent
                                // domain is paused, every child mailbox MUST stop
                                // sending even if the per-mailbox cascade hasn't
                                // landed yet (e.g. partial transaction, eventual
                                // consistency, or a manual domain.status flip).
                                mailbox: {
                                    select: {
                                        warmup_limit: true,
                                        recovery_phase: true,
                                        status: true,
                                        domain: { select: { status: true } },
                                    },
                                },
                            },
                        },
                    },
                },
            },
        });

        // Pre-fetch each org's mailing_address so the dispatcher can inject it
        // into every send's footer. CAN-SPAM § 5(a)(5) requires a valid postal
        // address in every commercial email; the execution gate also blocks
        // launches without it.
        const uniqueOrgIds = Array.from(new Set(activeCampaigns.map(c => c.organization_id)));
        const orgsForMail = await prisma.organization.findMany({
            where: { id: { in: uniqueOrgIds } },
            select: { id: true, mailing_address: true },
        });
        const mailingAddressByOrg = new Map(orgsForMail.map(o => [o.id, o.mailing_address] as const));

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
        // its full daily quota inside ONE campaign during this tick - every
        // assignment in any campaign decrements the same per-account budget.
        // Resets each dispatch tick (60s).
        const globalAccountAssignedThisTick = new Map<string, number>();

        let totalJobsCreated = 0;

        for (const campaign of activeCampaigns) {
            try {
                // CAN-SPAM § 5(a)(5) gate - every commercial email must carry a
                // valid postal address. If the org hasn't configured one, skip
                // the campaign for this cycle and log a warning. The customer
                // sees a banner in the dashboard prompting them to configure it.
                // (Skipped only when include_unsubscribe is on, which is the
                // default + the only legally-defensible mode.)
                const includeUnsub = campaign.include_unsubscribe ?? true;
                const orgMailingAddress = mailingAddressByOrg.get(campaign.organization_id) || null;
                if (includeUnsub && !orgMailingAddress) {
                    logger.warn(`[${LOG_TAG}] Skipping campaign ${campaign.id} - mailing_address not configured (CAN-SPAM § 5(a)(5))`);
                    SlackAlertService.sendAlert({
                        organizationId: campaign.organization_id,
                        eventType: 'campaign.send_blocked.postal_address',
                        entityId: campaign.id,
                        severity: 'critical',
                        title: '🚫 Sending blocked: postal address missing',
                        message: `Campaign *${campaign.name}* cannot send because no postal address is configured. CAN-SPAM § 5(a)(5) requires it. Add it in Settings → Organization Details.`,
                    }).catch((err) => logger.warn(`[${LOG_TAG}] Slack alert failed (postal_address)`, { error: err?.message }));
                    continue;
                }

                // Check org monthly limit
                const tier = orgTierMap.get(campaign.organization_id) || 'trial';
                const limits = TIER_LIMITS[tier] || TIER_LIMITS.trial;
                const monthlySent = orgMonthlyMap.get(campaign.organization_id) || 0;
                if (limits.monthlySendLimit !== Infinity && monthlySent >= limits.monthlySendLimit) continue;

                // Check sending window
                if (!isWithinSendingWindow(campaign)) continue;

                // Daily limit is nullable for historical reasons. Fall back to a
                // safe SequencerSettings-style default of 50 if somehow unset.
                const dailyLimit = campaign.daily_limit ?? 50;
                const dailySent = campaignDailyMap.get(campaign.id) || 0;
                if (dailySent >= dailyLimit) continue;
                const remainingCampaignSends = dailyLimit - dailySent;

                // Seed first-step leads that never got a next_send_at (e.g. imported or
                // launched before the seeding fix). Idempotent - only targets current_step=0
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

                // Find due leads. Honor any OOO hold from the reply-intelligence
                // pipeline: ooo_until > now means we received an autoresponder
                // and the contact won't be reading mail until that date.
                const dueLeadsRaw = await prisma.campaignLead.findMany({
                    where: {
                        campaign_id: campaign.id,
                        status: 'active',
                        next_send_at: { lte: now },
                        OR: [{ ooo_until: null }, { ooo_until: { lte: now } }],
                    },
                    take: Math.min(remainingCampaignSends, 500),
                    orderBy: { next_send_at: 'asc' },
                });

                if (dueLeadsRaw.length === 0) continue;

                // Org-wide suppression check (defense in depth) - required for
                // CAN-SPAM § 5(a)(4)(A), CASL § 11(3), GDPR Art. 21. The
                // CampaignLead.status='unsubscribed' cascade catches the click-
                // unsubscribe path, and the per-row suppression catches anything
                // else that may have touched Lead.status without cascading
                // (admin override, hard-bounce automation, future paths).
                const suppressedEmails = new Set(
                    (await prisma.lead.findMany({
                        where: {
                            organization_id: campaign.organization_id,
                            email: { in: dueLeadsRaw.map(l => l.email) },
                            status: { in: ['unsubscribed', 'bounced'] },
                        },
                        select: { email: true },
                    })).map(l => l.email),
                );

                const dueLeads = dueLeadsRaw.filter(l => !suppressedEmails.has(l.email));

                // Pull signal-context icebreakers for any lead the supervisor
                // already generated one for. CampaignLead is the dispatcher's
                // primary record but signal_icebreaker lives on Lead (it's
                // workspace-scoped and reused across campaigns), so we
                // batch-fetch by email here and pass through into the
                // personalize call below. Empty Map when no leads qualify
                // - falling back to '' at render time is the right behaviour.
                const leadIcebreakers = dueLeads.length > 0
                    ? new Map(
                        (await prisma.lead.findMany({
                            where: {
                                organization_id: campaign.organization_id,
                                email: { in: dueLeads.map(l => l.email) },
                            },
                            select: { email: true, signal_icebreaker: true },
                        }) as Array<{ email: string; signal_icebreaker: string | null }>)
                            .filter(r => r.signal_icebreaker)
                            .map(r => [r.email, r.signal_icebreaker as string]),
                    )
                    : new Map<string, string>();

                if (suppressedEmails.size > 0) {
                    // Cascade the suppression onto the CampaignLead rows so future
                    // dispatches don't re-fetch+re-filter the same set every cycle.
                    const suppressedIds = dueLeadsRaw
                        .filter(l => suppressedEmails.has(l.email))
                        .map(l => l.id);
                    await prisma.campaignLead.updateMany({
                        where: { id: { in: suppressedIds } },
                        data: { status: 'unsubscribed', next_send_at: null },
                    });
                    logger.info('[SEND-QUEUE] Suppressed dispatch - org-wide lead status', {
                        campaignId: campaign.id,
                        suppressedCount: suppressedEmails.size,
                    });
                }

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

                    // Defense-in-depth domain pause check. The canonical pause
                    // path (monitoringService.pauseDomain → cascade) flips every
                    // child Mailbox.recovery_phase to 'paused', after which
                    // batchProcessor's pre-send guard (line ~1055) blocks the
                    // actual send. But if that cascade ever completes
                    // partially (transaction failure, race, or someone setting
                    // Domain.status='paused' directly via admin tooling), the
                    // child mailbox could still be eligible here. Reading the
                    // domain row alongside the mailbox closes that window:
                    // the dispatcher refuses to even ASSIGN capacity to a
                    // mailbox whose parent domain is paused.
                    if (acct.mailbox?.domain?.status === 'paused') continue;
                    if (acct.mailbox?.status === 'paused') continue;

                    const resetResult = await resetDailySendsIfNeeded(acct.id, acct.sends_reset_at);
                    const mailboxSendsToday = resetResult === 0 ? 0 : acct.sends_today;

                    // Mailbox-wide daily cap - normally ConnectedAccount.daily_send_limit,
                    // but the 5-phase recovery pipeline lowers it via Mailbox.warmup_limit
                    // during RESTRICTED_SEND / WARM_RECOVERY phases. The smaller of the
                    // two takes effect so recovering mailboxes don't dispatch at full
                    // volume mid-pipeline.
                    //
                    // Defense-in-depth: only honor warmup_limit while the mailbox is
                    // actually in a recovery phase. A fully graduated mailbox should
                    // never be capped by stale warmup data; if its phase is HEALTHY
                    // (or null/legacy), warmup_limit is ignored and the dispatcher
                    // sends at the configured ConnectedAccount.daily_send_limit.
                    const recoveryPhase = acct.mailbox?.recovery_phase;
                    const inRecovery =
                        recoveryPhase === 'quarantine' ||
                        recoveryPhase === 'restricted_send' ||
                        recoveryPhase === 'warm_recovery' ||
                        recoveryPhase === 'paused';
                    const recoveryCap = (inRecovery && acct.mailbox?.warmup_limit && acct.mailbox.warmup_limit > 0)
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

                if (accounts.length === 0) {
                    // Auto-pause the campaign when every configured mailbox is
                    // paused/recovering/over-capacity AT THE SAME TIME. Without
                    // this, the campaign stays `status='active'` and the UI lies
                    // � operators think it's still sending. We only flip the
                    // status when the campaign actually has senders configured
                    // (campaign.accounts.length > 0); a draft with no attached
                    // mailboxes should stay 'active' until the operator attaches
                    // one. Idempotent via campaignHealthService internal guard.
                    if (campaign.accounts.length > 0) {
                        await campaignHealthService.pauseCampaign(
                            campaign.organization_id,
                            campaign.id,
                            'all_mailboxes_unavailable',
                        ).catch((err) => logger.warn(`[${LOG_TAG}] Auto-pause failed`, { campaignId: campaign.id, error: err?.message }));
                    }
                    SlackAlertService.sendAlert({
                        organizationId: campaign.organization_id,
                        eventType: 'campaign.send_blocked.no_mailboxes',
                        entityId: campaign.id,
                        severity: 'warning',
                        title: '?? Sending paused: no healthy mailboxes',
                        message: `Campaign *${campaign.name}* has been auto-paused because every connected mailbox is paused, recovering, or out of daily capacity. Check mailbox health in Settings ? Mailboxes, then resume the campaign.`,
                    }).catch((err) => logger.warn(`[${LOG_TAG}] Slack alert failed (no_mailboxes)`, { error: err?.message }));
                    continue;
                }

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
                //     temporarily disconnected): same as above - wait for it.
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
                        // Lead has a sticky mailbox - try to honor it.
                        const sticky = accounts.find(a => a.id === stickyId);
                        if (sticky && (accountCounts.get(sticky.id) || 0) < sticky.remainingCapacity) {
                            chosenAccount = sticky;
                        } else if (permanentlyDisconnected.has(stickyId) || !allCampaignAccountIds.has(stickyId)) {
                            // Sticky mailbox is permanently gone - re-assign to a fresh
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
                            // refreshes or the mailbox recovers - DON'T reassign.
                            const retryAt = new Date(now.getTime() + 60 * 60 * 1000);
                            await prisma.campaignLead.update({
                                where: { id: lead.id },
                                data: { next_send_at: retryAt },
                            }).catch(() => { /* tolerable */ });
                            continue;
                        }
                    } else {
                        // First send for this lead - pick best mailbox + bind sticky.
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
                        // No deliverable step left. Single guarded completion
                        // path (was an unguarded update() that could clobber a
                        // lead that just replied).
                        await completeLead(prisma, lead.id);
                        continue;
                    }

                    // ── STEP-OWNERSHIP CONTRACT ──
                    // classifyStepOwner is the single source of truth shared
                    // with the LinkedIn worker. The email dispatcher executes
                    // ONLY 'email' steps; 'terminal' completes the lead;
                    // 'linkedin' (linkedin_*/find_*) belongs to the LinkedIn
                    // worker. Without this the email dispatcher would build an
                    // email from a LinkedIn step (subject/body_html are "" —
                    // content lives in step_config), send a blank message and
                    // advance current_step while the LinkedIn worker delivered
                    // the real touch: double action + corrupted ordering.
                    const stepOwner = classifyStepOwner(step.step_type);
                    if (stepOwner === 'terminal') {
                        // Terminal node — same single guarded completion path.
                        await completeLead(prisma, lead.id);
                        continue;
                    }
                    if (stepOwner === 'linkedin') {
                        // Not ours. Leave the lead completely untouched —
                        // status, current_step and next_send_at unchanged — so
                        // the LinkedIn worker's tick (same status='active',
                        // current_step, next_send_at<=now predicate) claims and
                        // advances it. Any state mutation here would either
                        // hide the lead from the LinkedIn worker or desync the
                        // step pointer.
                        continue;
                    }

                    // The step we resolved may have a different step_number than the
                    // candidate (when we followed a branch). Use the resolved step's
                    // number going forward so current_step gets the actual delivered
                    // step and the next dispatch starts from N+1.
                    const deliveredStepNumber = step.step_number;

                    const { subject: rawSubject, bodyHtml: rawBody, preheader: rawPreheader, variantId } = pickVariant(step);

                    // Pipeline: personalize → spintax → tracking.
                    // - Personalize first so {{tokens}} inside spintax options are substituted.
                    // - Spintax second so each lead receives a different lexical variant of the
                    //   same template, breaking ISP pattern-fingerprinting on bulk sequence sends.
                    // - Tracking last so the open pixel + click wrappers see the final URL set.
                    // Augment the CampaignLead row with the Lead-level
                    // signal_icebreaker (looked up in the batch above)
                    // so personalizeEmail can resolve {{signal_icebreaker}}.
                    const leadWithIcebreaker = { ...lead, signal_icebreaker: leadIcebreakers.get(lead.email) ?? null };
                    const subject = resolveSpintax(personalizeEmail(rawSubject, leadWithIcebreaker));
                    const personalizedBody = resolveSpintax(personalizeEmail(rawBody, leadWithIcebreaker));
                    // Preheader runs through the same personalize+spintax so authors
                    // can reference {{first_name}} / spintax in the inbox snippet too.
                    const personalizedPreheader = rawPreheader
                        ? resolveSpintax(personalizeEmail(rawPreheader, leadWithIcebreaker))
                        : '';

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
                    const orgMailingAddress = mailingAddressByOrg.get(campaign.organization_id) || null;
                    const trackedBody = applyTracking(personalizedBody, {
                        leadId: lead.id,
                        trackOpens: campaign.track_opens ?? true,
                        trackClicks: campaign.track_clicks ?? true,
                        includeUnsubscribe: campaign.include_unsubscribe ?? true,
                        trackingDomain: effectiveTrackingDomain,
                        euComplianceMode: campaign.eu_compliance_mode ?? false,
                        mailingAddress: orgMailingAddress,
                    });
                    // Preheader injection - invisible-to-render div placed before
                    // the visible body. Mail clients (Gmail, Outlook, Apple Mail,
                    // Yahoo) lift the first non-whitespace text as the inbox-list
                    // snippet; the trailing &zwnj; whitespace hack prevents
                    // body content bleeding into the preview window.
                    const bodyHtml = injectPreheader(trackedBody, personalizedPreheader);
                    // RFC 8058 one-click unsubscribe URL - populates List-Unsubscribe
                    // headers in the send services. Always computed when
                    // include_unsubscribe is on (default true).
                    const unsubscribeUrl = (campaign.include_unsubscribe ?? true)
                        ? buildUnsubscribeUrl(lead.id, effectiveTrackingDomain)
                        : '';

                    // No next-step math here anymore. Progression (current_step,
                    // next_send_at, completed?) is derived once, at SEND time,
                    // by computeProgression in the worker using the batch-level
                    // `steps` skeleton — so the inter-step delay counts from
                    // actual delivery (not enqueue) and the math lives in
                    // exactly one place shared with the LinkedIn worker.
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
                        unsubscribeUrl,
                        stepNumber: deliveredStepNumber,
                        stepId: step.id,
                        variantId,
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
                // so use a small Promise.all of single updates - usually <50 rows.
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

                    // CLAIM the leads in this batch before enqueuing. Until
                    // now the dispatcher selected leads by (status='active',
                    // next_send_at<=now) but never moved them out of that
                    // window at enqueue time — so every 60s tick re-selected
                    // and re-enqueued the same leads while their batch was
                    // still draining in the worker (one email per
                    // send_gap_minutes, often hours), mass-duplicating sends.
                    //
                    // Push next_send_at past this batch's worst-case drain
                    // time. The worker's post-send transaction overwrites it
                    // with the real next-step schedule on success. If the
                    // batch is lost (worker crash / dropped job) the lead
                    // naturally becomes due again after the window and is
                    // retried — self-healing, no stuck rows, no separate
                    // sweep. Guarded on status='active' so we never resurrect
                    // a lead that replied/unsubscribed between selection and
                    // here (canSendNow re-checks at send time regardless).
                    const batchDrainMs = batch.emails.length * sendGap * 60_000;
                    const claimUntil = new Date(Date.now() + batchDrainMs + DISPATCH_CLAIM_MARGIN_MS);
                    const claimedIds = batch.emails.map(e => e.leadId);
                    const claim = await prisma.campaignLead.updateMany({
                        where: { id: { in: claimedIds }, status: 'active' },
                        data: { next_send_at: claimUntil },
                    });
                    if (claim.count !== claimedIds.length) {
                        logger.warn(`[${LOG_TAG}] Lead claim partial: ${claim.count}/${claimedIds.length} claimed (rest changed state since selection — canSendNow will skip them)`, {
                            campaignId: campaign.id,
                            mailbox: batch.account.email,
                        });
                    }

                    const jobData: BatchJobData = {
                        orgId: campaign.organization_id,
                        campaignId: campaign.id,
                        campaignName: campaign.name,
                        sendGapMinutes: sendGap,
                        account: batch.account,
                        emails: batch.emails,
                        // Lightweight step skeleton, once per batch (all
                        // emails in a batch are from this one campaign).
                        steps: (campaign.steps as { step_number: number; delay_days: number; delay_hours: number }[])
                            .map(s => ({ step_number: s.step_number, delay_days: s.delay_days, delay_hours: s.delay_hours })),
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
                    logger.info(`[${LOG_TAG}] Campaign "${campaign.name}" completed - no more active leads`);

                    SlackAlertService.sendAlert({
                        organizationId: campaign.organization_id,
                        eventType: 'campaign.completed',
                        entityId: campaign.id,
                        severity: 'info',
                        title: '✅ Campaign completed',
                        message: `*${campaign.name}* finished - every lead has been worked through the full sequence. Reply count: ${campaign.reply_count ?? 0}.`,
                    }).catch((err) => logger.warn(`[${LOG_TAG}] Slack alert failed (campaign.completed)`, { error: err?.message }));
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
    } finally {
        await releaseLock(DISPATCH_LOCK_KEY).catch((err) =>
            logger.warn(`[${LOG_TAG}] Failed to release dispatch lock (will TTL-expire)`, { error: err?.message }),
        );
    }
}

// ════════════════════════════════════════════════════════════════════
// WORKER - processes a batch of emails through one SMTP connection
// ════════════════════════════════════════════════════════════════════

async function processBatchJob(data: BatchJobData): Promise<void> {
    const { account, emails, sendGapMinutes, campaignId, orgId } = data;
    const gapMs = sendGapMinutes * 60 * 1000;
    const jitterMs = Math.min(gapMs * 0.15, 120_000); // ±15% jitter, max 2 min

    // Ensure shadow Mailbox exists - Protection layer requires it for SendEvent FK integrity,
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
        logger.error(`[${LOG_TAG}] Failed to ensure mailbox for ${account.email} - skipping batch`, err);
        return;
    }

    // Check if mailbox is currently paused/quarantined by Protection layer - skip if so
    const mailboxState = await prisma.mailbox.findUnique({
        where: { id: mailboxId },
        select: { recovery_phase: true, status: true },
    });
    if (mailboxState && (mailboxState.status === 'paused' || mailboxState.recovery_phase === 'paused' || mailboxState.recovery_phase === 'quarantine')) {
        logger.warn(`[${LOG_TAG}] Mailbox ${account.email} is ${mailboxState.recovery_phase} - skipping batch of ${emails.length}`);
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
            // ── COMPLIANCE PRE-SEND CHECK (CAN-SPAM §5(a)(3) + RFC 8058) ──
            // If we requested an unsubscribe URL, the body MUST contain it. If
            // applyTracking() was bypassed or the template was assembled in a
            // way that stripped the footer, abort the send rather than ship a
            // non-compliant message. Better to fail loud here than to be flagged
            // by a mailbox provider.
            if (email.unsubscribeUrl && !email.bodyHtml.includes(email.unsubscribeUrl)) {
                logger.error(`[${LOG_TAG}] COMPLIANCE BLOCK: unsubscribe URL missing from body for ${email.leadEmail}; aborting send`, undefined, {
                    mailboxId, orgId, campaignId, leadEmail: email.leadEmail,
                });
                failedCount++;
                continue;
            }

            // ── PROTECTION GATE - re-check at SEND TIME ──
            // The dispatcher snapshot (~60s ago) and BullMQ worker pickup can
            // span >60 minutes for batches with high send_gap_minutes, so a
            // mailbox/domain pause that fires mid-batch must be re-checked
            // here. Also enforces aggregate-recovery caps and the YELLOW
            // per-mailbox cap that canExecuteLead can't see at enrollment.
            const gate = await executionGateService.canSendNow(
                orgId,
                campaignId,
                mailboxId,
                email.leadEmail,
            );
            if (!gate.allowed) {
                if (gate.deferrable) {
                    const deferMinutes = gate.deferMinutes ?? 60;
                    await prisma.campaignLead.update({
                        where: { id: email.leadId },
                        data: { next_send_at: new Date(Date.now() + deferMinutes * 60 * 1000) },
                    }).catch((err) => {
                        logger.warn(`[${LOG_TAG}] Defer write failed for ${email.leadId}: ${err.message}`);
                    });
                    logger.info(`[${LOG_TAG}] Send deferred ${deferMinutes}m for ${maskEmail(email.leadEmail)}: ${gate.reason}`);
                } else {
                    // Hard block - pause the lead in this campaign so it stops
                    // looping. Operator action (or YELLOW reclassification)
                    // will release it.
                    await prisma.campaignLead.update({
                        where: { id: email.leadId },
                        data: { status: 'paused', next_send_at: null },
                    }).catch((err) => {
                        logger.warn(`[${LOG_TAG}] Pause write failed for ${email.leadId}: ${err.message}`);
                    });
                    logger.warn(`[${LOG_TAG}] Send blocked for ${maskEmail(email.leadEmail)}: ${gate.reason}`);
                }
                failedCount++;
                continue;
            }

            // ── IDEMPOTENCY: already-delivered guard ──
            // SendEvent(campaign_lead_id, step_number) is data-layer-unique.
            // If a row already exists for this (lead, step) the step was
            // already delivered — a stalled-job re-run, or any two-writer
            // interleaving. Do NOT physically re-send. Advance the lead past
            // the delivered step (guarded on status='active') so it doesn't
            // loop, then move on. The unique constraint on the create below
            // is the race backstop if two workers clear this check at once.
            const priorSend = await prisma.sendEvent.findFirst({
                where: { campaign_lead_id: email.leadId, step_number: email.stepNumber },
                select: { id: true },
            });
            if (priorSend) {
                logger.warn(`[${LOG_TAG}] Step ${email.stepNumber} already delivered to lead ${email.leadId} — skipping resend, advancing`, {
                    campaignId, mailbox: account.email,
                });
                // Single shared progression path. computeProgression derives
                // the next state from the delivered step + the batch step
                // skeleton; writeProgression is the guarded write (no-op if
                // the lead replied/paused since selection).
                const state = computeProgression({
                    deliveredStepNumber: email.stepNumber,
                    steps: data.steps,
                });
                await writeProgression(prisma, email.leadId, state).catch((err) => {
                    logger.warn(`[${LOG_TAG}] Post-dedupe advance failed for ${email.leadId}: ${err?.message}`);
                });
                continue;
            }

            const result: SendResult = await sendEmail(account, email.leadEmail, email.subject, email.bodyHtml, {
                unsubscribeUrl: email.unsubscribeUrl || null,
            });

            if (!result.success) {
                logger.error(`[${LOG_TAG}] Failed: ${account.email} → ${email.leadEmail}: ${result.error} (${result.smtpCode || 'no-code'})`);
                failedCount++;
                // Classify bounce type from SMTP code (preferred) or error text
                // and record it.
                await handleSendFailure(
                    mailboxId, orgId, campaignId, email.leadEmail,
                    result.error || 'unknown', result.smtpCode, result.smtpResponse,
                );
                continue;
            }

            // Single shared progression compute, anchored to actual send
            // time (not enqueue) so the inter-step delay measures from
            // delivery. The guarded write is embedded as a transaction
            // element below via progressionWhere/progressionWriteData so it
            // stays atomic with SendEvent + the counters.
            const sendProgression = computeProgression({
                deliveredStepNumber: email.stepNumber,
                steps: data.steps,
            });

            // Write all updates in one transaction
            await prisma.$transaction([
                prisma.sendEvent.create({
                    data: {
                        organization_id: orgId,
                        mailbox_id: mailboxId,
                        campaign_id: campaignId,
                        recipient_email: email.leadEmail,
                        // Idempotency identity — the @@unique([campaign_lead_id,
                        // step_number]) makes this create the data-layer
                        // backstop: a duplicate delivery throws P2002, the
                        // whole transaction rolls back (no double counters, no
                        // double progression), and the per-email catch logs +
                        // continues. The pre-send guard above catches the
                        // common case before the SMTP send.
                        campaign_lead_id: email.leadId,
                        step_number: email.stepNumber,
                        sent_at: new Date(),
                    },
                }),
                // Progression write — SAME guarded shape as writeProgression
                // (progressionWhere + progressionWriteData), embedded here so
                // it commits atomically with the SendEvent + counters.
                // status='active' guard: canSendNow re-checks status just
                // before sendEmail(), but a reply / unsubscribe can still land
                // in the few-second SMTP round-trip; an unconditional update
                // would resurrect that lead (and imapReplyWorker dedupes the
                // inbound by message_id so it would NOT self-correct). 0 rows
                // matched = no-op; the SendEvent + counters still record the
                // email that physically went out.
                prisma.campaignLead.updateMany({
                    where: progressionWhere(email.leadId),
                    data: progressionWriteData(sendProgression),
                }),
                prisma.connectedAccount.update({
                    where: { id: account.id },
                    data: { sends_today: { increment: 1 } },
                }),
                // Per-(campaign, mailbox) usage counter. Upsert so the row is
                // created on first send and incremented atomically thereafter.
                // sends_reset_at carries the boundary at which this counter is
                // considered stale - at-load-time the dispatcher checks if it's
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

            // Outbound webhook fan-out - fires email.sent for any subscribers.
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
                `${campaignId}-${email.leadId}-${email.stepNumber}`,
            );

            // Post-send Protection bookkeeping. Replaces the deprecated
            // monitoringService.recordSent() which (a) double-counted
            // window_sent_count via a non-atomic read-then-write race against
            // the transaction above and (b) created a parallel storeEvent
            // path the unified eventQueue had already superseded. We do the
            // three things that recordSent actually contributed:
            //   1. Conditional clean_sends_since_phase increment for healing
            //      graduation (only counts in RESTRICTED_SEND / WARM_RECOVERY).
            //   2. Domain.last_sent_at refresh for inactivity tracking.
            //   3. Sliding-window roll once we cross ROLLING_WINDOW_SIZE so
            //      bounce/send ratios stay representative - keep half the
            //      stats per the original design.
            (async () => {
                try {
                    await healingService.recordCleanSend('mailbox', mailboxId);

                    const post = await prisma.mailbox.findUnique({
                        where: { id: mailboxId },
                        select: {
                            domain_id: true,
                            window_sent_count: true,
                            window_bounce_count: true,
                        },
                    });
                    if (!post) return;

                    if (post.domain_id) {
                        updateDomainLastSent(post.domain_id);
                    }

                    if (post.window_sent_count >= ROLLING_WINDOW_SIZE) {
                        const slidSent = Math.floor(post.window_sent_count / 2);
                        const slidBounce = Math.floor(post.window_bounce_count / 2);
                        await prisma.mailbox.update({
                            where: { id: mailboxId },
                            data: {
                                window_sent_count: slidSent,
                                window_bounce_count: slidBounce,
                                window_start_at: new Date(),
                            },
                        });
                        await auditLogService.logAction({
                            organizationId: orgId,
                            entity: 'mailbox',
                            entityId: mailboxId,
                            trigger: 'monitor_window',
                            action: 'window_slide',
                            details: `Window slid: kept ${slidBounce}/${slidSent} (50% of previous). Sliding heal.`,
                        });
                    }
                } catch (err: any) {
                    logger.warn(`[${LOG_TAG}] post-send bookkeeping failed for ${mailboxId}: ${err.message}`);
                }
            })();

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

            logger.info(`[${LOG_TAG}] Sent step ${email.stepNumber} → ${maskEmail(email.leadEmail)} via ${account.email}`, {
                campaignId,
                batch: `${i + 1}/${emails.length}`,
                sequenceCompleted: sendProgression.status === 'completed',
            });
        } catch (err: any) {
            logger.error(`[${LOG_TAG}] Error processing ${email.leadEmail}`, err);
            failedCount++;
        }
    }

    logger.info(`[${LOG_TAG}] Batch complete: ${account.email} - ${sentCount} sent, ${failedCount} failed`);
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
                // No global rate limiter here - the send_gap_minutes inside each batch
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
        logger.warn(`[${LOG_TAG}] No Redis - in-process sequential fallback`);
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
