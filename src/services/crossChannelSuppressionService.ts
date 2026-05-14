/**
 * Cross-channel suppression — when a lead replies on one channel (email or
 * LinkedIn), this decides whether the OTHER channel's active enrollments
 * for the same lead should auto-pause.
 *
 * Four configurable modes (per Organization.cross_channel_suppression_mode):
 *
 *   OFF         — never pause cross-channel; each channel handles its own
 *                 reply. Useful when teams explicitly nurture multi-channel.
 *
 *   HARD        — any reply on any channel pauses every active enrollment
 *                 for that lead. Most conservative, prevents multi-channel
 *                 pestering after any signal of engagement.
 *
 *   CLASSIFIED  — only pause cross-channel when the reply is classified as
 *                 'positive' | 'qualified' | 'hard_no' | 'angry'. Generic,
 *                 auto-replies, soft_no, objection, referral stay
 *                 channel-scoped. Default.
 *
 *   ASYMMETRIC  — email replies ALWAYS pause LinkedIn (formal reply on
 *                 email = explicit signal). LinkedIn replies only pause
 *                 email when they classify as CLASSIFIED-worthy (positive,
 *                 qualified, hard_no, angry). Reflects how teams typically
 *                 treat email as the high-intent channel.
 *
 * Both reply handlers fan into `pauseCrossChannelForLead` after resolving a
 * single `lead_id`. The service decides per-mode whether to pause and what
 * to pause. All writes are idempotent.
 */

import { prisma } from '../prisma';
import { logger } from './observabilityService';

export type SuppressionMode = 'OFF' | 'HARD' | 'CLASSIFIED' | 'ASYMMETRIC';

// Classes that count as "intent-bearing" for CLASSIFIED + ASYMMETRIC paths.
// Mirrors the 9-class taxonomy from the Kimi reply classifier. We pause on
// the four classes that carry a clear yes/no signal; everything else
// (generic, auto, soft_no, objection, referral, unclassified) is too noisy
// to justify silencing the other channel.
const INTENT_CLASSES = new Set(['positive', 'qualified', 'hard_no', 'angry']);

export interface SuppressionInput {
    organizationId: string;
    /** lead_id from the Lead table — the canonical cross-channel identity.
     *  Used to resolve the lead's email when one isn't provided directly. */
    leadId: string;
    /** Optional contact email. When omitted we look it up from `leadId`.
     *  CampaignLead is identified by `email` (not `lead_id`) so we need
     *  one or the other to fan out across enrollments. */
    contactEmail?: string | null;
    /** Which channel triggered the suppression. */
    source: 'email' | 'linkedin';
    /** Reply class from the classifier. Required for CLASSIFIED + ASYMMETRIC
     *  modes; ignored in HARD; never reached in OFF. */
    replyClass?: string | null;
    /** Free-text context for audit logs. */
    reason?: string;
}

interface SuppressionResult {
    mode: SuppressionMode;
    decision: 'paused' | 'skipped';
    skipReason?: string;
    pausedEnrollments: number;
}

/**
 * Fetch the org's configured suppression mode. Defaults to 'CLASSIFIED' if
 * the org was created before this column existed or if the field is null.
 */
export async function getSuppressionMode(organizationId: string): Promise<SuppressionMode> {
    const org = await prisma.organization.findUnique({
        where: { id: organizationId },
        select: { cross_channel_suppression_mode: true } as { cross_channel_suppression_mode: true },
    } as { where: { id: string }; select: Record<string, true> }) as { cross_channel_suppression_mode?: string | null } | null;
    const raw = org?.cross_channel_suppression_mode ?? 'CLASSIFIED';
    if (raw === 'OFF' || raw === 'HARD' || raw === 'CLASSIFIED' || raw === 'ASYMMETRIC') return raw;
    return 'CLASSIFIED';
}

export async function setSuppressionMode(organizationId: string, mode: SuppressionMode): Promise<void> {
    await prisma.organization.update({
        where: { id: organizationId },
        data: { cross_channel_suppression_mode: mode } as { cross_channel_suppression_mode: string },
    } as { where: { id: string }; data: Record<string, string> });
}

/**
 * Decide whether to pause the OPPOSITE channel given the configured mode +
 * the reply context. Pure function — no I/O, easy to unit-test.
 */
export function shouldPauseOtherChannel(
    mode: SuppressionMode,
    source: 'email' | 'linkedin',
    replyClass: string | null | undefined,
): { pause: boolean; reason: string } {
    switch (mode) {
        case 'OFF':
            return { pause: false, reason: 'mode is OFF' };

        case 'HARD':
            return { pause: true, reason: 'mode is HARD — any reply pauses both channels' };

        case 'CLASSIFIED': {
            if (!replyClass) return { pause: false, reason: 'no reply class provided to CLASSIFIED mode' };
            const norm = replyClass.toLowerCase();
            if (INTENT_CLASSES.has(norm)) return { pause: true, reason: `class=${norm} carries intent` };
            return { pause: false, reason: `class=${norm} is not intent-bearing (CLASSIFIED skips noisy classes)` };
        }

        case 'ASYMMETRIC': {
            if (source === 'email') return { pause: true, reason: 'ASYMMETRIC always pauses LinkedIn on email reply' };
            // LinkedIn → email: same intent test as CLASSIFIED
            if (!replyClass) return { pause: false, reason: 'ASYMMETRIC LinkedIn→email needs a reply class' };
            const norm = replyClass.toLowerCase();
            if (INTENT_CLASSES.has(norm)) return { pause: true, reason: `LinkedIn class=${norm} pauses email under ASYMMETRIC` };
            return { pause: false, reason: `LinkedIn class=${norm} not intent-bearing — email stays running under ASYMMETRIC` };
        }
    }
}

/**
 * Main entry point — called by reply handlers after they resolve a
 * `lead_id`. Reads the configured mode, evaluates the policy, and (if the
 * policy says pause) pauses every active CampaignLead enrollment for the
 * lead OTHER than the one in the source campaign.
 *
 * "Pausing" sets CampaignLead.status='paused' and clears next_send_at so
 * the dispatcher won't fire. The lead can be manually un-paused via the
 * leads UI.
 *
 * Note: this fans across BOTH email-only and linkedin-only campaigns.
 * CampaignLead is channel-agnostic — what determines the channel is the
 * SequenceStep.step_type inside each campaign — so pausing the lead's
 * CampaignLead row in a LinkedIn campaign correctly stops the LinkedIn
 * dispatcher and vice versa.
 */
export async function pauseCrossChannelForLead(input: SuppressionInput): Promise<SuppressionResult> {
    const mode = await getSuppressionMode(input.organizationId);
    const decision = shouldPauseOtherChannel(mode, input.source, input.replyClass);

    if (!decision.pause) {
        logger.info('[CROSS-CHANNEL-SUPPRESS] skipped', {
            mode,
            source: input.source,
            leadId: input.leadId,
            replyClass: input.replyClass ?? null,
            reason: decision.reason,
        });
        return { mode, decision: 'skipped', skipReason: decision.reason, pausedEnrollments: 0 };
    }

    // CampaignLead is identified by email (not lead_id), so resolve the
    // lead's email if the caller didn't pass it directly.
    let email = input.contactEmail?.toLowerCase() ?? null;
    if (!email && input.leadId) {
        const lead = await prisma.lead.findUnique({
            where: { id: input.leadId },
            select: { email: true, organization_id: true },
        });
        if (!lead || lead.organization_id !== input.organizationId) {
            return { mode, decision: 'skipped', skipReason: 'lead not found in org', pausedEnrollments: 0 };
        }
        email = lead.email.toLowerCase();
    }
    if (!email) {
        return { mode, decision: 'skipped', skipReason: 'no email or lead id provided', pausedEnrollments: 0 };
    }

    // Pause every active CampaignLead for this email within this org,
    // EXCEPT those already in a terminal state. The replying campaign's own
    // CampaignLead is paused via the per-channel reply-action rule; this
    // fan-out adds the OTHER channel's enrollments. updateMany scopes via
    // the parent Campaign.organization_id so we never touch other tenants.
    const result = await prisma.campaignLead.updateMany({
        where: {
            email,
            campaign: { organization_id: input.organizationId },
            status: { notIn: ['paused', 'replied', 'unsubscribed', 'bounced', 'opted_out', 'completed'] },
        },
        data: {
            status: 'paused',
            next_send_at: null,
        },
    });

    logger.info('[CROSS-CHANNEL-SUPPRESS] paused', {
        mode,
        source: input.source,
        leadId: input.leadId,
        replyClass: input.replyClass ?? null,
        pausedEnrollments: result.count,
        reason: decision.reason,
    });

    return { mode, decision: 'paused', pausedEnrollments: result.count };
}
