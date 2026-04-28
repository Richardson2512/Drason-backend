/**
 * Sequencer Enrollment Service
 *
 * The "push" of a routed Lead onto a Campaign is just a CampaignLead row
 * insert; the send queue dispatcher (sendQueueService) picks it up on its
 * next cycle and runs the sends.
 *
 * This service is called from:
 *   - ingestionController.processLead — when an ingested/Clay-webhook lead has
 *     an assigned sequencer campaign
 *   - processor.ts — when a held lead with a sequencer target passes the
 *     execution gate
 *
 * Both paths were previously calling getAdapterForCampaign which throws for
 * sequencer campaigns (no adapter registered). That would silently burn through
 * the 5-attempt retry cap and BLOCK the lead. Routing a RoutingRule to a
 * sequencer campaign now works end-to-end.
 */

import { prisma } from '../index';
import { logger } from './observabilityService';

export interface SequencerEnrollmentInput {
    email: string;
    first_name?: string | null;
    last_name?: string | null;
    company?: string | null;
    title?: string | null;
    validation_status?: string | null;
    validation_score?: number | null;
}

export interface SequencerEnrollmentResult {
    success: boolean;
    /** Set when success=false; opaque error message safe to log. */
    error?: string;
    /** True iff a new CampaignLead row was inserted (false if it already existed). */
    inserted?: boolean;
}

/**
 * Enroll a lead in a sequencer campaign by upserting a CampaignLead row.
 *
 * Idempotent by design — a second call with the same (campaign_id, email) is a
 * no-op thanks to the unique index + `skipDuplicates`. Returns `success=true`
 * whether the row was newly inserted or already present, since from the
 * caller's perspective the lead is enrolled either way.
 *
 * The caller is responsible for transitioning Lead.status → ACTIVE on success
 * (via entityStateService) and handling retry bookkeeping on failure — this
 * service only owns the CampaignLead side.
 */
export async function enrollLeadInSequencerCampaign(
    organizationId: string,
    campaignId: string,
    lead: SequencerEnrollmentInput,
): Promise<SequencerEnrollmentResult> {
    try {
        // Guard: campaign must exist and belong to this org.
        const campaign = await prisma.campaign.findFirst({
            where: {
                id: campaignId,
                organization_id: organizationId,
            },
            select: { id: true, status: true },
        });
        if (!campaign) {
            return { success: false, error: 'Campaign not found' };
        }

        const normalizedEmail = lead.email.toLowerCase().trim();

        // Org-wide suppression guard — refuse to enroll any lead whose org-scoped
        // Lead row carries an opt-out or hard-bounce marker. This is required by
        // CAN-SPAM § 5(a)(4)(A), CASL § 11(3), and GDPR Art. 21: once a recipient
        // objects (or has been classified as undeliverable), no further sends.
        const suppression = await prisma.lead.findUnique({
            where: { organization_id_email: { organization_id: organizationId, email: normalizedEmail } },
            select: { status: true, unsubscribed_reason: true },
        });
        if (suppression && (suppression.status === 'unsubscribed' || suppression.status === 'bounced')) {
            logger.info('[SEQUENCER_ENROLL] Refused — org-wide suppression', {
                organizationId,
                campaignId,
                email: normalizedEmail,
                leadStatus: suppression.status,
                reason: suppression.unsubscribed_reason,
            });
            return {
                success: false,
                error: `Recipient is suppressed at the organization level (${suppression.status}). Cannot enroll in any campaign.`,
            };
        }

        // createMany + skipDuplicates makes this idempotent. The [campaign_id, email]
        // unique constraint guarantees a single CampaignLead per (campaign, contact).
        const result = await prisma.campaignLead.createMany({
            data: [{
                campaign_id: campaignId,
                email: normalizedEmail,
                first_name: lead.first_name ?? null,
                last_name: lead.last_name ?? null,
                company: lead.company ?? null,
                title: lead.title ?? null,
                status: 'active',
                validation_status: lead.validation_status ?? null,
                validation_score: lead.validation_score ?? null,
            }],
            skipDuplicates: true,
        });

        // Refresh campaign.total_leads so analytics stay consistent. Only update
        // when we actually inserted — a no-op duplicate shouldn't re-count.
        if (result.count > 0) {
            const leadCount = await prisma.campaignLead.count({
                where: { campaign_id: campaignId },
            });
            await prisma.campaign.update({
                where: { id: campaignId },
                data: { total_leads: leadCount },
            }).catch((err) => {
                // total_leads drift is a cosmetic bug, not a correctness one.
                logger.warn('[SEQUENCER_ENROLL] Failed to refresh total_leads', { campaignId, error: (err as Error).message });
            });
        }

        return { success: true, inserted: result.count > 0 };
    } catch (err) {
        return { success: false, error: (err as Error).message };
    }
}
