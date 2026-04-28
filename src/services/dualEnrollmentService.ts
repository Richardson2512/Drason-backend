/**
 * Dual Enrollment Service
 *
 * Detects when leads being added to a campaign are already enrolled (or have
 * historical engagement) in other campaigns within the same organization.
 *
 * Used to power the "preview before commit" UX in the lead-add step of campaign
 * creation. Mirrors the Smartlead/Instantly pattern: surface conflicts and let
 * the operator decide whether to exclude already-enrolled leads.
 *
 * Two categories of conflict:
 *  - ACTIVE conflicts (status in [active, paused]) — lead is currently
 *    being sent to in another campaign. Default exclusion target.
 *  - HISTORICAL conflicts (status in [completed, replied, bounced, unsubscribed])
 *    — lead has prior engagement (opens/clicks/replies) from a finished sequence.
 *    Surfaced for context but not excluded by default.
 *
 * Hard-blocked leads (Lead.bounced=true OR Lead.unsubscribed_at != null) are
 * separately reported — they should not be enrolled in any campaign.
 */

import { prisma } from '../index';
import { logger } from './observabilityService';

// ============================================================================
// TYPES
// ============================================================================

export type ConflictKind = 'active' | 'historical';

export interface CampaignConflict {
    campaign_id: string;
    campaign_name: string;
    campaign_status: string;            // active, paused, archived, completed
    enrollment_status: string;          // active, paused, replied, bounced, etc.
    current_step: number;
    last_sent_at: Date | null;
    next_send_at: Date | null;
    opened_count: number;
    clicked_count: number;
    replied_at: Date | null;
    enrolled_at: Date;
    kind: ConflictKind;
}

export interface LeadConflictRecord {
    lead_id: string;
    email: string;
    activeConflicts: CampaignConflict[];
    historicalConflicts: CampaignConflict[];
    suppressed: boolean;                // Lead.bounced or Lead.unsubscribed_at
    suppressedReason: string | null;
}

export interface DualEnrollmentReport {
    /** Total leads checked. */
    totalLeads: number;
    /** Leads with at least one active enrollment in another campaign. */
    activeConflictCount: number;
    /** Leads with at least one historical (completed/replied/bounced) record. */
    historicalConflictCount: number;
    /** Leads that are org-wide suppressed (bounced / unsubscribed). */
    suppressedCount: number;
    /** Leads with NO conflicts and not suppressed (clean to enroll). */
    cleanCount: number;
    /** Per-lead conflict records. Sorted: active first, then historical, then clean. */
    leads: LeadConflictRecord[];
}

const ACTIVE_STATUSES = ['active', 'paused'];
const HISTORICAL_STATUSES = ['completed', 'replied', 'bounced', 'unsubscribed'];

// Chunk size for IN(...) queries — prevents pathological query plans on
// uploads with tens of thousands of emails.
const QUERY_BATCH_SIZE = 1000;

// ============================================================================
// MAIN ENTRY POINT
// ============================================================================

/**
 * Build a dual-enrollment report for a set of leads about to be added to a
 * target campaign. Skips the target campaign itself when scanning for
 * conflicts (re-enrolling a lead in the same campaign isn't dual-enrollment).
 */
export async function checkDualEnrollment(
    organizationId: string,
    leadIds: string[],
    excludeCampaignId: string | null = null
): Promise<DualEnrollmentReport> {
    if (leadIds.length === 0) {
        return emptyReport();
    }

    // Step 1 — load the source leads (to get their emails + suppression status)
    const sourceLeads = await prisma.lead.findMany({
        where: {
            id: { in: leadIds },
            organization_id: organizationId,
        },
        select: {
            id: true,
            email: true,
            bounced: true,
            unsubscribed_at: true,
            unsubscribed_reason: true,
        },
    });

    if (sourceLeads.length === 0) {
        return emptyReport();
    }

    const emails = Array.from(new Set(sourceLeads.map(l => l.email.toLowerCase())));
    const emailToLeadId = new Map(sourceLeads.map(l => [l.email.toLowerCase(), l.id]));

    // Step 2 — fetch all CampaignLead rows for these emails in this org,
    // excluding the target campaign. Batched in chunks to keep query plans sane.
    const allConflicts: Array<CampaignLeadRow> = [];
    for (let i = 0; i < emails.length; i += QUERY_BATCH_SIZE) {
        const chunk = emails.slice(i, i + QUERY_BATCH_SIZE);
        const rows = await prisma.campaignLead.findMany({
            where: {
                email: { in: chunk },
                campaign: {
                    organization_id: organizationId,
                    ...(excludeCampaignId ? { id: { not: excludeCampaignId } } : {}),
                },
            },
            select: {
                email: true,
                campaign_id: true,
                status: true,
                current_step: true,
                last_sent_at: true,
                next_send_at: true,
                opened_count: true,
                clicked_count: true,
                replied_at: true,
                created_at: true,
                campaign: {
                    select: { id: true, name: true, status: true },
                },
            },
        });
        allConflicts.push(...(rows as unknown as CampaignLeadRow[]));
    }

    // Step 3 — group conflicts by email
    const byEmail = new Map<string, CampaignConflict[]>();
    for (const row of allConflicts) {
        const status = (row.status || '').toLowerCase();
        const kind: ConflictKind = ACTIVE_STATUSES.includes(status) ? 'active' : 'historical';
        const conflict: CampaignConflict = {
            campaign_id: row.campaign_id,
            campaign_name: row.campaign?.name || '(unnamed)',
            campaign_status: row.campaign?.status || 'unknown',
            enrollment_status: status,
            current_step: row.current_step ?? 0,
            last_sent_at: row.last_sent_at,
            next_send_at: row.next_send_at,
            opened_count: row.opened_count ?? 0,
            clicked_count: row.clicked_count ?? 0,
            replied_at: row.replied_at,
            enrolled_at: row.created_at,
            kind,
        };
        const key = row.email.toLowerCase();
        if (!byEmail.has(key)) byEmail.set(key, []);
        byEmail.get(key)!.push(conflict);
    }

    // Step 4 — build per-lead records
    const records: LeadConflictRecord[] = [];
    for (const lead of sourceLeads) {
        const emailKey = lead.email.toLowerCase();
        const allForLead = byEmail.get(emailKey) || [];
        const activeConflicts = allForLead.filter(c => c.kind === 'active');
        const historicalConflicts = allForLead.filter(c => c.kind === 'historical');

        const suppressed = lead.bounced || !!lead.unsubscribed_at;
        const suppressedReason = lead.bounced
            ? 'hard_bounce'
            : lead.unsubscribed_at
                ? (lead.unsubscribed_reason || 'unsubscribed')
                : null;

        records.push({
            lead_id: lead.id,
            email: lead.email,
            activeConflicts,
            historicalConflicts,
            suppressed,
            suppressedReason,
        });
    }

    // Step 5 — sort: active conflicts first, then historical, then clean.
    records.sort((a, b) => {
        const aRank = a.activeConflicts.length > 0 ? 0
            : a.historicalConflicts.length > 0 ? 1
            : a.suppressed ? 2 : 3;
        const bRank = b.activeConflicts.length > 0 ? 0
            : b.historicalConflicts.length > 0 ? 1
            : b.suppressed ? 2 : 3;
        return aRank - bRank;
    });

    return {
        totalLeads: sourceLeads.length,
        activeConflictCount: records.filter(r => r.activeConflicts.length > 0).length,
        historicalConflictCount: records.filter(r => r.historicalConflicts.length > 0).length,
        suppressedCount: records.filter(r => r.suppressed).length,
        cleanCount: records.filter(r =>
            r.activeConflicts.length === 0 &&
            r.historicalConflicts.length === 0 &&
            !r.suppressed
        ).length,
        leads: records,
    };
}

/**
 * Resolve which lead IDs to exclude from enrollment given a report and the
 * operator's toggle choice. Suppressed leads (bounced/unsubscribed) are
 * always excluded regardless of toggle — they're org-wide blocked and
 * enrolling them would violate CAN-SPAM/GDPR.
 */
export function resolveExclusions(
    report: DualEnrollmentReport,
    options: { excludeActive: boolean }
): { excludedLeadIds: Set<string>; reasons: Map<string, string> } {
    const excludedLeadIds = new Set<string>();
    const reasons = new Map<string, string>();

    for (const lead of report.leads) {
        if (lead.suppressed) {
            excludedLeadIds.add(lead.lead_id);
            reasons.set(lead.lead_id, `suppressed:${lead.suppressedReason}`);
            continue;
        }
        if (options.excludeActive && lead.activeConflicts.length > 0) {
            excludedLeadIds.add(lead.lead_id);
            const c = lead.activeConflicts[0];
            reasons.set(lead.lead_id, `active_in_campaign:${c.campaign_name}`);
        }
    }

    return { excludedLeadIds, reasons };
}

// ============================================================================
// HELPERS
// ============================================================================

interface CampaignLeadRow {
    email: string;
    campaign_id: string;
    status: string;
    current_step: number;
    last_sent_at: Date | null;
    next_send_at: Date | null;
    opened_count: number;
    clicked_count: number;
    replied_at: Date | null;
    created_at: Date;
    campaign: {
        id: string;
        name: string;
        status: string;
    } | null;
}

function emptyReport(): DualEnrollmentReport {
    return {
        totalLeads: 0,
        activeConflictCount: 0,
        historicalConflictCount: 0,
        suppressedCount: 0,
        cleanCount: 0,
        leads: [],
    };
}
