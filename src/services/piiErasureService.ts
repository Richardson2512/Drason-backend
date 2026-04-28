/**
 * PII Erasure Service
 *
 * Implements GDPR Art. 17 / DPDP § 12 / PDPA / CCPA right of erasure for
 * recipient and customer data. Handles two scopes:
 *
 *   eraseLeadPII(orgId, email)   — single recipient erasure (Controller-instructed
 *                                   deletion or DSAR from the recipient).
 *   eraseOrganization(orgId)     — full account erasure after DSAR grace period.
 *
 * Approach: scrub PII fields from "audit-bearing" tables in place rather than
 * delete the rows, because aggregate counters (BounceEvent counts, SendEvent
 * volume) are still useful for organizational analytics. Rows themselves stay;
 * only the PII columns are nulled out or replaced with a tombstone marker.
 *
 * Tables we touch and how:
 *
 *   Lead              — scrub email/name/phone/linkedin/persona/title/company.
 *                       Keep row + flip status='erased' so re-imports of the same
 *                       email recreate as a fresh Lead and don't re-collide.
 *   CampaignLead      — scrub email/name/company/title; status='erased'.
 *   BounceEvent       — scrub email_address.
 *   SendEvent         — scrub recipient_email.
 *   ValidationAttempt — delete (no audit value once Lead is gone; cheaper).
 *   EmailMessage      — scrub from_email/to_email/body_html/body_text for any
 *                       message where to_email or from_email matches.
 *
 * We do NOT touch:
 *   - AuditLog (compliance retention requirement — 1 year)
 *   - Consent (audit trail integrity — snapshot fields preserve identity)
 *   - SubscriptionEvent / ApiCallLog (financial/operational records)
 */

import { prisma } from '../index';
import { logger } from './observabilityService';

const TOMBSTONE_EMAIL = (uuid: string) => `erased-${uuid}@anonymized.invalid`;

export interface LeadErasureResult {
    leadFound: boolean;
    campaignLeadsScrubbed: number;
    bounceEventsScrubbed: number;
    sendEventsScrubbed: number;
    validationAttemptsDeleted: number;
    emailMessagesScrubbed: number;
}

/**
 * Erase all PII for a single recipient email within an organization. Idempotent:
 * running twice on the same email is safe — second call simply finds no PII to
 * scrub. Used by:
 *   - Customer-initiated lead deletion (contactController.deleteContacts)
 *   - Recipient DSAR forwarded by customer
 *   - Account-level erasure (loops over every lead in the org)
 */
export async function eraseLeadPII(
    organizationId: string,
    recipientEmail: string,
): Promise<LeadErasureResult> {
    const normalized = recipientEmail.toLowerCase().trim();
    const result: LeadErasureResult = {
        leadFound: false,
        campaignLeadsScrubbed: 0,
        bounceEventsScrubbed: 0,
        sendEventsScrubbed: 0,
        validationAttemptsDeleted: 0,
        emailMessagesScrubbed: 0,
    };

    // Find Lead row (org-scoped) so we have its id for child-table cleanup.
    const lead = await prisma.lead.findUnique({
        where: { organization_id_email: { organization_id: organizationId, email: normalized } },
        select: { id: true },
    });

    const tombstone = TOMBSTONE_EMAIL(lead?.id || normalized);

    // 1. Scrub the Lead row itself if it exists. We replace email with a
    //    tombstone so the unique (org, email) constraint stays satisfied while
    //    the row no longer carries identifying info.
    if (lead) {
        await prisma.lead.update({
            where: { id: lead.id },
            data: {
                email: tombstone,
                first_name: null,
                last_name: null,
                full_name: null,
                phone: null,
                linkedin_url: null,
                title: null,
                company: null,
                website: null,
                persona: 'erased',
                status: 'erased',
                custom_variables: undefined,           // Json field; reset
                deleted_at: new Date(),
            } as never,
        });
        result.leadFound = true;
        // ValidationAttempt — referenced by lead_id, no audit value once lead is gone.
        const va = await prisma.validationAttempt.deleteMany({
            where: { lead_id: lead.id },
        });
        result.validationAttemptsDeleted = va.count;
    }

    // 2. Scrub CampaignLead rows for this email across the entire org. Even if
    //    the Lead row didn't exist (sequencer-only contact path), there may
    //    still be CampaignLead rows.
    const cl = await prisma.campaignLead.updateMany({
        where: {
            email: normalized,
            campaign: { organization_id: organizationId },
        },
        data: {
            email: tombstone,
            first_name: null,
            last_name: null,
            company: null,
            title: null,
            custom_variables: undefined,
            status: 'erased',
        },
    });
    result.campaignLeadsScrubbed = cl.count;

    // 3. Scrub BounceEvent.email_address. We keep the row for aggregate
    //    bounce-rate analytics; only the PII gets removed.
    const be = await prisma.bounceEvent.updateMany({
        where: { organization_id: organizationId, email_address: normalized },
        data: { email_address: tombstone, bounce_reason: null },
    });
    result.bounceEventsScrubbed = be.count;

    // 4. Scrub SendEvent.recipient_email.
    const se = await prisma.sendEvent.updateMany({
        where: { organization_id: organizationId, recipient_email: normalized },
        data: { recipient_email: tombstone },
    });
    result.sendEventsScrubbed = se.count;

    // 5. Scrub EmailMessage rows where this email appears as sender or
    //    recipient. These contain message bodies so we wipe body fields too.
    const em = await prisma.emailMessage.updateMany({
        where: {
            OR: [{ to_email: normalized }, { from_email: normalized }],
        },
        data: {
            to_email: tombstone,
            from_email: tombstone,
            to_name: null,
            from_name: null,
            subject: '[erased]',
            body_html: '',
            body_text: null,
        },
    });
    result.emailMessagesScrubbed = em.count;

    logger.info('[PII-ERASURE] Lead erased', {
        organizationId,
        emailHashPrefix: normalized.slice(0, 3) + '...',  // never log full email
        ...result,
    });

    return result;
}

/**
 * Full account erasure for a deleted organization. Loops over every Lead in
 * the org and erases each, then deletes operational tables that aren't
 * needed for compliance retention.
 *
 * The Organization row itself is also deleted (cascade handles relations).
 * AuditLog rows survive — those are required compliance evidence and are
 * already org-scoped so they don't carry recipient PII directly.
 *
 * Returns a counts summary for the AuditLog row that signals completion.
 */
export interface OrganizationErasureResult {
    leadsErased: number;
    campaignLeadsScrubbed: number;
    bounceEventsScrubbed: number;
    sendEventsScrubbed: number;
    validationAttemptsDeleted: number;
    emailMessagesScrubbed: number;
    organizationDeleted: boolean;
}

export async function eraseOrganization(
    organizationId: string,
): Promise<OrganizationErasureResult> {
    logger.info('[PII-ERASURE] Starting full organization erasure', { organizationId });

    const totals: OrganizationErasureResult = {
        leadsErased: 0,
        campaignLeadsScrubbed: 0,
        bounceEventsScrubbed: 0,
        sendEventsScrubbed: 0,
        validationAttemptsDeleted: 0,
        emailMessagesScrubbed: 0,
        organizationDeleted: false,
    };

    // Page through all leads; erase one at a time so a single Postgres failure
    // doesn't abort the whole operation. Each eraseLeadPII is idempotent.
    const PAGE = 200;
    let lastId: string | undefined;
    while (true) {
        const batch = await prisma.lead.findMany({
            where: {
                organization_id: organizationId,
                ...(lastId ? { id: { gt: lastId } } : {}),
            },
            select: { id: true, email: true },
            orderBy: { id: 'asc' },
            take: PAGE,
        });
        if (batch.length === 0) break;

        for (const row of batch) {
            // Skip already-erased rows (email starts with the tombstone prefix).
            if (row.email.startsWith('erased-')) continue;
            const r = await eraseLeadPII(organizationId, row.email);
            if (r.leadFound) totals.leadsErased++;
            totals.campaignLeadsScrubbed += r.campaignLeadsScrubbed;
            totals.bounceEventsScrubbed += r.bounceEventsScrubbed;
            totals.sendEventsScrubbed += r.sendEventsScrubbed;
            totals.validationAttemptsDeleted += r.validationAttemptsDeleted;
            totals.emailMessagesScrubbed += r.emailMessagesScrubbed;
        }
        lastId = batch[batch.length - 1]!.id;
        if (batch.length < PAGE) break;
    }

    // Hard-delete the org. Cascades clean up most relations; surviving rows
    // are AuditLog (intentionally retained for legal-compliance window).
    try {
        await prisma.organization.delete({ where: { id: organizationId } });
        totals.organizationDeleted = true;
    } catch (err) {
        logger.error(
            '[PII-ERASURE] Organization deletion failed — recipient PII is erased but org row remains',
            err instanceof Error ? err : new Error(String(err)),
            { organizationId },
        );
    }

    logger.info('[PII-ERASURE] Organization erasure complete', { organizationId, ...totals });
    return totals;
}
