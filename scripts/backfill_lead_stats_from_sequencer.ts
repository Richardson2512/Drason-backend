/**
 * Backfill Protection Lead stats from authoritative sequencer event tables.
 *
 * Purpose
 * -------
 * Before today's cleanup pass, every sequencer send, open, click, and reply wrote
 * only into the sequencer-side tables (CampaignLead / SendEvent / ReplyEvent /
 * SendCampaign.total_*). The Protection-layer Lead row for the same contact kept
 * emails_sent/opened/clicked/replied stuck at 0, assigned_campaign_id NULL, and
 * status 'held'. New sends are now mirrored forward (see sendQueueService,
 * trackingController, imapReplyWorker). This script reconciles the HISTORICAL gap.
 *
 * What it does per Lead (scoped by organization_id):
 *   - emails_sent       ← COUNT(SendEvent  WHERE recipient_email = lead.email)
 *   - emails_replied    ← COUNT(ReplyEvent WHERE recipient_email = lead.email)
 *   - emails_opened     ← SUM(CampaignLead.opened_count)  across all campaigns
 *   - emails_clicked    ← SUM(CampaignLead.clicked_count) across all campaigns
 *   - bounced           ← TRUE iff any BounceEvent or CampaignLead.bounced_at for this email
 *   - last_activity_at  ← MAX(last_sent_at, replied_at, bounced_at, unsubscribed_at)
 *   - assigned_campaign_id ← most-recent CampaignLead.campaign_id for this lead
 *                            (most-recently-sent wins; if none sent yet, most-recent created)
 *   - status transitions held → active via entityStateService for leads enrolled in
 *     a campaign (source of truth is CampaignLead existence), except when all their
 *     CampaignLeads are completed/replied/bounced — those stay put.
 *
 * Deliberately skipped:
 *   - Leads with no CampaignLead row and no SendEvent keep whatever counters/status
 *     they already have (we have no evidence they should change).
 *   - validation_* fields — owned exclusively by emailValidationService.
 *
 * Usage
 * -----
 *     # Dry run (default — prints planned changes, does NOT write):
 *     npx ts-node backend/scripts/backfill_lead_stats_from_sequencer.ts
 *
 *     # Live apply:
 *     npx ts-node backend/scripts/backfill_lead_stats_from_sequencer.ts --live
 *
 *     # Limit to one email (useful for verifying a specific lead first):
 *     npx ts-node backend/scripts/backfill_lead_stats_from_sequencer.ts --email richardson@rihario.com
 *
 *     # Limit to one organization:
 *     npx ts-node backend/scripts/backfill_lead_stats_from_sequencer.ts --org <org-id>
 *
 * Idempotency
 * -----------
 * Running this script twice produces the same end state. All counter writes are
 * `set` (not `increment`), so repeated runs do not double-count.
 */

import { PrismaClient } from '@prisma/client';

// A dedicated PrismaClient for this script so we don't import anything from
// src/index.ts (which would boot workers, redis, event queue, etc.). The state
// transition logic we need is narrow enough to inline — see applyStatusTransition.
const prisma = new PrismaClient();

// ─── CLI flag parsing ───────────────────────────────────────────────────────

interface Flags {
    live: boolean;
    emailFilter: string | null;
    orgFilter: string | null;
}

function parseFlags(argv: string[]): Flags {
    const flags: Flags = { live: false, emailFilter: null, orgFilter: null };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--live') flags.live = true;
        else if (a === '--email' && argv[i + 1]) { flags.emailFilter = argv[++i].toLowerCase(); }
        else if (a === '--org' && argv[i + 1]) { flags.orgFilter = argv[++i]; }
    }
    return flags;
}

// ─── Types ──────────────────────────────────────────────────────────────────

interface Change {
    leadId: string;
    email: string;
    organizationId: string;
    before: {
        emails_sent: number;
        emails_opened: number;
        emails_clicked: number;
        emails_replied: number;
        bounced: boolean;
        assigned_campaign_id: string | null;
        status: string;
        last_activity_at: Date | null;
    };
    after: {
        emails_sent: number;
        emails_opened: number;
        emails_clicked: number;
        emails_replied: number;
        bounced: boolean;
        assigned_campaign_id: string | null;
        last_activity_at: Date | null;
    };
    shouldTransitionToActive: boolean;
    diff: string[];
}

// ─── Core reconciliation ────────────────────────────────────────────────────

/**
 * Reconcile one Lead row against sequencer event tables and return a Change
 * describing what would be updated (or null if fully in sync).
 */
async function computeChangeForLead(lead: {
    id: string;
    email: string;
    organization_id: string;
    emails_sent: number;
    emails_opened: number;
    emails_clicked: number;
    emails_replied: number;
    bounced: boolean;
    assigned_campaign_id: string | null;
    status: string;
    last_activity_at: Date | null;
}): Promise<Change | null> {
    const { id, email, organization_id } = lead;

    // 1. Count authoritative send + reply + bounce events.
    const [sendCount, replyCount, bounceCount] = await Promise.all([
        prisma.sendEvent.count({ where: { organization_id, recipient_email: email } }),
        prisma.replyEvent.count({ where: { organization_id, recipient_email: email } }),
        prisma.bounceEvent.count({ where: { organization_id, email_address: email } }),
    ]);

    // 2. CampaignLead aggregate — opens/clicks/bounce flag + most-recent campaign link.
    const campaignLeads = await prisma.campaignLead.findMany({
        where: { email, campaign: { organization_id } },
        select: {
            campaign_id: true,
            opened_count: true,
            clicked_count: true,
            status: true,
            last_sent_at: true,
            replied_at: true,
            bounced_at: true,
            unsubscribed_at: true,
            created_at: true,
        },
    });

    const opensSum = campaignLeads.reduce((sum, cl) => sum + (cl.opened_count || 0), 0);
    const clicksSum = campaignLeads.reduce((sum, cl) => sum + (cl.clicked_count || 0), 0);
    const anyBounced = bounceCount > 0 || campaignLeads.some((cl) => !!cl.bounced_at);

    // 3. Assigned campaign resolution.
    //    Priority: most-recently-sent CampaignLead → otherwise most-recently-created.
    //    Preserve the existing Lead.assigned_campaign_id if no CampaignLead rows exist
    //    (so we don't wipe a legacy Smartlead/Instantly Campaign.id pointer).
    let assignedCampaignId: string | null = lead.assigned_campaign_id;
    if (campaignLeads.length > 0) {
        const sorted = [...campaignLeads].sort((a, b) => {
            const aKey = (a.last_sent_at || a.created_at).getTime();
            const bKey = (b.last_sent_at || b.created_at).getTime();
            return bKey - aKey;
        });
        assignedCampaignId = sorted[0].campaign_id;
    }

    // 4. Derive last_activity_at from the latest observable signal across all sources.
    //    Includes existing Lead.last_activity_at so we never move the timestamp backwards,
    //    plus the latest SendEvent/ReplyEvent (authoritative event tables) and every
    //    per-campaign-lead timestamp. Queries the two event tables only when we know
    //    they contain rows for this email, to avoid unnecessary round-trips.
    const latestSendDate = sendCount > 0
        ? (await prisma.sendEvent.findFirst({
            where: { organization_id, recipient_email: email },
            orderBy: { sent_at: 'desc' },
            select: { sent_at: true },
        }))?.sent_at ?? null
        : null;
    const latestReplyDate = replyCount > 0
        ? (await prisma.replyEvent.findFirst({
            where: { organization_id, recipient_email: email },
            orderBy: { replied_at: 'desc' },
            select: { replied_at: true },
        }))?.replied_at ?? null
        : null;
    const allCandidates: Array<Date | null> = [
        lead.last_activity_at,
        latestSendDate,
        latestReplyDate,
        ...campaignLeads.map((cl) => cl.last_sent_at),
        ...campaignLeads.map((cl) => cl.replied_at),
        ...campaignLeads.map((cl) => cl.bounced_at),
        ...campaignLeads.map((cl) => cl.unsubscribed_at),
    ];
    const finalLastActivityAt = allCandidates
        .filter((d): d is Date => d instanceof Date)
        .reduce<Date | null>((max, d) => (max === null || d > max ? d : max), null);

    // 5. Decide whether to transition status held → active.
    //    Rules:
    //      - If lead is 'held' AND has at least one CampaignLead whose status is
    //        active/paused (i.e. still in the sequencer), transition to ACTIVE.
    //      - Leads whose only CampaignLeads are already replied/completed/bounced/unsubscribed
    //        do NOT get transitioned to active by the backfill — the outbound lifecycle
    //        is already over for them.
    const hasActiveCampaignLead = campaignLeads.some(
        (cl) => cl.status === 'active' || cl.status === 'paused',
    );
    const shouldTransitionToActive = lead.status === 'held' && hasActiveCampaignLead;

    // 6. Compose the "after" snapshot and early-exit if nothing would change.
    const after = {
        emails_sent: sendCount,
        emails_opened: opensSum,
        emails_clicked: clicksSum,
        emails_replied: replyCount,
        bounced: anyBounced,
        assigned_campaign_id: assignedCampaignId,
        last_activity_at: finalLastActivityAt,
    };

    const before = {
        emails_sent: lead.emails_sent,
        emails_opened: lead.emails_opened,
        emails_clicked: lead.emails_clicked,
        emails_replied: lead.emails_replied,
        bounced: lead.bounced,
        assigned_campaign_id: lead.assigned_campaign_id,
        status: lead.status,
        last_activity_at: lead.last_activity_at,
    };

    const diff: string[] = [];
    if (before.emails_sent !== after.emails_sent) diff.push(`emails_sent ${before.emails_sent} → ${after.emails_sent}`);
    if (before.emails_opened !== after.emails_opened) diff.push(`emails_opened ${before.emails_opened} → ${after.emails_opened}`);
    if (before.emails_clicked !== after.emails_clicked) diff.push(`emails_clicked ${before.emails_clicked} → ${after.emails_clicked}`);
    if (before.emails_replied !== after.emails_replied) diff.push(`emails_replied ${before.emails_replied} → ${after.emails_replied}`);
    if (before.bounced !== after.bounced) diff.push(`bounced ${before.bounced} → ${after.bounced}`);
    if (before.assigned_campaign_id !== after.assigned_campaign_id) {
        diff.push(`assigned_campaign_id ${before.assigned_campaign_id ?? 'null'} → ${after.assigned_campaign_id ?? 'null'}`);
    }
    if (before.last_activity_at?.getTime() !== after.last_activity_at?.getTime()) {
        diff.push(`last_activity_at ${before.last_activity_at?.toISOString() ?? 'null'} → ${after.last_activity_at?.toISOString() ?? 'null'}`);
    }
    if (shouldTransitionToActive) diff.push(`status held → active`);

    if (diff.length === 0) return null;

    return { leadId: id, email, organizationId: organization_id, before, after, shouldTransitionToActive, diff };
}

// ─── Inline status transition ──────────────────────────────────────────────
//
// Mirrors entityStateService.transitionLead's essential writes without pulling in
// the full service (which would drag src/index.ts and every worker into the
// script's process). Valid transitions for Lead are already enforced by the
// validTransitions map below — matches types/index.ts STATE_TRANSITIONS.lead.

const VALID_LEAD_TRANSITIONS: Record<string, string[]> = {
    held: ['active', 'paused', 'blocked'],
    active: ['paused', 'completed', 'blocked'],
    paused: ['active', 'completed', 'blocked'],
    blocked: [],
    completed: [],
};

async function applyStatusTransition(
    leadId: string,
    organizationId: string,
    fromState: string,
    toState: string,
): Promise<boolean> {
    const allowed = VALID_LEAD_TRANSITIONS[fromState] || [];
    if (!allowed.includes(toState)) {
        console.error(`  FAILED status transition for ${leadId}: ${fromState} → ${toState} not allowed`);
        return false;
    }
    try {
        await prisma.$transaction([
            prisma.lead.update({
                where: { id: leadId },
                data: { status: toState },
            }),
            prisma.stateTransition.create({
                data: {
                    organization_id: organizationId,
                    entity_type: 'lead',
                    entity_id: leadId,
                    from_state: fromState,
                    to_state: toState,
                    reason: 'Backfill: lead has active CampaignLead rows but was stuck in held',
                    triggered_by: 'system',
                },
            }),
            prisma.auditLog.create({
                data: {
                    organization_id: organizationId,
                    entity: 'lead',
                    entity_id: leadId,
                    trigger: 'backfill_script',
                    action: `transition_${fromState}_to_${toState}`,
                    details: 'Backfill reconciled status with CampaignLead state',
                },
            }),
        ]);
        return true;
    } catch (err) {
        console.error(`  FAILED status transition for ${leadId}: ${(err as Error).message}`);
        return false;
    }
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
    const flags = parseFlags(process.argv.slice(2));

    console.log('─────────────────────────────────────────────────────────────────');
    console.log('Lead stats backfill from sequencer event tables');
    console.log('─────────────────────────────────────────────────────────────────');
    console.log(`Mode:          ${flags.live ? 'LIVE (will write to DB)' : 'DRY-RUN (no writes)'}`);
    if (flags.emailFilter) console.log(`Email filter:  ${flags.emailFilter}`);
    if (flags.orgFilter) console.log(`Org filter:    ${flags.orgFilter}`);
    console.log('');

    const where: Record<string, unknown> = { deleted_at: null };
    if (flags.emailFilter) where.email = flags.emailFilter;
    if (flags.orgFilter) where.organization_id = flags.orgFilter;

    const leads = await prisma.lead.findMany({
        where,
        select: {
            id: true,
            email: true,
            organization_id: true,
            emails_sent: true,
            emails_opened: true,
            emails_clicked: true,
            emails_replied: true,
            bounced: true,
            assigned_campaign_id: true,
            status: true,
            last_activity_at: true,
        },
        orderBy: { created_at: 'asc' },
    });

    console.log(`Loaded ${leads.length} Lead row(s) matching filters.`);
    console.log('');

    const changes: Change[] = [];
    let skipped = 0;

    for (const lead of leads) {
        const change = await computeChangeForLead(lead);
        if (change) changes.push(change);
        else skipped++;
    }

    console.log(`Leads already in sync:  ${skipped}`);
    console.log(`Leads to update:        ${changes.length}`);
    console.log('');

    if (changes.length === 0) {
        console.log('Nothing to do.');
        await prisma.$disconnect();
        return;
    }

    // Print preview (first 10, or all if filtered to a specific email)
    const previewLimit = flags.emailFilter ? changes.length : Math.min(10, changes.length);
    console.log(`─── Preview (${previewLimit} of ${changes.length}) ───`);
    for (const c of changes.slice(0, previewLimit)) {
        console.log(`\n  ${c.email}  [lead ${c.leadId}]`);
        for (const d of c.diff) console.log(`    - ${d}`);
    }
    console.log('');

    if (!flags.live) {
        console.log('DRY-RUN: no writes performed. Re-run with --live to apply.');
        await prisma.$disconnect();
        return;
    }

    // ─── Live apply ────────────────────────────────────────────────────────
    console.log('Applying changes...');
    let applied = 0;
    let transitioned = 0;
    let failed = 0;

    for (const c of changes) {
        try {
            await prisma.lead.update({
                where: { id: c.leadId },
                data: {
                    emails_sent: c.after.emails_sent,
                    emails_opened: c.after.emails_opened,
                    emails_clicked: c.after.emails_clicked,
                    emails_replied: c.after.emails_replied,
                    bounced: c.after.bounced,
                    assigned_campaign_id: c.after.assigned_campaign_id,
                    last_activity_at: c.after.last_activity_at,
                },
            });
            applied++;

            if (c.shouldTransitionToActive) {
                const ok = await applyStatusTransition(c.leadId, c.organizationId, c.before.status, 'active');
                if (ok) transitioned++;
            }
        } catch (err) {
            failed++;
            console.error(`  FAILED: ${c.email} — ${(err as Error).message}`);
        }
    }

    console.log('');
    console.log('─── Results ───');
    console.log(`Counter updates applied:  ${applied} / ${changes.length}`);
    console.log(`Status transitions:       ${transitioned}`);
    console.log(`Failures:                 ${failed}`);

    await prisma.$disconnect();
}

main().catch(async (err) => {
    console.error('Backfill failed:', err);
    await prisma.$disconnect();
    process.exit(1);
});
