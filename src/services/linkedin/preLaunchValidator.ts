/**
 * Pre-launch validation for LinkedIn-channel campaigns.
 *
 * Codifies the common-mistake checks for LinkedIn outreach + the platform
 * constraints we've researched. Returns a structured report the UI
 * surfaces before the user clicks Launch, so they can either fix or
 * acknowledge a compromise.
 *
 * Categories:
 *   ERROR   - blocking; the user cannot launch until fixed
 *   WARN    - non-blocking; the user can launch but should know
 *   INFO    - recommendation (e.g. "this account has spare capacity")
 *
 * Rules implemented:
 *   1. Sender pool capacity vs. lead count (weekly invite cap × pool size)
 *   2. Max 2 concurrent campaigns per LinkedIn account
 *   3. Connection-degree filter: refuse CR to 1st-degree, refuse DM to non-1st
 *   4. Min 7-12 day delay between CR and follow-up (warn)
 *   5. Working-hours alignment across senders in the same campaign (warn)
 *   6. Fallback messages mandatory for non-blank CRs/DMs (handled by stepTypeRegistry)
 *   7. Sequence shape rules (3h min delay, follow-before-CR, find_email once,
 *      duplicate-content) (handled by stepTypeRegistry.validateSequenceShape)
 *   8. Excluded-list overlap report (counts leads removed by exclusion filters)
 */

import { prisma } from '../../prisma';
import { validateSequenceShape, type FullStepLite } from '../sequencer/stepTypeRegistry';

export interface PreLaunchIssue {
    severity: 'ERROR' | 'WARN' | 'INFO';
    code: string;
    message: string;
    /** Optional supporting data (lead ids, sender ids, etc.) for the UI. */
    details?: Record<string, unknown>;
}

export interface PreLaunchReport {
    can_launch: boolean;
    errors: PreLaunchIssue[];
    warnings: PreLaunchIssue[];
    info: PreLaunchIssue[];
    /** Lead bucket counts the UI surfaces to the operator. */
    buckets: {
        total: number;
        no_linkedin_profile: number;
        connected_to_any_sender: number;
        not_connected: number;
    };
    /** Estimated sender capacity over the campaign's first week. */
    capacity: {
        invites_per_week_total: number;
        invites_needed: number;
        sufficient: boolean;
    };
}

interface ValidatorInput {
    organizationId: string;
    campaignId: string;
}

export async function runPreLaunchValidation(input: ValidatorInput): Promise<PreLaunchReport> {
    const errors: PreLaunchIssue[] = [];
    const warnings: PreLaunchIssue[] = [];
    const info: PreLaunchIssue[] = [];

    const campaign = await prisma.campaign.findFirst({
        where: { id: input.campaignId, organization_id: input.organizationId, deleted_at: null },
        include: {
            steps: true,
            leads: true,
            linkedinSenders: { include: { linkedin_account: true } },
        },
    });
    if (!campaign) {
        return {
            can_launch: false,
            errors: [{ severity: 'ERROR', code: 'CAMPAIGN_NOT_FOUND', message: 'Campaign not found' }],
            warnings: [], info: [],
            buckets: { total: 0, no_linkedin_profile: 0, connected_to_any_sender: 0, not_connected: 0 },
            capacity: { invites_per_week_total: 0, invites_needed: 0, sufficient: false },
        };
    }

    // ── 0. Sequence-shape checks (delegated) ──────────────────────────
    const shapeIssues = validateSequenceShape(campaign.steps as unknown as FullStepLite[]);
    for (const s of shapeIssues) {
        // Delay-floor + fallback-msg + dup are HARD blockers (ERROR).
        // Follow-before-CR and find_email-once are also blockers.
        errors.push({ severity: 'ERROR', code: 'SEQ_SHAPE', message: s.message, details: { field: s.key } });
    }

    // ── 1. Sender pool capacity ───────────────────────────────────────
    const senders = campaign.linkedinSenders.filter(s => s.enabled);
    const hasLinkedInStep = campaign.steps.some(s => s.step_type?.startsWith('linkedin_'));

    if (hasLinkedInStep && senders.length === 0) {
        errors.push({
            severity: 'ERROR', code: 'NO_LINKEDIN_SENDERS',
            message: 'Campaign has LinkedIn steps but no LinkedIn senders are attached. Add at least one account.',
        });
    }

    const weeklyCapTotal = senders.reduce((sum, s) =>
        sum + (s.linkedin_account.max_invites_per_week || 200), 0);
    const leadCount = campaign.leads.length;
    const hasCrStep = campaign.steps.some(s => s.step_type === 'linkedin_connection_request');
    const invitesNeeded = hasCrStep ? leadCount : 0; // assume 1 invite per lead on the CR step
    const capacitySufficient = invitesNeeded <= weeklyCapTotal;

    if (hasCrStep && !capacitySufficient) {
        errors.push({
            severity: 'ERROR', code: 'INSUFFICIENT_CAPACITY',
            message: `Sender pool can only send ~${weeklyCapTotal} invites/week (${senders.length} senders × 200 cap), but the campaign has ${invitesNeeded} leads. Add more senders or split the lead list.`,
            details: { weekly_cap_total: weeklyCapTotal, invites_needed: invitesNeeded },
        });
    } else if (hasCrStep && invitesNeeded > weeklyCapTotal * 0.8) {
        warnings.push({
            severity: 'WARN', code: 'TIGHT_CAPACITY',
            message: `Campaign uses ${Math.round(invitesNeeded / weeklyCapTotal * 100)}% of weekly invite capacity - slowdown risk in week 1.`,
        });
    }

    // ── 2. Max 2 concurrent campaigns per LinkedIn account ────────────
    for (const cs of senders) {
        const activeCampaignCount = await prisma.campaignLinkedInSender.count({
            where: {
                linkedin_account_id: cs.linkedin_account_id,
                enabled: true,
                campaign: { status: { in: ['active', 'ongoing', 'starting'] } },
                NOT: { campaign_id: input.campaignId },
            },
        });
        if (activeCampaignCount >= 2) {
            warnings.push({
                severity: 'WARN', code: 'TOO_MANY_CAMPAIGNS_PER_ACCOUNT',
                message: `Account "${cs.linkedin_account.display_name}" is already in ${activeCampaignCount} active campaigns. We recommend max 2 - daily caps get divided across campaigns, slowing all of them.`,
                details: { account_id: cs.linkedin_account_id, active_count: activeCampaignCount },
            });
        }
    }

    // ── 3. Connection-degree filter (preflight bucketing) ─────────────
    const buckets = {
        total: campaign.leads.length,
        no_linkedin_profile: 0,
        connected_to_any_sender: 0,
        not_connected: 0,
    };
    if (hasLinkedInStep && campaign.leads.length > 0) {
        const senderAccountIds = senders.map(s => s.linkedin_account_id);
        const leadEmails = campaign.leads.map(l => l.email);
        const leadsWithProfiles = await prisma.lead.findMany({
            where: {
                organization_id: input.organizationId,
                email: { in: leadEmails },
            },
            select: { id: true, linkedin_url: true, email: true },
        });
        const linkedinUrls = leadsWithProfiles.map(l => l.linkedin_url).filter(Boolean) as string[];

        // Bucket 1: leads with no LinkedIn URL on file
        const leadsWithoutLi = leadsWithProfiles.filter(l => !l.linkedin_url).length
            + (campaign.leads.length - leadsWithProfiles.length);
        buckets.no_linkedin_profile = leadsWithoutLi;

        // Bucket 2 + 3: hydrate connection-edge status
        if (linkedinUrls.length > 0 && senderAccountIds.length > 0) {
            const slugs = linkedinUrls
                .map(u => u.match(/\/in\/([^\/\?]+)/)?.[1])
                .filter(Boolean) as string[];

            const profiles = await prisma.linkedInProfile.findMany({
                where: { organization_id: input.organizationId, public_identifier: { in: slugs } },
                select: { id: true, public_identifier: true },
            });

            const edges = await prisma.linkedInConnectionEdge.findMany({
                where: {
                    linkedin_account_id: { in: senderAccountIds },
                    linkedin_profile_id: { in: profiles.map(p => p.id) },
                    status: 'CONNECTED',
                },
                select: { linkedin_profile_id: true },
            });
            const connectedProfileIds = new Set(edges.map(e => e.linkedin_profile_id));
            const connectedCount = profiles.filter(p => connectedProfileIds.has(p.id)).length;
            buckets.connected_to_any_sender = connectedCount;
            buckets.not_connected = slugs.length - connectedCount;
        }

        if (buckets.no_linkedin_profile > 0) {
            warnings.push({
                severity: 'WARN', code: 'LEADS_MISSING_LINKEDIN',
                message: `${buckets.no_linkedin_profile} of ${buckets.total} leads have no LinkedIn profile on file - their LinkedIn steps will be skipped (email steps continue).`,
                details: { count: buckets.no_linkedin_profile },
            });
        }

        // Degree-mismatch check: if a step expects 1st-degree (DM/InMail)
        // but no leads are connected, it'll skip 100% of leads.
        const hasDmStep = campaign.steps.some(s => s.step_type === 'linkedin_message');
        if (hasDmStep && buckets.connected_to_any_sender === 0 && buckets.total > 0) {
            warnings.push({
                severity: 'WARN', code: 'NO_CONNECTED_LEADS',
                message: 'Sequence contains a LinkedIn DM step but NO leads are currently 1st-degree connections of the senders. The DM step will skip every lead unless they accept a Connection Request earlier in the sequence.',
            });
        }
    }

    // ── 4. CR → followup delay window (7-12 days recommended) ─────────
    const sortedSteps = [...campaign.steps].sort((a, b) => a.step_number - b.step_number);
    for (let i = 0; i < sortedSteps.length - 1; i++) {
        if (sortedSteps[i].step_type !== 'linkedin_connection_request') continue;
        const next = sortedSteps[i + 1];
        const dayGap = (next.delay_days || 0) + Math.floor((next.delay_hours || 0) / 24);
        if (dayGap < 7) {
            warnings.push({
                severity: 'WARN', code: 'CR_FOLLOWUP_TOO_SOON',
                message: `Step ${next.step_number} fires ${dayGap}d after the connection request. We recommend 7-12 days - leads need time to accept; sub-7d windows move accepters out of the follow-up.`,
                details: { step_number: next.step_number, day_gap: dayGap },
            });
        }
    }

    // ── 4b. InMail step + sender tier discipline ─────────────────────
    // LinkedIn's InMail feature is tier-gated:
    //   CLASSIC    - no InMail support at all
    //   PREMIUM    - 5/month (Career) or 15/month (Business)
    //   SALES_NAV  - ~50/month
    //   RECRUITER  - 30+ (Lite) / 150+ (full)
    //
    // If the campaign has an InMail step, every CLASSIC sender in the pool
    // will skip 100% of leads on that step - block launch and tell the
    // operator which accounts need upgrading or removing. Premium senders
    // mixed with Sales Nav / Recruiter is a WARN, not an error: the
    // dispatcher will route through the higher-tier accounts first but
    // the operator should know their daily-cap math is uneven.
    const hasInMailStep = campaign.steps.some(s => s.step_type === 'linkedin_inmail');
    if (hasInMailStep && senders.length > 0) {
        const classicSenders = senders.filter(s =>
            s.linkedin_account.account_type === 'CLASSIC',
        );
        if (classicSenders.length > 0) {
            errors.push({
                severity: 'ERROR', code: 'INMAIL_REQUIRES_PAID_TIER',
                message: `Sequence has an InMail step but ${classicSenders.length} of ${senders.length} senders are Classic (free) accounts - Classic accounts can't send InMail. Upgrade these accounts to Premium, Sales Navigator, or Recruiter, or remove them from the sender pool: ${classicSenders.map(c => `"${c.linkedin_account.display_name}"`).join(', ')}.`,
                details: { classic_sender_count: classicSenders.length, classic_sender_ids: classicSenders.map(c => c.linkedin_account_id) },
            });
        }
        const tiers = new Set(senders.map(s => s.linkedin_account.account_type));
        if (classicSenders.length === 0 && tiers.size > 1) {
            warnings.push({
                severity: 'WARN', code: 'INMAIL_MIXED_TIERS',
                message: 'Sender pool mixes account tiers (Premium / Sales Navigator / Recruiter). Daily InMail caps differ per tier - Premium senders will exhaust their 5-15/month allotment far sooner than Sales Nav (~50/month) or Recruiter (150+/month). Consider isolating tiers across separate campaigns for steady throughput.',
                details: { tiers: Array.from(tiers) },
            });
        }
    }

    // ── 5. Working-hours alignment across senders ─────────────────────
    if (senders.length > 1) {
        const wh = senders.map(s => JSON.stringify(s.working_hours ?? null));
        if (new Set(wh).size > 1) {
            warnings.push({
                severity: 'WARN', code: 'WORKING_HOURS_MISMATCH',
                message: 'Senders in this campaign have different working hours / timezones. This can prevent the campaign from hitting its daily targets.',
            });
        }
    }

    // ── 6. Suggestion: no LinkedIn senders attached but no LI steps ───
    if (!hasLinkedInStep && senders.length > 0) {
        info.push({
            severity: 'INFO', code: 'UNUSED_LI_SENDERS',
            message: 'LinkedIn senders are attached but the sequence has no LinkedIn steps. Senders won’t be used.',
        });
    }

    return {
        can_launch: errors.length === 0,
        errors, warnings, info,
        buckets,
        capacity: {
            invites_per_week_total: weeklyCapTotal,
            invites_needed: invitesNeeded,
            sufficient: capacitySufficient,
        },
    };
}
