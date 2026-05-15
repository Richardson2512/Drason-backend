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
import * as stepAudit from '../services/sequencer/stepExecutionAudit';
import * as sendService from '../services/linkedin/sendService';
import { runEnrichmentAgent } from '../services/agents/enrichmentAgent';
import { chats as unipileChats } from '../services/unipile';
import type { ReactionType } from '../services/unipile';

const RUN_INTERVAL_MS = 60 * 1000;
const FIRST_RUN_DELAY_MS = 60 * 1000;
const BATCH_SIZE = 200;

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
 * Goal: stop pickSender from re-fetching `CampaignLinkedInSender +
 * LinkedInAccount` rows for every candidate. On a 200-candidate cycle
 * across 10 campaigns the naïve path issued 200 sender-pool queries.
 *
 * Cache rules:
 *   - Sender pool per campaign is loaded once at cycle start (lazy on
 *     first dispatch for that campaign). Static fields (max caps,
 *     account_type, working_hours, rotation_priority) are snapshot.
 *   - Live capacity is tracked in `usedThisCycle` keyed by
 *     (account_id, kind). Initial values come from the DB counters
 *     (invites_today / messages_today / inmails_today). Each successful
 *     pickSender increments the in-memory counter so two candidates in
 *     the same cycle can't double-book a sender that only has one slot
 *     left. The DB counters are still authoritative across cycles -
 *     sendService writes them, the next cycle reads fresh values.
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
     *  successful pickSender calls within this cycle. */
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

        // Pre-filter to leads whose next step is owned by this dispatcher.
        // Derived from STEP_TYPES via isLinkedInDispatcherStep() so a newly
        // registered LinkedIn or utility step automatically becomes
        // dispatchable - no risk of the filter and the dispatch switch
        // below drifting out of sync (which is exactly how `find_email`
        // ended up silently broken before this refactor).
        const eligible = leads.filter(l => {
            const next = steps[l.current_step];
            return Boolean(next && isLinkedInDispatcherStep(next.step_type));
        });
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
            const nextStep = steps[l.current_step];
            const lead = leadByEmail.get(l.email);
            candidates.push({
                campaign_id: c.id,
                organization_id: c.organization_id,
                campaign_lead_id: l.id,
                lead_id: lead?.id ?? null,
                lead_email: l.email,
                lead_linkedin_url: lead?.linkedin_url || null,
                next_step_number: nextStep.step_number,
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
 * Pick an enabled sender from the campaign's pool that has remaining
 * capacity AND is within its working-hours window. NULL when no sender
 * qualifies (caller writes a SKIPPED audit row).
 *
 * Cache-aware: the sender pool is loaded once per campaign per cycle,
 * and capacity is decremented in-memory on a successful pick so a
 * second candidate in the same cycle sees the slot already taken. The
 * actual DB counter increments happen later inside sendService -
 * across cycles, the DB is authoritative.
 */
async function pickSender(
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

        // Reserve the slot in this cycle so the next candidate sees it
        // consumed. The DB counters update through sendService on actual
        // dispatch - on the next cycle (60s) those updates plus this
        // reservation will agree.
        if (kind === 'invite') {
            usage.invites += 1;
            usage.invites_this_week += 1;
        } else if (kind === 'message') {
            usage.messages += 1;
        } else {
            usage.inmails += 1;
        }
        return { id: s.sender_id, account_id: s.account_id };
    }
    return null;
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

async function dispatchOne(cand: DispatchCandidate, cache: CycleCache): Promise<'SENT' | 'SKIPPED' | 'FAILED' | 'BRANCHED'> {
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

    const sender = senderKind ? await pickSender(cand.campaign_id, senderKind, cache) : null;
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
        if (!passes) {
            if (step.branch_to_step_number != null) {
                await stepAudit.markBranched({
                    organization_id: cand.organization_id, campaign_id: cand.campaign_id,
                    campaign_lead_id: cand.campaign_lead_id, sequence_step_id: step.id,
                    step_number: step.step_number, step_type: step.step_type,
                    branched_to_step: step.branch_to_step_number,
                    branch_reason: step.condition,
                });
                await jumpLeadToStep(cand, step.branch_to_step_number);
                return 'BRANCHED';
            }
            // Condition false + no branch target = drop out of the
            // sequence entirely (mark lead completed).
            await stepAudit.markSkipped({
                organization_id: cand.organization_id, campaign_id: cand.campaign_id,
                campaign_lead_id: cand.campaign_lead_id, sequence_step_id: step.id,
                step_number: step.step_number, step_type: step.step_type,
                skip_reason: `condition_false:${step.condition}`,
            });
            await advanceLead(cand, step.step_number);
            return 'SKIPPED';
        }
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

    // Mark SCHEDULED so we have a row to update on send result.
    const execId = await stepAudit.markScheduled({
        organization_id: cand.organization_id, campaign_id: cand.campaign_id,
        campaign_lead_id: cand.campaign_lead_id, sequence_step_id: step.id,
        step_number: step.step_number, step_type: step.step_type,
        sender_ref_id: sender?.account_id ?? null,
        sender_ref_type: sender ? 'linkedin_account' : null,
    });

    // Dispatch by step type.
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
                if (out.status === 'SENT') await stepAudit.markSent(execId);
                else await stepAudit.markFailed(execId, out.error_message || out.status);
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
                if (out.status === 'SENT') await stepAudit.markSent(execId);
                else await stepAudit.markFailed(execId, out.error_message || out.status);
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
                if (out.status === 'SENT') await stepAudit.markSent(execId);
                else await stepAudit.markFailed(execId, out.error_message || out.status);
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
                        await stepAudit.markSkipped({
                            organization_id: cand.organization_id, campaign_id: cand.campaign_id,
                            campaign_lead_id: cand.campaign_lead_id, sequence_step_id: step.id,
                            step_number: step.step_number, step_type: step.step_type,
                            skip_reason: 'lead_has_recent_post',
                            sender_ref_id: sender.account_id, sender_ref_type: 'linkedin_account',
                        });
                        // markScheduled was already written; flip to SKIPPED
                        // by failing it with the skip reason so the row reflects truth.
                        await stepAudit.markFailed(execId, 'skipped:lead_has_recent_post');
                        break;
                    }
                    // Without skip_if_no_post, mark as failed so the dispatcher
                    // retries next cycle (post may have been published since).
                    await stepAudit.markFailed(execId, 'no_recent_post_to_react_to');
                    break;
                }
                await unipileChats.reactToPost(acct.unipile_account_id, recent[0].id, reactionType);
                await prisma.linkedInAccount.update({
                    where: { id: sender.account_id },
                    data: { messages_today: { increment: 1 } },
                });
                await stepAudit.markSent(execId);
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
                break;
            }
            case 'find_linkedin_url': {
                // Skip cheaply when the lead already has a URL on file -
                // this step is "best-effort fill if missing", not "force
                // re-enrich".
                if (cand.lead_linkedin_url) {
                    await stepAudit.markSkipped({
                        organization_id: cand.organization_id, campaign_id: cand.campaign_id,
                        campaign_lead_id: cand.campaign_lead_id, sequence_step_id: step.id,
                        step_number: step.step_number, step_type: step.step_type,
                        skip_reason: 'lead_already_has_linkedin_url',
                    });
                    await stepAudit.markFailed(execId, 'skipped:lead_already_has_linkedin_url');
                    break;
                }
                if (!cand.lead_id) {
                    await stepAudit.markFailed(execId, 'lead_id_missing_on_candidate');
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
                    await stepAudit.markSkipped({
                        organization_id: cand.organization_id, campaign_id: cand.campaign_id,
                        campaign_lead_id: cand.campaign_lead_id, sequence_step_id: step.id,
                        step_number: step.step_number, step_type: step.step_type,
                        skip_reason: 'no_enrichment_provider_configured',
                    });
                    await stepAudit.markFailed(execId, 'skipped:no_enrichment_provider_configured');
                    break;
                }

                const foundUrl = result.final_fields.linkedin_url;
                if (foundUrl) {
                    await prisma.lead.update({
                        where: { id: cand.lead_id },
                        data: { linkedin_url: foundUrl, last_activity_at: new Date() },
                    });
                    await stepAudit.markSent(execId);
                } else {
                    await stepAudit.markSkipped({
                        organization_id: cand.organization_id, campaign_id: cand.campaign_id,
                        campaign_lead_id: cand.campaign_lead_id, sequence_step_id: step.id,
                        step_number: step.step_number, step_type: step.step_type,
                        skip_reason: 'linkedin_url_not_found_by_any_provider',
                    });
                    await stepAudit.markFailed(execId, 'skipped:linkedin_url_not_found_by_any_provider');
                }
                break;
            }
            default:
                await stepAudit.markFailed(execId, `Unknown step_type: ${step.step_type}`);
        }
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await stepAudit.markFailed(execId, msg);
        await advanceLead(cand, step.step_number);
        return 'FAILED';
    }

    await advanceLead(cand, step.step_number);
    return 'SENT';
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

async function advanceLead(cand: DispatchCandidate, completedStepNumber: number): Promise<void> {
    // Move to the next step. Find its delay and set next_send_at.
    const next = await prisma.sequenceStep.findFirst({
        where: { campaign_id: cand.campaign_id, step_number: completedStepNumber + 1 },
    });
    if (!next) {
        // No more steps - mark lead completed.
        await prisma.campaignLead.update({
            where: { id: cand.campaign_lead_id },
            data: { status: 'completed', current_step: completedStepNumber + 1 },
        });
        return;
    }
    const delayMs = (next.delay_days * 24 + next.delay_hours) * 60 * 60 * 1000;
    await prisma.campaignLead.update({
        where: { id: cand.campaign_lead_id },
        data: {
            current_step: completedStepNumber + 1,
            next_send_at: new Date(Date.now() + delayMs),
            last_sent_at: new Date(),
        },
    });
}

/**
 * Branch jump - used when a step's condition evaluates false AND
 * branch_to_step_number is set. We move the lead to the target step
 * with that step's own delay applied from NOW (the branch target
 * shouldn't fire immediately - it has its own delay relative to the
 * branching step's intended fire date).
 */
async function jumpLeadToStep(cand: DispatchCandidate, targetStepNumber: number): Promise<void> {
    const target = await prisma.sequenceStep.findFirst({
        where: { campaign_id: cand.campaign_id, step_number: targetStepNumber },
    });
    if (!target) {
        // Branch target missing - mark completed rather than loop.
        await prisma.campaignLead.update({
            where: { id: cand.campaign_lead_id },
            data: { status: 'completed', current_step: targetStepNumber },
        });
        return;
    }
    const delayMs = (target.delay_days * 24 + target.delay_hours) * 60 * 60 * 1000;
    await prisma.campaignLead.update({
        where: { id: cand.campaign_lead_id },
        data: {
            current_step: targetStepNumber,
            next_send_at: new Date(Date.now() + delayMs),
        },
    });
}

async function tick(): Promise<void> {
    totalCycles += 1;
    try {
        const candidates = await findDueCandidates();
        if (candidates.length === 0) return;

        const cache = makeCycleCache();
        const results = { SENT: 0, SKIPPED: 0, FAILED: 0, BRANCHED: 0 };
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
