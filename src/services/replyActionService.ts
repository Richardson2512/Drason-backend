/**
 * Reply action executor — applies per-org auto-actions configured against
 * reply quality classes.
 *
 * Inputs: the classified reply (final class after AI re-classification) +
 * thread context (org, lead, campaign).
 *
 * Outputs: side effects only — logs each action taken so the operator can
 * audit later. Never throws on individual action failure — one broken
 * action shouldn't block the rest of the IMAP worker's processing.
 *
 * Action kinds:
 *   'suppress'   — add to OrgReplySuppression. Future campaign creates +
 *                  addLeads consult this list and drop matching emails.
 *   'pause_lead' — set CampaignLead.status='paused', clear next_send_at.
 *   'alert'      — create a Notification row for the org owner.
 */

import { prisma } from '../prisma';
import { logger } from './observabilityService';
import { pauseCrossChannelForLead } from './crossChannelSuppressionService';

export interface ReplyActionContext {
    organizationId: string;
    threadId: string;
    contactEmail: string;
    /** Resolved final class (post-AI). 'unclassified' is allowed but no
     *  action will match it by default. */
    replyClass: string;
    /** Optional — when present we'll also pause the lead in this campaign. */
    campaignId?: string | null;
    /** Optional — when present, we fan into cross-channel suppression so
     *  the lead's LinkedIn-side enrollments are paused per the org's
     *  configured mode (OFF / HARD / CLASSIFIED / ASYMMETRIC). */
    leadId?: string | null;
}

/** Default ruleset used the first time an organization receives a reply.
 *  Operators can edit the rows via the settings page; these are the seed
 *  defaults we apply if no row exists yet for that (org, class, action). */
const DEFAULT_RULES: Array<{ reply_class: string; action_kind: string; enabled: boolean }> = [
    { reply_class: 'hard_no', action_kind: 'suppress', enabled: true },
    { reply_class: 'hard_no', action_kind: 'pause_lead', enabled: true },
    { reply_class: 'angry', action_kind: 'suppress', enabled: true },
    { reply_class: 'angry', action_kind: 'alert', enabled: true },
    { reply_class: 'positive', action_kind: 'alert', enabled: true },
    { reply_class: 'qualified', action_kind: 'alert', enabled: true },
    // 'auto' (OOO) is handled separately via CampaignLead.ooo_until in the
    // dispatcher — not via this auto-action path. We deliberately leave
    // it off the defaults here to avoid double-pausing.
];

/** Ensure default rules exist for an org. Idempotent — uses createMany
 *  with skipDuplicates so re-running just no-ops. */
async function ensureDefaultRules(organizationId: string): Promise<void> {
    const existing = await prisma.replyActionConfig.count({
        where: { organization_id: organizationId },
    });
    if (existing > 0) return;
    await prisma.replyActionConfig.createMany({
        data: DEFAULT_RULES.map(r => ({ ...r, organization_id: organizationId })),
        skipDuplicates: true,
    });
}

/** List rules for an org. Lazily seeds defaults on first call. */
export async function listRules(organizationId: string) {
    await ensureDefaultRules(organizationId);
    return prisma.replyActionConfig.findMany({
        where: { organization_id: organizationId },
        orderBy: [{ reply_class: 'asc' }, { action_kind: 'asc' }],
    });
}

export async function upsertRule(input: {
    organizationId: string;
    replyClass: string;
    actionKind: string;
    enabled: boolean;
}): Promise<void> {
    await prisma.replyActionConfig.upsert({
        where: {
            organization_id_reply_class_action_kind: {
                organization_id: input.organizationId,
                reply_class: input.replyClass,
                action_kind: input.actionKind,
            },
        },
        create: {
            organization_id: input.organizationId,
            reply_class: input.replyClass,
            action_kind: input.actionKind,
            enabled: input.enabled,
        },
        update: { enabled: input.enabled },
    });
}

// ────────────────────────────────────────────────────────────────────
// Apply
// ────────────────────────────────────────────────────────────────────

/**
 * Run every enabled rule matching this reply's class. Side effects only;
 * no throw on partial failure.
 */
export async function applyReplyActions(ctx: ReplyActionContext): Promise<void> {
    if (!ctx.replyClass || ctx.replyClass === 'unclassified') return;

    await ensureDefaultRules(ctx.organizationId);

    const rules = await prisma.replyActionConfig.findMany({
        where: {
            organization_id: ctx.organizationId,
            reply_class: ctx.replyClass,
            enabled: true,
        },
    });
    if (rules.length === 0) return;

    for (const rule of rules) {
        try {
            switch (rule.action_kind) {
                case 'suppress':
                    await prisma.orgReplySuppression.upsert({
                        where: {
                            organization_id_email: {
                                organization_id: ctx.organizationId,
                                email: ctx.contactEmail.toLowerCase(),
                            },
                        },
                        create: {
                            organization_id: ctx.organizationId,
                            email: ctx.contactEmail.toLowerCase(),
                            reason: `reply_${ctx.replyClass}`,
                            source_thread_id: ctx.threadId,
                        },
                        update: { reason: `reply_${ctx.replyClass}`, source_thread_id: ctx.threadId },
                    });
                    logger.info('[REPLY_ACTION] Suppressed', { email: ctx.contactEmail, class: ctx.replyClass });
                    break;

                case 'pause_lead':
                    if (ctx.campaignId) {
                        // Only pause the specific lead, not the entire campaign.
                        // updateMany scoped on email+campaign so no cross-tenant write.
                        const r = await prisma.campaignLead.updateMany({
                            where: {
                                campaign_id: ctx.campaignId,
                                email: ctx.contactEmail,
                                status: { notIn: ['paused', 'replied', 'unsubscribed', 'bounced'] },
                            },
                            data: { status: 'paused', next_send_at: null },
                        });
                        if (r.count > 0) {
                            logger.info('[REPLY_ACTION] Paused lead', {
                                email: ctx.contactEmail, campaignId: ctx.campaignId, class: ctx.replyClass,
                            });
                        }
                    }
                    break;

                case 'alert':
                    // Deep-link the notification to the exact thread so the
                    // operator can click through instead of searching the
                    // Unibox. action_url is consumed by the notification
                    // dropdown component; entity_type/entity_id let the
                    // Unibox row badge unread alerts per-thread.
                    await prisma.notification.create({
                        data: {
                            organization_id: ctx.organizationId,
                            type: ctx.replyClass === 'angry' ? 'WARNING' : 'INFO',
                            title: `Reply classified as ${ctx.replyClass}`,
                            message: `${ctx.contactEmail} replied with a "${ctx.replyClass}" reply. Review in Unibox.`,
                            action_url: `/dashboard/sequencer/unibox?thread=${ctx.threadId}`,
                            entity_type: 'email_thread',
                            entity_id: ctx.threadId,
                        },
                    });
                    break;

                default:
                    logger.warn('[REPLY_ACTION] Unknown action_kind, skipping', { kind: rule.action_kind });
            }
        } catch (err) {
            logger.warn('[REPLY_ACTION] Single action failed (non-fatal)', {
                rule: rule.action_kind,
                class: ctx.replyClass,
                err: err instanceof Error ? err.message : String(err),
            });
        }
    }

    // Cross-channel fan-out — pause LinkedIn enrollments for this lead if
    // the org's suppression mode says so. Per-mode policy lives in the
    // service. Email is the canonical key for CampaignLead so we always
    // pass it through; lead_id is optional context for the audit log.
    try {
        let leadId = ctx.leadId ?? null;
        if (!leadId && ctx.contactEmail) {
            const lead = await prisma.lead.findFirst({
                where: { organization_id: ctx.organizationId, email: ctx.contactEmail.toLowerCase() },
                select: { id: true },
            });
            leadId = lead?.id ?? null;
        }
        if (leadId || ctx.contactEmail) {
            await pauseCrossChannelForLead({
                organizationId: ctx.organizationId,
                leadId: leadId ?? '', // can be empty when email is provided
                contactEmail: ctx.contactEmail,
                source: 'email',
                replyClass: ctx.replyClass,
                reason: `email reply: ${ctx.replyClass}`,
            });
        }
    } catch (err) {
        logger.warn('[REPLY_ACTION] cross-channel suppression skipped (non-fatal)', {
            err: err instanceof Error ? err.message : String(err),
        });
    }
}

/** Check the org-wide reply suppression list. Used by both the
 *  sequencer dispatch path and the campaign-create lead intake to
 *  drop emails that have replied negatively in the past. */
export async function isOrgSuppressed(organizationId: string, email: string): Promise<boolean> {
    const norm = email.trim().toLowerCase();
    if (!norm) return false;
    const row = await prisma.orgReplySuppression.findUnique({
        where: { organization_id_email: { organization_id: organizationId, email: norm } },
        select: { id: true },
    });
    return Boolean(row);
}

/** Bulk variant — used by lead-import flows. */
export async function getSuppressedEmailSet(organizationId: string, emails: string[]): Promise<Set<string>> {
    if (emails.length === 0) return new Set();
    const lower = Array.from(new Set(emails.map(e => e.trim().toLowerCase()).filter(Boolean)));
    if (lower.length === 0) return new Set();
    const rows = await prisma.orgReplySuppression.findMany({
        where: { organization_id: organizationId, email: { in: lower } },
        select: { email: true },
    });
    return new Set(rows.map(r => r.email.toLowerCase()));
}
