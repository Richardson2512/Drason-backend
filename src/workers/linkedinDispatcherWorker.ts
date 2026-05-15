/**
 * LinkedIn sequence dispatcher (Phase 5.1).
 *
 * Per cycle (every 60s) walks every CampaignLead in every ongoing
 * LinkedIn-channel campaign and, for any step whose intended-fire-date
 * has arrived AND not already been executed, drives it through:
 *
 *   1. preconditions (preconditionEvaluator) → may SKIP
 *   2. condition predicate (condition + branch_to_step_number) → may BRANCH
 *   3. sender selection (rotation over CampaignLinkedInSender pool,
 *      respecting working hours + capacity)
 *   4. dispatch via sendService (linkedin_message / CR / InMail) or
 *      enrichment trigger (find_email)
 *   5. SequenceStepExecution audit row (SCHEDULED → SENT/FAILED/SKIPPED/BRANCHED)
 *
 * Intentional design (matches what Phase 3 locked):
 *   - Linear timeline by step_number with delay_days/delay_hours computed
 *     from the campaign-lead's enrollment date.
 *   - Each step's intended_fire_date is sum of (delay_days + delay_hours/24)
 *     across all earlier steps. Skips do NOT shift later steps.
 *   - This worker only handles LinkedIn-channel steps. Email-channel
 *     steps continue to flow through the existing email dispatcher.
 */

import { prisma } from '../prisma';
import { logger } from '../services/observabilityService';
import { evaluate, type PreconditionContext } from '../services/sequencer/preconditionEvaluator';
import { STEP_TYPES, isLinkedInDispatcherStep } from '../services/sequencer/stepTypeRegistry';
import { decideConditionOutcome } from '../services/sequencer/stepResolver';
import {
    computeProgression,
    writeProgression,
    completeLead,
    progressionFromNextStep,
    rescheduleSameStep,
} from '../services/sequencer/leadProgression';
import * as stepAudit from '../services/sequencer/stepExecutionAudit';
import * as sendService from '../services/linkedin/sendService';
import { runEnrichmentAgent } from '../services/agents/enrichmentAgent';
import { chats as unipileChats } from '../services/unipile';
import type { ReactionType } from '../services/unipile';

const RUN_INTERVAL_MS = 60 * 1000;
const FIRST_RUN_DELAY_MS = 60 * 1000;
const BATCH_SIZE = 200;

// DEFER policy for "the step can't run yet, wait and retry the SAME step"
// (today only linkedin_like_post when the lead has no post yet AND
// skip-if-no-post is off). Bounded so a lead that simply never posts is
// not deferred forever: after MAX_DEFER_ATTEMPTS we skip-and-continue.
// 8 * 6h ≈ a 2-day ceiling.
const DEFER_RETRY_MS = 6 * 60 * 60 * 1000;
const MAX_DEFER_ATTEMPTS = 8;
/** skip_reason marking a bounded "waiting for a post" deferral; counted to
 *  enforce MAX_DEFER_ATTEMPTS. */
const DEFER_REASON_NO_POST = 'no_post_yet_deferred';

let scheduled: NodeJS.Timeout | null = null;
let totalCycles = 0;
let totalDispatched = 0;
let totalSkipped = 0;
let totalFailed = 0;
let lastError: string | null = null;

interface DispatchCandidate {
    campaign_id: string;
    organization_id: string;
    campaign_lead_id: string;
    lead_id: string | null;
    lead_email: string;
    lead_linkedin_url: string | null;
    next_step_number: number;
    enrollment_at: Date;
    // Runtime fields used by evaluateCondition predicates. Snapshotted
    // at findDueCandidates time so the predicate doesn't re-query the
    // CampaignLead row per candidate (the same fields drove a hidden
    // N+1 alongside the sender-pool N+1).
    replied_at: Date | null;
    opened_count: number;
    clicked_count: number;
}

/**
 * Per-cycle cache for sender pools + live capacity.
 *
 * Goal: stop selectSender from re-fetching `CampaignLinkedInSender +
 * LinkedInAccount` rows for every candidate. On a 200-candidate cycle
 * across 10 campaigns the naïve path issued 200 sender-pool queries.
 *
 * Cache rules:
 *   - Sender pool per campaign is loaded once at cycle start (lazy on
 *     first dispatch for that campaign). Static fields (max caps,
 *     account_type, working_hours, rotation_priority) are snapshot.
 *   - Live capacity is tracked in `accountUsage` keyed by account_id.
 *     Initial values come from the DB counters (invites_today /
 *     messages_today / inmails_today). reserveSenderSlot (called only
 *     post-gates, once committed to send) increments the in-memory
 *     counter so two candidates in the same cycle can't double-book a
 *     sender that only has one slot left. The DB counters are still
 *     authoritative across cycles - sendService writes them, the next
 *     cycle reads fresh values.
 */
interface CachedSender {
    sender_id: string;
    account_id: string;
    rotation_priority: number;
    working_hours: unknown;
    /** Per-kind caps, falling back to the LinkedInAccount default when
     *  the CampaignLinkedInSender override is NULL. */
    cap_invites: number;
    cap_messages: number;
    cap_inmails: number;
    cap_invites_per_week: number;
    /** Today/this-week counters snapshotted at first load + bumped by
     *  reserveSenderSlot (post-gates) within this cycle. */
    used_invites: number;
    used_messages: number;
    used_inmails: number;
    used_invites_this_week: number;
    account_status: string;
}

interface CycleCache {
    /** campaign_id → ordered (rotation_priority asc) sender list. */
    sendersByCampaign: Map<string, CachedSender[]>;
    /** Shared across campaigns - one account can power multiple campaigns,
     *  and the daily cap is account-wide, not campaign-wide. Keyed by
     *  account_id. */
    accountUsage: Map<string, { invites: number; messages: number; inmails: number; invites_this_week: number }>;
}

function makeCycleCache(): CycleCache {
    return { sendersByCampaign: new Map(), accountUsage: new Map() };
}

async function loadSenderPoolForCampaign(campaignId: string, cache: CycleCache): Promise<CachedSender[]> {
    const cached = cache.sendersByCampaign.get(campaignId);
    if (cached) return cached;

    const senders = await prisma.campaignLinkedInSender.findMany({
        where: {
            campaign_id: campaignId,
            enabled: true,
            linkedin_account: { status: { in: ['OK', 'SYNC_SUCCESS'] } },
        },
        include: { linkedin_account: true },
        orderBy: { rotation_priority: 'asc' },
    });

    const built: CachedSender[] = senders.map((s) => {
        const acct = s.linkedin_account;
        // Seed account usage from the live DB counter the first time we
        // see this account in this cycle. Subsequent campaigns sharing
        // the account read the same map entry.
        if (!cache.accountUsage.has(acct.id)) {
            cache.accountUsage.set(acct.id, {
                invites: acct.invites_today,
                messages: acct.messages_today,
                inmails: acct.inmails_today,
                invites_this_week: acct.invites_this_week,
            });
        }
        return {
            sender_id: s.id,
            account_id: acct.id,
            rotation_priority: s.rotation_priority,
            working_hours: s.working_hours,
            cap_invites: s.max_invites_per_day ?? acct.max_invites_per_day,
            cap_messages: s.max_messages_per_day ?? acct.max_messages_per_day,
            cap_inmails: s.max_inmails_per_day ?? acct.max_inmails_per_day,
            cap_invites_per_week: acct.max_invites_per_week,
            used_invites: acct.invites_today,
            used_messages: acct.messages_today,
            used_inmails: acct.inmails_today,
            used_invites_this_week: acct.invites_this_week,
            account_status: acct.status,
        };
    });

    cache.sendersByCampaign.set(campaignId, built);
    return built;
}

/**
 * Pick out CampaignLeads that have a LinkedIn step due to fire now.
 *
 * Strategy: in v1 we naïvely scan ongoing LinkedIn campaigns and walk
 * each lead's current_step + 1 to find the next step. For high-volume
 * scale (10k+ leads/campaign) we'll need a denormalized
 * "next_due_at" column on CampaignLead - flagged as Phase 5.2.
 */
async function findDueCandidates(): Promise<DispatchCandidate[]> {
    const campaigns = await prisma.campaign.findMany({
        where: {
            status: { in: ['active', 'ongoing', 'starting'] },
            deleted_at: null,
            linkedinSenders: { some: { enabled: true } },
        },
        select: { id: true, organization_id: true },
        take: 50,
    });
    if (campaigns.length === 0) return [];

    const now = new Date();
    const candidates: DispatchCandidate[] = [];

    for (const c of campaigns) {
        // Pull steps once per campaign.
        const steps = await prisma.sequenceStep.findMany({
            where: { campaign_id: c.id },
            orderBy: { step_number: 'asc' },
        });
        if (steps.length === 0) continue;

        // Find leads whose current_step has a LinkedIn next-step due.
        // CampaignLead joins to Lead via email (not a FK), so we fetch
        // the Lead rows in one batch keyed by email - previously this was
        // a per-row findFirst inside the loop (N+1).
        const leads = await prisma.campaignLead.findMany({
            where: {
                campaign_id: c.id,
                status: 'active',
                current_step: { gte: 0 },
                next_send_at: { lte: now },
            },
            take: BATCH_SIZE,
            select: {
                id: true, email: true, current_step: true, created_at: true,
                replied_at: true, opened_count: true, clicked_count: true,
            },
        });

        // Pre-filter to leads whose IMMEDIATE next step is owned by this
        // dispatcher. Resolution is by step_number = current_step + 1 — the
        // SAME convention the email dispatcher uses — NOT array position.
        //
        // The old `steps[l.current_step]` indexed by ARRAY POSITION while
        // advanceLead moved current_step by step_number VALUE. Every
        // campaign-create path numbers steps 1-based contiguous, so those
        // two were incompatible and this worker executed every OTHER step
        // (a 3-step LinkedIn sequence ran steps 1 and 3; a 2-step sequence
        // ran step 1 then stalled). Resolving by step_number fixes that and
        // keeps the LinkedIn and email executors on one numbering model.
        //
        // Branch/condition resolution stays in dispatchOne (it needs
        // dispatch-time context — resolved profile / sender / found email —
        // that a pure CampaignLead-only resolver can't see). isLinkedIn-
        // DispatcherStep remains the single shared ownership predicate, so a
        // step the email dispatcher owns is left for it and vice versa.
        const stepByNumber = new Map(steps.map(s => [s.step_number, s]));

        type EligibleLead = (typeof leads)[number] & { _nextStep: (typeof steps)[number] };
        const eligible: EligibleLead[] = [];
        for (const l of leads) {
            const next = stepByNumber.get(l.current_step + 1);
            if (next && isLinkedInDispatcherStep(next.step_type)) {
                eligible.push({ ...l, _nextStep: next });
            }
        }
        if (eligible.length === 0) continue;

        const emails = Array.from(new Set(eligible.map(l => l.email)));
        const leadRows = emails.length > 0
            ? await prisma.lead.findMany({
                where: { organization_id: c.organization_id, email: { in: emails } },
                select: { id: true, email: true, linkedin_url: true },
            })
            : [];
        const leadByEmail = new Map(leadRows.map(r => [r.email, r]));

        for (const l of eligible) {
            const lead = leadByEmail.get(l.email);
            candidates.push({
                campaign_id: c.id,
                organization_id: c.organization_id,
                campaign_lead_id: l.id,
                lead_id: lead?.id ?? null,
                lead_email: l.email,
                lead_linkedin_url: lead?.linkedin_url || null,
                next_step_number: l._nextStep.step_number,
                enrollment_at: l.created_at,
                replied_at: l.replied_at,
                opened_count: l.opened_count,
                clicked_count: l.clicked_count,
            });
        }
    }

    return candidates;
}

interface WorkingHours {
    /** IANA tz database id (e.g. "America/New_York"). */
    tz?: string;
    /** Days of week 1..7 Monday..Sunday. Empty/missing = all days. */
    days?: number[];
    /** "HH:MM" 24-hour. NULL/missing = 00:00. */
    start?: string;
    /** "HH:MM" 24-hour. NULL/missing = 23:59. */
    end?: string;
}

/**
 * Check whether `now` falls inside the working-hours window for a sender.
 * Returns true when no working_hours is set (24/7) or when within window.
 * Behavior: senders outside their working window are SKIPPED at dispatch
 * time - we don't queue for later.
 */
function isWithinWorkingHours(wh: WorkingHours | null | undefined, now: Date): boolean {
    if (!wh || typeof wh !== 'object') return true;
    const tz = wh.tz || 'UTC';
    try {
        const fmt = new Intl.DateTimeFormat('en-US', {
            timeZone: tz,
            weekday: 'short',
            hour: '2-digit', minute: '2-digit',
            hour12: false,
        });
        const parts = fmt.formatToParts(now);
        const weekdayStr = parts.find(p => p.type === 'weekday')?.value || '';
        const hour = parseInt(parts.find(p => p.type === 'hour')?.value || '0', 10);
        const minute = parseInt(parts.find(p => p.type === 'minute')?.value || '0', 10);
        const dayMap: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
        const dow = dayMap[weekdayStr] ?? 0;

        if (Array.isArray(wh.days) && wh.days.length > 0 && !wh.days.includes(dow)) return false;

        const nowMin = hour * 60 + minute;
        const [sh, sm] = (wh.start || '00:00').split(':').map(Number);
        const [eh, em] = (wh.end || '23:59').split(':').map(Number);
        const startMin = sh * 60 + sm;
        const endMin = eh * 60 + em;
        return nowMin >= startMin && nowMin <= endMin;
    } catch {
        // Bad tz string → treat as 24/7 rather than blocking the campaign.
        return true;
    }
}

/**
 * SELECTION (read-only): pick the first enabled sender from the campaign's
 * pool with remaining capacity AND inside its working-hours window. NULL
 * when none qualifies (caller writes a SKIPPED audit row).
 *
 * This deliberately does NOT mutate the cycle capacity counters. Selection
 * has to run early (the condition evaluator needs the sender account to
 * answer if_connection), but the capacity RESERVATION is a side-effect
 * that must not happen until we're actually committed to sending —
 * otherwise a step that then branches / skips / is a duplicate burns a
 * slot for the rest of the cycle (the wasted-capacity bug). Reservation is
 * a separate explicit step: reserveSenderSlot, called post-gates.
 *
 * Safe because tick() awaits dispatchOne strictly sequentially — no two
 * candidates are mid-dispatch at once, so select-then-reserve within one
 * dispatchOne can't race another candidate.
 */
async function selectSender(
    campaignId: string,
    kind: 'invite' | 'message' | 'inmail',
    cache: CycleCache,
): Promise<{ id: string; account_id: string } | null> {
    const senders = await loadSenderPoolForCampaign(campaignId, cache);
    const now = new Date();
    for (const s of senders) {
        const usage = cache.accountUsage.get(s.account_id);
        if (!usage) continue; // shouldn't happen; loader seeds the row.
        const used = kind === 'invite' ? usage.invites : kind === 'message' ? usage.messages : usage.inmails;
        const cap  = kind === 'invite' ? s.cap_invites : kind === 'message' ? s.cap_messages : s.cap_inmails;
        if (used >= cap) continue;
        if (kind === 'invite' && usage.invites_this_week >= s.cap_invites_per_week) continue;
        // Working hours - "out of working hours" is a skip-now-don't-
        // queue-later. If senders are all outside hours, the next
        // dispatcher cycle will re-evaluate.
        if (!isWithinWorkingHours(s.working_hours as WorkingHours | null, now)) continue;
        return { id: s.sender_id, account_id: s.account_id };
    }
    return null;
}

/**
 * RESERVATION (the side-effect): decrement the in-cycle capacity for the
 * chosen sender's account so a second candidate in the SAME cycle sees the
 * slot consumed. Called only AFTER every gate (condition / preconditions /
 * idempotency) has passed and we are committed to sending — never before.
 * The DB counters are still authoritative across cycles (sendService
 * writes them; next cycle reads fresh values).
 */
function reserveSenderSlot(accountId: string, kind: 'invite' | 'message' | 'inmail', cache: CycleCache): void {
    const usage = cache.accountUsage.get(accountId);
    if (!usage) return;
    if (kind === 'invite') {
        usage.invites += 1;
        usage.invites_this_week += 1;
    } else if (kind === 'message') {
        usage.messages += 1;
    } else {
        usage.inmails += 1;
    }
}

/**
 * Evaluate a step's `condition` predicate against the lead's runtime
 * state. Returns true when the step should proceed, false when it should
 * skip or branch.
 *
 * Predicate vocabulary (per SequenceStep.condition schema docs):
 *   - if_no_reply / if_replied        - CampaignLead.replied_at
 *   - if_opened / if_not_opened       - CampaignLead.opened_count
 *   - if_clicked / if_not_clicked     - CampaignLead.clicked_count
 *   - if_connection / if_not_connection - LinkedInConnectionEdge.status
 *   - if_email_found / if_not_email_found - Lead.email present
 */
async function evaluateCondition(
    condition: string,
    cand: DispatchCandidate,
    linkedinProfileId: string | null,
    senderAccountId: string | null,
): Promise<boolean> {
    // Runtime predicates read off the candidate snapshot taken at
    // findDueCandidates time. The lead row is at most ~60s stale (one
    // dispatcher cycle) which is fine for opens/clicks/replies - the
    // reply-tag worker has a 15min Auto-Tag delay anyway, so this is
    // never the binding latency.
    switch (condition) {
        case 'if_replied':       return Boolean(cand.replied_at);
        case 'if_no_reply':      return !cand.replied_at;
        case 'if_opened':        return cand.opened_count > 0;
        case 'if_not_opened':    return cand.opened_count === 0;
        case 'if_clicked':       return cand.clicked_count > 0;
        case 'if_not_clicked':   return cand.clicked_count === 0;
        case 'if_connection':
        case 'if_not_connection': {
            if (!linkedinProfileId || !senderAccountId) return condition === 'if_not_connection';
            const edge = await prisma.linkedInConnectionEdge.findUnique({
                where: { linkedin_account_id_linkedin_profile_id: { linkedin_account_id: senderAccountId, linkedin_profile_id: linkedinProfileId } },
                select: { status: true },
            });
            const connected = edge?.status === 'CONNECTED';
            return condition === 'if_connection' ? connected : !connected;
        }
        case 'if_email_found':     return Boolean(cand.lead_email && !cand.lead_email.endsWith('@unresolved.local'));
        case 'if_not_email_found': return !cand.lead_email || cand.lead_email.endsWith('@unresolved.local');
        default:
            logger.warn('[LINKEDIN-DISPATCHER] Unknown condition - treating as true', { condition });
            return true;
    }
}

type DispatchResult = 'SENT' | 'SKIPPED' | 'FAILED' | 'BRANCHED' | 'DEFER';

async function dispatchOne(cand: DispatchCandidate, cache: CycleCache): Promise<DispatchResult> {
    const step = await prisma.sequenceStep.findFirst({
        where: { campaign_id: cand.campaign_id, step_number: cand.next_step_number },
    });
    if (!step) return 'FAILED';
    const stepDef = STEP_TYPES[step.step_type];
    if (!stepDef) return 'FAILED';

    // Resolve the LinkedIn profile for the lead (used by every step type
    // except find_email).
    let linkedinProfileId: string | null = null;
    let linkedinPublicId: string | null = null;
    if (cand.lead_linkedin_url) {
        const slug = cand.lead_linkedin_url.match(/\/in\/([^\/\?]+)/)?.[1];
        if (slug) {
            linkedinPublicId = slug;
            const p = await prisma.linkedInProfile.findUnique({
                where: { organization_id_public_identifier: { organization_id: cand.organization_id, public_identifier: slug } },
                select: { id: true },
            });
            linkedinProfileId = p?.id ?? null;
        }
    }

    // Pick sender for the step kind. find_email + non-send LinkedIn steps
    // (view/follow/like) still need a sender account to act FROM.
    let senderKind: 'invite' | 'message' | 'inmail' | null = null;
    if (step.step_type === 'linkedin_connection_request') senderKind = 'invite';
    else if (step.step_type === 'linkedin_message') senderKind = 'message';
    else if (step.step_type === 'linkedin_inmail') senderKind = 'inmail';
    else if (step.step_type === 'linkedin_view_profile' || step.step_type === 'linkedin_follow' || step.step_type === 'linkedin_like_post') {
        // Action-type steps count against the message bucket (LinkedIn
        // groups them under the 100/day "other actions" cap).
        senderKind = 'message';
    }

    // SELECT only (no capacity reservation yet) — the condition evaluator
    // below needs the sender account for if_connection, but reserving the
    // slot before the gates would waste it if the step then branches/
    // skips/dedupes. Reservation happens post-gates, just before send.
    const sender = senderKind ? await selectSender(cand.campaign_id, senderKind, cache) : null;
    if (senderKind && !sender) {
        await stepAudit.markSkipped({
            organization_id: cand.organization_id, campaign_id: cand.campaign_id,
            campaign_lead_id: cand.campaign_lead_id, sequence_step_id: step.id,
            step_number: step.step_number, step_type: step.step_type,
            skip_reason: 'no_sender_capacity_or_out_of_hours',
        });
        // Do NOT advance the lead - try again on the next cycle when caps
        // reset or working hours roll in. Working-hours skips need to be
        // retryable; advancing here would orphan the step.
        return 'SKIPPED';
    }

    // ── Evaluate condition predicate + branch_to_step_number ────────
    // Runs BEFORE preconditions so an explicit branch can pull the lead
    // off this step's preconditions entirely.
    if (step.condition) {
        const passes = await evaluateCondition(step.condition, cand, linkedinProfileId, sender?.account_id || null);
        // SAME policy the email resolver uses (shared decideConditionOutcome)
        // so the two channels can never diverge on what a failed condition
        // means. evaluateCondition stays LinkedIn-specific (it needs live
        // connection / email context); only the OUTCOME policy is shared.
        const outcome = decideConditionOutcome({
            conditionPassed: passes,
            branchToStepNumber: step.branch_to_step_number,
            currentStepNumber: step.step_number,
        });
        if (outcome.kind === 'branch') {
            await stepAudit.markBranched({
                organization_id: cand.organization_id, campaign_id: cand.campaign_id,
                campaign_lead_id: cand.campaign_lead_id, sequence_step_id: step.id,
                step_number: step.step_number, step_type: step.step_type,
                branched_to_step: outcome.toStepNumber,
                branch_reason: step.condition,
            });
            await jumpLeadToStep(cand, outcome.toStepNumber);
            return 'BRANCHED';
        }
        if (outcome.kind === 'skip_continue') {
            // Condition false + no usable branch → SKIP this one step and
            // CONTINUE (advanceLead moves the pointer forward by one; it
            // does NOT complete the lead). If this was the last step,
            // computeProgression inside advanceLead completes the lead by
            // running off the end — identical to the email resolver.
            await stepAudit.markSkipped({
                organization_id: cand.organization_id, campaign_id: cand.campaign_id,
                campaign_lead_id: cand.campaign_lead_id, sequence_step_id: step.id,
                step_number: step.step_number, step_type: step.step_type,
                skip_reason: `condition_false:${step.condition}`,
            });
            await advanceLead(cand, step.step_number);
            return 'SKIPPED';
        }
        // outcome.kind === 'proceed' → fall through to preconditions.
    }

    // Evaluate preconditions.
    const ctx = await buildPreconditionContext(cand, linkedinProfileId, sender?.account_id);
    const ev = evaluate(step.step_type, ctx);
    if (!ev.executable) {
        await stepAudit.markSkipped({
            organization_id: cand.organization_id, campaign_id: cand.campaign_id,
            campaign_lead_id: cand.campaign_lead_id, sequence_step_id: step.id,
            step_number: step.step_number, step_type: step.step_type,
            skip_reason: ev.skip_reason,
            sender_ref_id: sender?.account_id ?? null,
            sender_ref_type: sender ? 'linkedin_account' : null,
        });
        await advanceLead(cand, step.step_number);
        return 'SKIPPED';
    }

    // ── IDEMPOTENCY: already-delivered guard (parity with the email
    // dispatcher's SendEvent pre-send check). A SENT
    // SequenceStepExecution for this (campaign_lead_id, step_number)
    // means the step was already physically delivered - a stalled-job
    // re-run, or two ticks racing the same lead. Do NOT re-send (a
    // duplicate DM / connection request is unrecoverable). Advance the
    // lead past it via the shared guarded progression so it doesn't
    // loop, and report SKIPPED. The partial unique index
    // (campaign_lead_id, step_number) WHERE status='SENT' is the race
    // backstop if two ticks clear this check simultaneously.
    const priorSent = await prisma.sequenceStepExecution.findFirst({
        where: {
            campaign_lead_id: cand.campaign_lead_id,
            step_number: step.step_number,
            status: 'SENT',
        },
        select: { id: true },
    });
    if (priorSent) {
        logger.warn('[LINKEDIN-DISPATCHER] Step already delivered - skipping resend, advancing', {
            campaign_lead_id: cand.campaign_lead_id,
            step_number: step.step_number,
            step_type: step.step_type,
        });
        await advanceLead(cand, step.step_number);
        return 'SKIPPED';
    }

    // Mark SCHEDULED so we have a row to update on send result.
    const execId = await stepAudit.markScheduled({
        organization_id: cand.organization_id, campaign_id: cand.campaign_id,
        campaign_lead_id: cand.campaign_lead_id, sequence_step_id: step.id,
        step_number: step.step_number, step_type: step.step_type,
        sender_ref_id: sender?.account_id ?? null,
        sender_ref_type: sender ? 'linkedin_account' : null,
    });

    // All gates passed and we're committed to sending — NOW reserve the
    // sender's in-cycle capacity slot (Root Cause C: side-effect after the
    // guards, never before, so a branched/skipped/duplicate step can't
    // waste a slot for the rest of the cycle).
    if (sender && senderKind) reserveSenderSlot(sender.account_id, senderKind, cache);

    // Dispatch by step type.
    //
    // The step's true outcome is computed into `dispatchResult` by each
    // arm — never decided by control-flow fall-through. Every arm writes
    // exactly ONE terminal audit state onto the scheduled row (markSent /
    // markFailed / markSkippedExisting), so one attempt = one row and a
    // skip is never also counted as a failure. The single finalize point
    // after the try/catch is the ONLY place the lead pointer moves.
    let dispatchResult: DispatchResult = 'SENT';
    try {
        const cfg = (step.step_config as Record<string, unknown>) || {};
        switch (step.step_type) {
            case 'linkedin_connection_request': {
                if (!sender || !linkedinProfileId) throw new Error('Missing sender or profile');
                const out = await sendService.sendConnectionRequest({
                    organization_id: cand.organization_id,
                    linkedin_account_id: sender.account_id,
                    linkedin_profile_id: linkedinProfileId,
                    note: (cfg.note_template as string | undefined) || undefined,
                });
                if (out.status === 'SENT') { await stepAudit.markSent(execId); dispatchResult = 'SENT'; }
                else { await stepAudit.markFailed(execId, out.error_message || out.status); dispatchResult = 'FAILED'; }
                break;
            }
            case 'linkedin_message': {
                if (!sender || !linkedinProfileId) throw new Error('Missing sender or profile');
                const body = (cfg.body_template as string | undefined) || (cfg.fallback_message as string | undefined) || '';
                const out = await sendService.sendDirectMessage({
                    organization_id: cand.organization_id,
                    linkedin_account_id: sender.account_id,
                    linkedin_profile_id: linkedinProfileId,
                    text: body,
                });
                if (out.status === 'SENT') { await stepAudit.markSent(execId); dispatchResult = 'SENT'; }
                else { await stepAudit.markFailed(execId, out.error_message || out.status); dispatchResult = 'FAILED'; }
                break;
            }
            case 'linkedin_inmail': {
                if (!sender || !linkedinProfileId) throw new Error('Missing sender or profile');
                const out = await sendService.sendInMail({
                    organization_id: cand.organization_id,
                    linkedin_account_id: sender.account_id,
                    linkedin_profile_id: linkedinProfileId,
                    subject: (cfg.subject as string | undefined) || '',
                    body: (cfg.body as string | undefined) || '',
                });
                if (out.status === 'SENT') { await stepAudit.markSent(execId); dispatchResult = 'SENT'; }
                else { await stepAudit.markFailed(execId, out.error_message || out.status); dispatchResult = 'FAILED'; }
                break;
            }
            case 'linkedin_view_profile': {
                if (!sender || !linkedinPublicId) throw new Error('Missing sender or profile identifier');
                const acct = await prisma.linkedInAccount.findUnique({ where: { id: sender.account_id }, select: { unipile_account_id: true } });
                if (!acct) throw new Error('Sender account not found');
                await unipileChats.viewProfile(acct.unipile_account_id, linkedinPublicId);
                await prisma.linkedInAccount.update({
                    where: { id: sender.account_id },
                    data: { profile_views_today: { increment: 1 } },
                });
                await stepAudit.markSent(execId);
                dispatchResult = 'SENT';
                break;
            }
            case 'linkedin_follow': {
                if (!sender || !linkedinPublicId) throw new Error('Missing sender or profile identifier');
                const acct = await prisma.linkedInAccount.findUnique({ where: { id: sender.account_id }, select: { unipile_account_id: true } });
                if (!acct) throw new Error('Sender account not found');
                await unipileChats.followProfile(acct.unipile_account_id, linkedinPublicId);
                await prisma.linkedInAccount.update({
                    where: { id: sender.account_id },
                    data: { messages_today: { increment: 1 } },
                });
                await stepAudit.markSent(execId);
                dispatchResult = 'SENT';
                break;
            }
            case 'linkedin_like_post': {
                if (!sender || !linkedinPublicId) throw new Error('Missing sender or profile identifier');
                const acct = await prisma.linkedInAccount.findUnique({ where: { id: sender.account_id }, select: { unipile_account_id: true } });
                if (!acct) throw new Error('Sender account not found');
                const reactionType = ((cfg.reaction_type as string) || 'LIKE') as ReactionType;
                const timespanDays = Number(cfg.post_selection_timespan_days ?? 30);
                const skipIfNoPost = Boolean(cfg.skip_if_no_post);
                const since = new Date(Date.now() - timespanDays * 24 * 60 * 60 * 1000).toISOString();
                const recent = await unipileChats.listLeadRecentPosts(acct.unipile_account_id, linkedinPublicId, since);
                if (recent.length === 0) {
                    if (skipIfNoPost) {
                        // Author opted: no post → skip this step, continue.
                        // Single SCHEDULED→SKIPPED transition (one row).
                        await stepAudit.markSkippedExisting(execId, 'lead_has_recent_post');
                        dispatchResult = 'SKIPPED';
                        break;
                    }
                    // Author opted: WAIT for a post (don't skip). DEFER the
                    // SAME step and retry later — bounded by
                    // MAX_DEFER_ATTEMPTS so a lead that never posts is
                    // eventually skipped-and-continued instead of looping
                    // forever. (This is the bug the old "mark failed so it
                    // retries next cycle" comment described but never did —
                    // it advanced the lead, abandoning the step.)
                    const priorDefers = await prisma.sequenceStepExecution.count({
                        where: {
                            campaign_lead_id: cand.campaign_lead_id,
                            step_number: step.step_number,
                            skip_reason: DEFER_REASON_NO_POST,
                        },
                    });
                    if (priorDefers >= MAX_DEFER_ATTEMPTS) {
                        await stepAudit.markSkippedExisting(execId, 'no_post_after_max_retries');
                        dispatchResult = 'SKIPPED';
                    } else {
                        await stepAudit.markSkippedExisting(execId, DEFER_REASON_NO_POST);
                        dispatchResult = 'DEFER';
                    }
                    break;
                }
                await unipileChats.reactToPost(acct.unipile_account_id, recent[0].id, reactionType);
                await prisma.linkedInAccount.update({
                    where: { id: sender.account_id },
                    data: { messages_today: { increment: 1 } },
                });
                await stepAudit.markSent(execId);
                dispatchResult = 'SENT';
                break;
            }
            case 'find_email': {
                if (cand.lead_id) {
                    await runEnrichmentAgent({
                        organization_id: cand.organization_id,
                        lead_id: cand.lead_id,
                        profile: {
                            linkedin_url: cand.lead_linkedin_url || undefined,
                            email_hint: cand.lead_email,
                        },
                        trigger: 'sequence_step',
                        trigger_ref_id: execId,
                    });
                }
                await stepAudit.markSent(execId);
                dispatchResult = 'SENT';
                break;
            }
            case 'find_linkedin_url': {
                // Skip cheaply when the lead already has a URL on file -
                // this step is "best-effort fill if missing", not "force
                // re-enrich".
                if (cand.lead_linkedin_url) {
                    await stepAudit.markSkippedExisting(execId, 'lead_already_has_linkedin_url');
                    dispatchResult = 'SKIPPED';
                    break;
                }
                if (!cand.lead_id) {
                    await stepAudit.markFailed(execId, 'lead_id_missing_on_candidate');
                    dispatchResult = 'FAILED';
                    break;
                }

                // Need the lead's name + company so the providers have
                // something to query - without those most enrichment APIs
                // can't resolve a profile.
                const leadRow = await prisma.lead.findUnique({
                    where: { id: cand.lead_id },
                    select: { first_name: true, last_name: true, company: true },
                });
                const fullName = [leadRow?.first_name, leadRow?.last_name].filter(Boolean).join(' ').trim();

                const result = await runEnrichmentAgent({
                    organization_id: cand.organization_id,
                    lead_id: cand.lead_id,
                    profile: {
                        full_name: fullName || undefined,
                        company_name: leadRow?.company || undefined,
                        email_hint: cand.lead_email,
                    },
                    trigger: 'sequence_step',
                    trigger_ref_id: execId,
                    required_fields: ['linkedin_url'],
                });

                // Three outcomes:
                //   (a) no enrichment provider configured for the org
                //   (b) providers ran but none returned a URL
                //   (c) hit - persist linkedin_url onto the Lead row so
                //       downstream linkedin_* steps see it on their next tick
                if (result.no_provider_available) {
                    await stepAudit.markSkippedExisting(execId, 'no_enrichment_provider_configured');
                    dispatchResult = 'SKIPPED';
                    break;
                }

                const foundUrl = result.final_fields.linkedin_url;
                if (foundUrl) {
                    await prisma.lead.update({
                        where: { id: cand.lead_id },
                        data: { linkedin_url: foundUrl, last_activity_at: new Date() },
                    });
                    await stepAudit.markSent(execId);
                    dispatchResult = 'SENT';
                } else {
                    await stepAudit.markSkippedExisting(execId, 'linkedin_url_not_found_by_any_provider');
                    dispatchResult = 'SKIPPED';
                }
                break;
            }
            default:
                await stepAudit.markFailed(execId, `Unknown step_type: ${step.step_type}`);
                dispatchResult = 'FAILED';
        }
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await stepAudit.markFailed(execId, msg);
        dispatchResult = 'FAILED';
    }

    // ── Single finalize point — the ONLY place the pointer moves ──
    if (dispatchResult === 'DEFER') {
        // Retry the SAME step later: pointer stays put, only next_send_at
        // is pushed out. Guarded write (status='active') so a lead that
        // replied/paused since selection is not resurrected.
        await rescheduleSameStep(prisma, cand.campaign_lead_id, new Date(Date.now() + DEFER_RETRY_MS));
        return 'DEFER';
    }
    // SENT / SKIPPED / FAILED all advance: SKIPPED = skip-and-continue
    // (unified policy), FAILED advances so a hard failure doesn't trap the
    // lead forever. computeProgression completes the lead automatically if
    // this was the last step.
    await advanceLead(cand, step.step_number);
    return dispatchResult;
}

async function buildPreconditionContext(
    cand: DispatchCandidate,
    linkedinProfileId: string | null,
    accountId: string | undefined,
): Promise<PreconditionContext> {
    const ctx: PreconditionContext = {
        lead_has_email: Boolean(cand.lead_email && !cand.lead_email.endsWith('@unresolved.local')),
        lead_has_linkedin_profile: Boolean(linkedinProfileId),
        sender_is_first_degree: null,
        sender_has_inmail_credits: null,
        lead_profile_is_open: null,
        lead_has_recent_post: null,
    };

    if (linkedinProfileId && accountId) {
        const edge = await prisma.linkedInConnectionEdge.findUnique({
            where: {
                linkedin_account_id_linkedin_profile_id: {
                    linkedin_account_id: accountId, linkedin_profile_id: linkedinProfileId,
                },
            },
            select: { status: true },
        });
        ctx.sender_is_first_degree = edge?.status === 'CONNECTED';
        const acct = await prisma.linkedInAccount.findUnique({
            where: { id: accountId }, select: { account_type: true },
        });
        ctx.sender_account_type = acct?.account_type as PreconditionContext['sender_account_type'];
    }

    return ctx;
}

/**
 * Advance the lead after delivering (or skipping) step `deliveredStepNumber`.
 *
 * Routes through the SHARED progression module — same compute + same
 * guarded write as the email dispatcher. computeProgression sets
 * current_step = deliveredStepNumber (canonical: "last delivered step",
 * so the next selection resolves step deliveredStepNumber + 1) and
 * schedules next_send_at from the immediate next step's delay, or marks
 * the lead completed when none remains. writeProgression is guarded on
 * status='active' so a reply/bounce/unsubscribe landing mid-dispatch is
 * never resurrected. This replaces the old private logic that set
 * current_step = completedStepNumber + 1 (incompatible with 1-based
 * step_number selection — the every-other-step skip).
 */
async function advanceLead(cand: DispatchCandidate, deliveredStepNumber: number): Promise<void> {
    const steps = await prisma.sequenceStep.findMany({
        where: { campaign_id: cand.campaign_id },
        select: { step_number: true, delay_days: true, delay_hours: true },
    });
    const state = computeProgression({ deliveredStepNumber, steps });
    await writeProgression(prisma, cand.campaign_lead_id, state);
}

/**
 * Branch jump - condition evaluated false AND branch_to_step_number set.
 * Move the lead so the NEXT selection resolves `targetStepNumber`. Under
 * the canonical convention (selection = current_step + 1) that means
 * current_step = targetStepNumber - 1, with the target's own delay
 * applied from NOW (a branch target has its own delay; it must not fire
 * immediately). All pointer/date math goes through the shared module's
 * progressionFromNextStep so it can never diverge from the email path;
 * the write is the same guarded path; a missing target completes the
 * lead instead of looping.
 */
async function jumpLeadToStep(cand: DispatchCandidate, targetStepNumber: number): Promise<void> {
    const target = await prisma.sequenceStep.findFirst({
        where: { campaign_id: cand.campaign_id, step_number: targetStepNumber },
        select: { delay_days: true, delay_hours: true },
    });
    if (!target) {
        await completeLead(prisma, cand.campaign_lead_id);
        return;
    }
    const state = progressionFromNextStep({
        deliveredStepNumber: targetStepNumber - 1,
        nextStep: { delay_days: target.delay_days, delay_hours: target.delay_hours },
    });
    await writeProgression(prisma, cand.campaign_lead_id, state);
}

async function tick(): Promise<void> {
    totalCycles += 1;
    try {
        const candidates = await findDueCandidates();
        if (candidates.length === 0) return;

        const cache = makeCycleCache();
        const results: Record<DispatchResult, number> = { SENT: 0, SKIPPED: 0, FAILED: 0, BRANCHED: 0, DEFER: 0 };
        for (const c of candidates) {
            try {
                const r = await dispatchOne(c, cache);
                results[r]++;
            } catch (err) {
                results.FAILED++;
                logger.error('[LINKEDIN-DISPATCHER] dispatchOne crashed', err instanceof Error ? err : new Error(String(err)));
            }
        }
        totalDispatched += results.SENT;
        totalSkipped += results.SKIPPED;
        totalFailed += results.FAILED;
        logger.info('[LINKEDIN-DISPATCHER] Cycle complete', results);
        lastError = null;
    } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        logger.error('[LINKEDIN-DISPATCHER] Cycle failed', err instanceof Error ? err : new Error(lastError));
    }
}

export function scheduleLinkedInDispatcher(): void {
    if (scheduled) return;
    setTimeout(() => {
        void tick();
        scheduled = setInterval(() => { void tick(); }, RUN_INTERVAL_MS);
    }, FIRST_RUN_DELAY_MS);
    logger.info('[LINKEDIN-DISPATCHER] Scheduled', { intervalMs: RUN_INTERVAL_MS, batchSize: BATCH_SIZE });
}

export function stopLinkedInDispatcher(): void {
    if (scheduled) {
        clearInterval(scheduled);
        scheduled = null;
    }
}

export function getLinkedInDispatcherStatus() {
    return { totalCycles, totalDispatched, totalSkipped, totalFailed, lastError, scheduled: Boolean(scheduled) };
}
