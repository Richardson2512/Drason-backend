/**
 * Profile promotion service - the canonical path from "we identified a
 * LinkedIn profile worth pursuing" to "the lead is in the CRM, enriched,
 * has an AI opener, and is enrolled in the right campaign / cold-call
 * list." All agent-decision paths (supervisor ENFORCE, watchlist
 * auto-push) call this function so the routing logic stays in one place
 * and the audit trail stays consistent.
 *
 * What it does, in order:
 *   1. Ensure a `Lead` row exists for this LinkedInProfile (creates with
 *      placeholder `lin_<slug>@unresolved.local` email if first time).
 *   2. Run the enrichment waterfall (BYOK providers in order_index;
 *      Clay-as-waterfall when Clay is connected).
 *   3. Run the icebreaker generator if a grounding engagement event is
 *      available - non-blocking, writes to Lead.signal_icebreaker.
 *   4. **Routing per architecture**:
 *        - If phone present after enrichment → tag the lead for the
 *          day's cold-call list.
 *        - If real email present after enrichment → set source='signal'
 *          so the lead appears on Super Sequencer contacts with the
 *          right provenance label.
 *   5. Upsert CampaignLead in the target campaign (if specified).
 *   6. Tag for a custom cold-call list (if specified by a rule).
 *
 * Returns a summary the caller can audit + surface to the operator. All
 * I/O is best-effort: a downstream failure logs a warning but doesn't
 * throw, because partial success ("enriched but didn't enroll") is
 * better than a half-rolled-back state.
 */

import { prisma } from '../../prisma';
import { logger } from '../observabilityService';
import { runEnrichmentAgent } from '../agents/enrichmentAgent';
import { generateIcebreakerFromSignal } from '../signalIcebreakerService';
import type { EnrichedFields } from '../enrichment/providerInterface';

export interface PromoteInput {
    organizationId: string;
    /** LinkedInProfile.id - must already exist; caller responsible for
     *  upserting the profile before calling here. */
    profileId: string;
    /** Optional target campaign - if set, the promoted lead is upserted
     *  as a CampaignLead row. */
    campaignId?: string | null;
    /** Optional rule-driven cold-call list tag - when a SignalMonitoring
     *  Rule has `add_to_cold_call_list_id` set, the matching list is
     *  passed here and the lead picks up a `lead_category` marker for
     *  that list. */
    coldCallListId?: string | null;
    /** Optional engagement event to seed the icebreaker. The supervisor
     *  ENFORCE path passes the EngagementEvent.id; the watchlist auto-
     *  push path may not have one (matches don't always have a poller
     *  event yet). When absent the icebreaker step is skipped. */
    engagementEventId?: string | null;
    /** Provenance - what triggered this promotion. Surfaces in the
     *  AgentRun audit and (eventually) the lead-detail timeline. */
    trigger: 'engagement_event' | 'watchlist_match' | 'manual_push';
    /** Reference id for the trigger - event id, match id, etc. Drives
     *  audit linkage. */
    triggerRefId: string;
}

export interface PromoteResult {
    lead_id: string;
    enriched: EnrichedFields;
    icebreaker_status: 'generated' | 'skipped' | 'failed' | 'not_attempted';
    routed: {
        /** True when the lead got auto-tagged for today's cold-call list
         *  because phone enrichment landed. Independent of `cold_call_list_id`
         *  which is a rule-specific tag. */
        added_to_cold_call_day_list: boolean;
        /** True when the lead got source='signal' for Sequencer contact
         *  surface - i.e., a real email was enriched. */
        appears_on_sequencer_contacts: boolean;
        /** True when CampaignLead row upserted. */
        added_to_campaign: boolean;
        /** True when a custom cold-call list tag was applied. */
        tagged_to_cold_call_list: boolean;
    };
    warnings: string[];
}

/** Per architecture: phone-enriched signal leads land on this lead_category
 *  tag so the daily cold-call snapshot worker includes them in today's
 *  list. Distinct from rule-driven `cold_call_list:<id>` tags which point
 *  at a specific custom list. */
const COLD_CALL_DAY_TAG = 'cold_call_signal_phone';

/** Standard source label for signal-promoted leads - matches the
 *  enum the Super Sequencer Contacts UI renders + filters on. */
const SIGNAL_SOURCE_LABEL = 'signal';

export async function promoteProfileToCampaign(input: PromoteInput): Promise<PromoteResult> {
    const warnings: string[] = [];
    const routed: PromoteResult['routed'] = {
        added_to_cold_call_day_list: false,
        appears_on_sequencer_contacts: false,
        added_to_campaign: false,
        tagged_to_cold_call_list: false,
    };

    // ── 1. Load the profile ─────────────────────────────────────────
    const profile = await prisma.linkedInProfile.findFirst({
        where: { id: input.profileId, organization_id: input.organizationId },
        select: {
            id: true, public_identifier: true, name: true, headline: true,
            company: true, position: true, lead_id: true,
        },
    });
    if (!profile) throw new Error(`LinkedInProfile ${input.profileId} not found in org ${input.organizationId}`);

    // ── 2. Promote to Lead (idempotent) ─────────────────────────────
    let leadId = profile.lead_id;
    if (!leadId) {
        const firstName = profile.name.split(' ')[0] || profile.name;
        const lastName = profile.name.split(' ').slice(1).join(' ') || null;
        const created = await prisma.lead.create({
            data: {
                organization_id: input.organizationId,
                // Placeholder email - sentinel that the dispatcher +
                // contacts UI recognise as "pre-enrichment stub" and
                // hide the email column for.
                email: `lin_${profile.public_identifier}@unresolved.local`,
                first_name: firstName,
                last_name: lastName,
                full_name: profile.name,
                company: profile.company,
                title: profile.position,
                linkedin_url: `https://linkedin.com/in/${profile.public_identifier}`,
                persona: profile.position?.toLowerCase() || 'general',
                lead_score: 50,
                source: SIGNAL_SOURCE_LABEL,
            },
            select: { id: true },
        });
        leadId = created.id;
        await prisma.linkedInProfile.update({
            where: { id: profile.id },
            data: { lead_id: leadId },
        });
    }

    // ── 3. Enrichment waterfall ─────────────────────────────────────
    const enrich = await runEnrichmentAgent({
        organization_id: input.organizationId,
        lead_id: leadId,
        profile: {
            linkedin_url: `https://linkedin.com/in/${profile.public_identifier}`,
            full_name: profile.name,
            company_name: profile.company || undefined,
        },
        trigger: input.trigger,
        trigger_ref_id: input.triggerRefId,
    });
    await applyEnrichmentToLead(leadId, enrich.final_fields, warnings);

    // ── 4. Icebreaker (non-blocking) ────────────────────────────────
    let icebreaker_status: PromoteResult['icebreaker_status'] = 'not_attempted';
    if (input.engagementEventId) {
        icebreaker_status = 'generated';
        try {
            const result = await generateIcebreakerFromSignal({
                organizationId: input.organizationId,
                leadId,
                engagementEventId: input.engagementEventId,
            });
            if (!result.text) icebreaker_status = 'skipped';
        } catch (err) {
            icebreaker_status = 'failed';
            const msg = err instanceof Error ? err.message : String(err);
            warnings.push(`icebreaker_failed: ${msg.slice(0, 120)}`);
            logger.warn('[PROMOTE] icebreaker generation failed (non-blocking)', {
                leadId, eventId: input.engagementEventId, err: msg,
            });
        }
    }

    // ── 5. Post-enrichment routing (per architecture spec) ──────────
    // Phone present → tag for today's cold-call snapshot. The daily
    // snapshot worker reads leads with COLD_CALL_DAY_TAG + recent
    // last_activity_at and surfaces them in today's list.
    if (enrich.final_fields.phone) {
        try {
            await prisma.lead.update({
                where: { id: leadId },
                data: { lead_category: COLD_CALL_DAY_TAG, last_activity_at: new Date() },
            });
            routed.added_to_cold_call_day_list = true;
        } catch (err) {
            warnings.push(`cold_call_day_tag_failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200));
        }
    }
    // Real email present → ensure source='signal' so the Sequencer
    // Contacts page surfaces this lead with the right provenance.
    // (Source is already set at Lead-create time but we re-affirm in
    // case a prior path wrote a different source.)
    if (enrich.final_fields.email && !enrich.final_fields.email.endsWith('@unresolved.local')) {
        try {
            await prisma.lead.update({
                where: { id: leadId },
                data: { source: SIGNAL_SOURCE_LABEL },
            });
            routed.appears_on_sequencer_contacts = true;
        } catch (err) {
            warnings.push(`sequencer_source_tag_failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200));
        }
    }

    // ── 6. Optional rule-driven custom cold-call list tag ───────────
    if (input.coldCallListId) {
        try {
            await prisma.lead.update({
                where: { id: leadId },
                data: { lead_category: `cold_call_list:${input.coldCallListId}`, last_activity_at: new Date() },
            });
            routed.tagged_to_cold_call_list = true;
        } catch (err) {
            warnings.push(`custom_cold_call_list_tag_failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200));
        }
    }

    // ── 7. CampaignLead enrollment ──────────────────────────────────
    if (input.campaignId) {
        const enrichedLead = await prisma.lead.findUnique({
            where: { id: leadId },
            select: { email: true, first_name: true, last_name: true, company: true, title: true },
        });
        const leadEmail = enrichedLead?.email || `lin_${profile.public_identifier}@unresolved.local`;
        const campaign = await prisma.campaign.findFirst({
            where: { id: input.campaignId, organization_id: input.organizationId, deleted_at: null },
            select: { id: true },
        });
        if (!campaign) {
            warnings.push(`campaign_not_found: ${input.campaignId}`);
            logger.warn('[PROMOTE] target campaign missing - skipping enrollment', {
                leadId, campaignId: input.campaignId,
            });
        } else {
            try {
                await prisma.campaignLead.upsert({
                    where: { campaign_id_email: { campaign_id: input.campaignId, email: leadEmail } },
                    create: {
                        campaign_id: input.campaignId,
                        email: leadEmail,
                        first_name: enrichedLead?.first_name || profile.name.split(' ')[0] || null,
                        last_name: enrichedLead?.last_name || profile.name.split(' ').slice(1).join(' ') || null,
                        company: enrichedLead?.company || profile.company,
                        title: enrichedLead?.title || profile.position,
                        status: 'active',
                        current_step: 0,
                    },
                    update: {},
                });
                routed.added_to_campaign = true;
            } catch (err) {
                warnings.push(`campaign_lead_upsert_failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200));
            }
        }
    }

    return { lead_id: leadId, enriched: enrich.final_fields, icebreaker_status, routed, warnings };
}

async function applyEnrichmentToLead(leadId: string, fields: EnrichedFields, warnings: string[]): Promise<void> {
    const updates: Record<string, string> = {};
    if (fields.email && !fields.email.endsWith('@unresolved.local')) updates.email = fields.email;
    if (fields.phone) updates.phone = fields.phone;
    if (fields.title) updates.title = fields.title;
    if (fields.company_name) updates.company = fields.company_name;
    if (Object.keys(updates).length === 0) return;
    try {
        await prisma.lead.update({ where: { id: leadId }, data: updates });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        warnings.push(`lead_patch_failed: ${msg.slice(0, 120)}`);
        logger.warn('[PROMOTE] Lead patch failed', { leadId, err: msg });
    }
}
