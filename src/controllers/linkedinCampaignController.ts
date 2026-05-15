/**
 * LinkedIn campaign controller - pre-launch validation + sender management.
 *
 *   POST /api/linkedin/campaigns/:id/validate    - run the validator
 *   POST /api/linkedin/campaigns/:id/senders     - attach a sender pool
 *   GET  /api/linkedin/campaigns/:id/senders     - list senders for campaign
 *   DELETE /api/linkedin/campaigns/:id/senders/:senderId
 *
 * Campaign CRUD itself lives in the existing sequencer routes - these
 * endpoints add the LinkedIn-specific surfaces.
 */

import { Request, Response } from 'express';
import crypto from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { getOrgId } from '../middleware/orgContext';
import { runPreLaunchValidation } from '../services/linkedin/preLaunchValidator';
import { STEP_TYPES, validateStepConfig } from '../services/sequencer/stepTypeRegistry';

// Step types this LinkedIn-only campaign creator accepts. The unified
// sequencer wizard handles mixed-channel + email campaigns; this endpoint
// rejects anything outside the LinkedIn vocabulary so a Super LinkedIn
// campaign can't accidentally ship an email step.
const LINKEDIN_STEP_TYPES: ReadonlySet<string> = new Set([
    'linkedin_view_profile',
    'linkedin_follow',
    'linkedin_like_post',
    'linkedin_connection_request',
    'linkedin_message',
    'linkedin_inmail',
]);

// ────────────────────────────────────────────────────────────────────
// GET /api/linkedin/campaigns/step-types
//
// Returns the curated LinkedIn step-type catalogue the wizard renders.
// We project from STEP_TYPE_REGISTRY so the source of truth lives with
// the dispatcher; the wizard only sees the LinkedIn subset.
// ────────────────────────────────────────────────────────────────────

export const listStepTypes = async (_req: Request, res: Response): Promise<Response> => {
    const types = Array.from(LINKEDIN_STEP_TYPES).map(key => {
        const meta = STEP_TYPES[key];
        return {
            key,
            label: meta?.label ?? key,
            description: meta?.description ?? '',
            required_sender: meta?.required_sender ?? 'linkedin_account',
            preconditions: meta?.preconditions ?? [],
            config_schema: meta?.config_schema ?? {},
            config_enums: meta && 'config_enums' in meta ? (meta as unknown as Record<string, unknown>).config_enums : undefined,
        };
    });
    return res.json({ success: true, data: types });
};

// ────────────────────────────────────────────────────────────────────
// POST /api/linkedin/campaigns
//
// Atomic LinkedIn-only campaign create:
//   1. Validate body - name, ≥1 sender, ≥1 step, all step_types in the
//      LinkedIn vocabulary
//   2. Verify every sender_id belongs to this org
//   3. Create Campaign (status='draft' so the dispatcher won't touch it
//      until launch), the SequenceSteps, and the CampaignLinkedInSender
//      attachments in a single transaction
//
// On success returns { id }. The wizard then routes to /campaigns/:id
// where the operator adds leads + clicks Launch.
// ────────────────────────────────────────────────────────────────────

interface IncomingStep {
    step_number: number;
    step_type: string;
    delay_days?: number;
    delay_hours?: number;
    subject?: string;
    body_html?: string;
    body_text?: string;
    condition?: string | null;
    step_config?: Record<string, unknown>;
}

interface IncomingSender {
    linkedin_account_id: string;
    max_invites_per_day?: number;
    max_messages_per_day?: number;
    max_inmails_per_day?: number;
    rotation_priority?: number;
}

export const create = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const body = (req.body ?? {}) as {
            name?: string;
            description?: string;
            stop_on_reply?: boolean;
            senders?: IncomingSender[];
            steps?: IncomingStep[];
        };

        // ── 1. Validate body ───────────────────────────────────────────
        const name = (body.name ?? '').toString().trim();
        if (!name) return res.status(400).json({ success: false, error: 'name is required' });
        if (name.length > 160) return res.status(400).json({ success: false, error: 'name must be 160 characters or fewer' });

        const senders = Array.isArray(body.senders) ? body.senders : [];
        if (senders.length === 0) {
            return res.status(400).json({ success: false, error: 'At least one sender is required for a LinkedIn campaign' });
        }

        const steps = Array.isArray(body.steps) ? body.steps : [];
        if (steps.length === 0) {
            return res.status(400).json({ success: false, error: 'At least one sequence step is required' });
        }

        // Reject any non-LinkedIn step types up-front. Super LinkedIn is
        // single-channel by design - mixed campaigns belong on the email
        // side wizard.
        //
        // Also validate each step's `step_config` against the type's
        // schema. The registry encodes per-type allowed keys, primitive
        // types, AND enum domains (e.g. linkedin_like_post.reaction_type
        // ∈ LIKE | PRAISE | EMPATHY | INTEREST | APPRECIATION | MAYBE |
        // FUNNY). Without this gate the dispatcher hits a runtime "Unipile
        // rejected reaction_type" error 12 hours after launch.
        for (const s of steps) {
            if (!LINKEDIN_STEP_TYPES.has(s.step_type)) {
                return res.status(400).json({
                    success: false,
                    error: `Step type "${s.step_type}" is not allowed in a LinkedIn campaign. Use the email-side campaign wizard for multi-channel sequences.`,
                });
            }
            const cfgIssues = validateStepConfig(s.step_type, s.step_config ?? {});
            if (cfgIssues.length > 0) {
                return res.status(400).json({
                    success: false,
                    error: `Step ${s.step_number} (${s.step_type}) has invalid config: ${cfgIssues.map(i => i.message).join('; ')}`,
                    issues: cfgIssues,
                });
            }
        }

        // Step numbers must be unique + start at 1. Don't trust the
        // client's ordering - sort + renumber so the dispatcher sees a
        // clean monotonic sequence.
        const sortedSteps = [...steps].sort((a, b) => a.step_number - b.step_number);

        // ── 2. Verify sender ownership ────────────────────────────────
        const senderIds = senders.map(s => s.linkedin_account_id);
        const ownedSenders = await prisma.linkedInAccount.findMany({
            where: { id: { in: senderIds }, organization_id: orgId },
            select: { id: true, status: true },
        });
        if (ownedSenders.length !== senderIds.length) {
            return res.status(400).json({
                success: false,
                error: 'One or more sender accounts are not owned by this organisation',
            });
        }

        // ── 3. Atomic create ──────────────────────────────────────────
        const created = await prisma.$transaction(async (tx) => {
            const campaign = await tx.campaign.create({
                data: {
                    id: crypto.randomUUID(),
                    organization_id: orgId,
                    name,
                    status: 'draft',
                    channel: 'linkedin',
                    stop_on_reply: body.stop_on_reply !== false, // default true
                },
            });

            if (sortedSteps.length > 0) {
                await tx.sequenceStep.createMany({
                    data: sortedSteps.map((s, idx) => ({
                        campaign_id: campaign.id,
                        step_number: idx + 1,
                        step_type: s.step_type,
                        delay_days: Math.max(0, s.delay_days ?? 0),
                        delay_hours: Math.max(0, s.delay_hours ?? 0),
                        subject: s.subject ?? '',
                        body_html: s.body_html ?? '',
                        body_text: s.body_text ?? null,
                        condition: s.condition ?? null,
                        step_config: (s.step_config ?? {}) as Prisma.InputJsonValue,
                    })),
                });
            }

            if (senders.length > 0) {
                await tx.campaignLinkedInSender.createMany({
                    data: senders.map((s, idx) => ({
                        campaign_id: campaign.id,
                        linkedin_account_id: s.linkedin_account_id,
                        max_invites_per_day: s.max_invites_per_day ?? null,
                        max_messages_per_day: s.max_messages_per_day ?? null,
                        max_inmails_per_day: s.max_inmails_per_day ?? null,
                        rotation_priority: s.rotation_priority ?? idx,
                        enabled: true,
                    })),
                });
            }

            return campaign;
        });

        return res.status(201).json({ success: true, data: { id: created.id, name: created.name } });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return res.status(500).json({ success: false, error: msg });
    }
};

// ────────────────────────────────────────────────────────────────────
// POST /api/linkedin/campaigns/:id/launch
//
// Pre-launch validates (existing `runPreLaunchValidation` covers the
// rules + capacity + sequence shape). If the report has no ERROR-level
// issues, flips the campaign to status='active' and stamps launched_at.
// Returns the report either way so the UI can surface warnings even on
// success.
// ────────────────────────────────────────────────────────────────────

export const launch = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const id = String(req.params.id);

        const campaign = await prisma.campaign.findFirst({
            where: { id, organization_id: orgId, deleted_at: null },
            select: { id: true, status: true },
        });
        if (!campaign) return res.status(404).json({ success: false, error: 'Campaign not found' });
        if (campaign.status === 'active' || campaign.status === 'ongoing') {
            return res.status(400).json({ success: false, error: 'Campaign is already active' });
        }

        const report = await runPreLaunchValidation({ organizationId: orgId, campaignId: id });
        if (!report.can_launch) {
            return res.status(400).json({ success: false, error: 'Pre-launch validation failed', data: report });
        }

        // Re-read status inside the transaction so a concurrent launch
        // that flipped to 'active' between our initial check and here
        // doesn't get double-launched. Without this guard, two operators
        // (or one operator + an agent) hitting Launch within ~50ms each
        // pass the precondition and both write status='active', and the
        // SequenceStepExecution audit ends up with two SCHEDULED rows
        // for step #1 on the same lead.
        let launched;
        try {
            launched = await prisma.$transaction(async (tx) => {
                const fresh = await tx.campaign.findUnique({
                    where: { id },
                    select: { status: true },
                });
                if (!fresh) throw Object.assign(new Error('Campaign disappeared during launch'), { http: 404 });
                if (fresh.status === 'active' || fresh.status === 'ongoing') {
                    throw Object.assign(new Error('Campaign is already active'), { http: 400 });
                }
                return tx.campaign.update({
                    where: { id },
                    data: { status: 'active', launched_at: new Date() },
                    select: { id: true, status: true, launched_at: true },
                });
            });
        } catch (txErr: any) {
            if (txErr?.http) {
                return res.status(txErr.http).json({ success: false, error: txErr.message });
            }
            throw txErr;
        }

        return res.json({ success: true, data: { campaign: launched, report } });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return res.status(500).json({ success: false, error: msg });
    }
};

/**
 * POST /api/linkedin/campaigns/:id/pause
 *
 * Channel-scoped pause for the LinkedIn UI. The underlying Campaign
 * table is shared with email - pausing here flips status='paused' the
 * same way the sequencer route does - but the URL stays under
 * /api/linkedin/* so the frontend doesn't have to cross-talk to a
 * "foreign" controller, and the 404 path enforces that this endpoint
 * only operates on LinkedIn-channel campaigns.
 *
 * The shared dispatcher already skips status!='active' leads, so the
 * effect is immediate. Cross-channel suppression is unaffected
 * (CampaignLead.status stays as-is so already-paused leads from a reply
 * remain in their paused state when the campaign resumes).
 */
export const pause = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const id = String(req.params.id);
        const userId = req.orgContext?.userId;

        const existing = await prisma.campaign.findFirst({
            where: { id, organization_id: orgId, channel: 'linkedin', deleted_at: null },
            select: { id: true, status: true },
        });
        if (!existing) return res.status(404).json({ success: false, error: 'Campaign not found' });
        if (existing.status === 'paused') return res.status(400).json({ success: false, error: 'Campaign is already paused' });

        const updated = await prisma.campaign.update({
            where: { id },
            data: {
                status: 'paused',
                paused_at: new Date(),
                paused_by: userId ? 'user' : 'system',
                paused_reason: 'manual_pause_linkedin',
            },
            select: { id: true, status: true, paused_at: true },
        });
        return res.json({ success: true, data: updated });
    } catch (err) {
        return res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
    }
};

/**
 * POST /api/linkedin/campaigns/:id/resume
 *
 * Symmetric to pause. Channel-scoped. Resumes a paused LinkedIn
 * campaign by flipping status back to 'active'. Leads that were paused
 * by cross-channel suppression (replied on email) stay paused -
 * resume only affects campaign-level status.
 */
export const resume = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const id = String(req.params.id);

        const existing = await prisma.campaign.findFirst({
            where: { id, organization_id: orgId, channel: 'linkedin', deleted_at: null },
            select: { id: true, status: true },
        });
        if (!existing) return res.status(404).json({ success: false, error: 'Campaign not found' });
        if (existing.status !== 'paused') return res.status(400).json({ success: false, error: 'Campaign is not paused' });

        const updated = await prisma.campaign.update({
            where: { id },
            data: { status: 'active', paused_at: null, paused_by: null, paused_reason: null },
            select: { id: true, status: true },
        });
        return res.json({ success: true, data: updated });
    } catch (err) {
        return res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
    }
};

export const validate = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const report = await runPreLaunchValidation({
            organizationId: orgId,
            campaignId: String(req.params.id),
        });
        return res.json({ success: true, data: report });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return res.status(500).json({ success: false, error: msg });
    }
};

export const listSenders = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const rows = await prisma.campaignLinkedInSender.findMany({
            where: {
                campaign_id: String(req.params.id),
                campaign: { organization_id: orgId },
            },
            include: { linkedin_account: true },
            orderBy: { rotation_priority: 'asc' },
        });
        return res.json({
            success: true,
            data: rows.map(r => ({
                id: r.id,
                linkedin_account_id: r.linkedin_account_id,
                display_name: r.linkedin_account.display_name,
                account_type: r.linkedin_account.account_type,
                status: r.linkedin_account.status,
                max_invites_per_day: r.max_invites_per_day ?? r.linkedin_account.max_invites_per_day,
                max_messages_per_day: r.max_messages_per_day ?? r.linkedin_account.max_messages_per_day,
                max_inmails_per_day: r.max_inmails_per_day ?? r.linkedin_account.max_inmails_per_day,
                working_hours: r.working_hours,
                rotation_priority: r.rotation_priority,
                enabled: r.enabled,
            })),
        });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return res.status(500).json({ success: false, error: msg });
    }
};

export const attachSender = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const campaignId = String(req.params.id);
        const { linkedin_account_id, max_invites_per_day, max_messages_per_day,
                max_inmails_per_day, working_hours, rotation_priority } = req.body || {};

        if (!linkedin_account_id) {
            return res.status(400).json({ success: false, error: 'linkedin_account_id is required' });
        }

        // Verify campaign + account both belong to this org.
        const [campaign, account] = await Promise.all([
            prisma.campaign.findFirst({ where: { id: campaignId, organization_id: orgId, deleted_at: null }, select: { id: true } }),
            prisma.linkedInAccount.findFirst({ where: { id: linkedin_account_id, organization_id: orgId }, select: { id: true } }),
        ]);
        if (!campaign) return res.status(404).json({ success: false, error: 'Campaign not found' });
        if (!account) return res.status(404).json({ success: false, error: 'LinkedIn account not found' });

        const row = await prisma.campaignLinkedInSender.upsert({
            where: { campaign_id_linkedin_account_id: { campaign_id: campaignId, linkedin_account_id } },
            create: {
                campaign_id: campaignId,
                linkedin_account_id,
                max_invites_per_day,
                max_messages_per_day,
                max_inmails_per_day,
                working_hours: working_hours ?? undefined,
                rotation_priority: rotation_priority ?? 0,
            },
            update: {
                max_invites_per_day,
                max_messages_per_day,
                max_inmails_per_day,
                working_hours: working_hours ?? undefined,
                rotation_priority: rotation_priority ?? 0,
                enabled: true,
            },
        });
        return res.status(201).json({ success: true, data: { id: row.id } });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return res.status(500).json({ success: false, error: msg });
    }
};

// ────────────────────────────────────────────────────────────────────
// GET /api/linkedin/campaigns/:id - single-campaign detail
//
// Returns the Campaign row + its CampaignLinkedInSender attachments +
// the SequenceSteps it owns (filtered to LinkedIn step types). Used by
// the LinkedIn campaign detail page to render the header, sender pool,
// and sequence schema button.
// ────────────────────────────────────────────────────────────────────

export const detail = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const id = String(req.params.id);

        // Channel discipline: Super LinkedIn is LinkedIn-only by design.
        // Mixed (email + LinkedIn) and email-only campaigns belong to the
        // Sequencer surfaces - we 404 them out of the LinkedIn detail
        // endpoint so the schema/detail pages never render an email step
        // under the LinkedIn module.
        const campaign = await prisma.campaign.findFirst({
            where: { id, organization_id: orgId, channel: 'linkedin', deleted_at: null },
            include: {
                linkedinSenders: {
                    include: { linkedin_account: true },
                    orderBy: { rotation_priority: 'asc' },
                },
                steps: {
                    orderBy: { step_number: 'asc' },
                    select: {
                        id: true,
                        step_number: true,
                        step_type: true,
                        delay_days: true,
                        delay_hours: true,
                        subject: true,
                        body_html: true,
                        body_text: true,
                    },
                },
            },
        });
        if (!campaign) return res.status(404).json({ success: false, error: 'Campaign not found' });

        // CampaignLead totals scoped to this campaign - gives the detail page
        // its enrollment-stats row without a second request.
        const [pending, inSequence, finished, replied, totalLeads] = await Promise.all([
            prisma.campaignLead.count({ where: { campaign_id: id, status: 'pending' } }),
            prisma.campaignLead.count({ where: { campaign_id: id, status: 'active' } }),
            prisma.campaignLead.count({ where: { campaign_id: id, status: 'completed' } }),
            prisma.campaignLead.count({ where: { campaign_id: id, status: 'replied' } }),
            prisma.campaignLead.count({ where: { campaign_id: id } }),
        ]);

        return res.json({
            success: true,
            data: {
                campaign: {
                    id: campaign.id,
                    name: campaign.name,
                    status: campaign.status,
                    stop_on_reply: campaign.stop_on_reply,
                    created_at: campaign.created_at.toISOString(),
                    updated_at: campaign.updated_at.toISOString(),
                },
                senders: campaign.linkedinSenders.map(s => ({
                    id: s.id,
                    linkedin_account_id: s.linkedin_account_id,
                    display_name: s.linkedin_account.display_name,
                    account_type: s.linkedin_account.account_type,
                    status: s.linkedin_account.status,
                    max_invites_per_day: s.max_invites_per_day ?? s.linkedin_account.max_invites_per_day,
                    max_messages_per_day: s.max_messages_per_day ?? s.linkedin_account.max_messages_per_day,
                    max_inmails_per_day: s.max_inmails_per_day ?? s.linkedin_account.max_inmails_per_day,
                    working_hours: s.working_hours,
                    rotation_priority: s.rotation_priority,
                    enabled: s.enabled,
                })),
                steps: campaign.steps,
                counts: { total_leads: totalLeads, pending, in_sequence: inSequence, finished, replied },
            },
        });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return res.status(500).json({ success: false, error: msg });
    }
};

// ────────────────────────────────────────────────────────────────────
// PATCH /api/linkedin/campaigns/:id
//
// Edit-in-place for an existing LinkedIn-channel campaign. Accepts the
// same body shape as the create endpoint (name / stop_on_reply /
// senders[] / steps[]) and applies it as a full replace of steps + sender
// attachments, scalar updates on name + stop_on_reply.
//
// Channel discipline: refuses to operate on mixed/email campaigns. Step
// validation re-uses the LINKEDIN_STEP_TYPES whitelist so an Edit can't
// sneak email steps into a LinkedIn campaign either.
// ────────────────────────────────────────────────────────────────────

export const update = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const id = String(req.params.id);
        const body = (req.body ?? {}) as {
            name?: string;
            stop_on_reply?: boolean;
            senders?: IncomingSender[];
            steps?: IncomingStep[];
        };

        const existing = await prisma.campaign.findFirst({
            where: { id, organization_id: orgId, channel: 'linkedin', deleted_at: null },
            select: { id: true, status: true },
        });
        if (!existing) return res.status(404).json({ success: false, error: 'Campaign not found' });
        if (existing.status === 'completed' || existing.status === 'archived') {
            return res.status(400).json({ success: false, error: 'Completed or archived campaigns cannot be edited.' });
        }

        const senders = Array.isArray(body.senders) ? body.senders : null;
        const steps = Array.isArray(body.steps) ? body.steps : null;

        if (steps) {
            for (const s of steps) {
                if (!LINKEDIN_STEP_TYPES.has(s.step_type)) {
                    return res.status(400).json({
                        success: false,
                        error: `Step type "${s.step_type}" is not allowed in a LinkedIn campaign. Use the email-side wizard for multi-channel sequences.`,
                    });
                }
                const cfgIssues = validateStepConfig(s.step_type, s.step_config ?? {});
                if (cfgIssues.length > 0) {
                    return res.status(400).json({
                        success: false,
                        error: `Step ${s.step_number} (${s.step_type}) has invalid config: ${cfgIssues.map(i => i.message).join('; ')}`,
                        issues: cfgIssues,
                    });
                }
            }
        }

        if (senders) {
            const senderIds = senders.map(s => s.linkedin_account_id);
            if (senderIds.length === 0) {
                return res.status(400).json({ success: false, error: 'At least one sender is required for a LinkedIn campaign' });
            }
            const owned = await prisma.linkedInAccount.findMany({
                where: { id: { in: senderIds }, organization_id: orgId },
                select: { id: true },
            });
            if (owned.length !== senderIds.length) {
                return res.status(400).json({ success: false, error: 'One or more sender accounts are not owned by this organisation' });
            }
        }

        // ────────────────────────────────────────────────────────────
        // Edit-while-running safety gate.
        //
        // Replacing the SequenceStep list on a campaign that has leads
        // mid-flight strands them: their CampaignLead.current_step points
        // at slots in the OLD step list. Dropping rows and renumbering
        // either re-runs a completed step (re-send → duplicate touches)
        // or skips them past the end (silent finish without ever sending
        // the remaining steps).
        //
        // For non-draft campaigns we enforce three invariants on the
        // incoming step list:
        //   1. It must be at least as long as the furthest-progressed
        //      active lead. Truncating below max(current_step) is
        //      irreversible data loss.
        //   2. Steps at positions [1..maxCurrentStep] must keep their
        //      step_type - these are the steps active leads have already
        //      executed, and changing their type after the fact lies to
        //      analytics + breaks branching predicates.
        //   3. Removing a sender that has in-flight invitations / threads
        //      leaves orphans the dispatcher can't recover. We allow
        //      adding senders, removing senders with zero outstanding
        //      sends; the rest is blocked.
        //
        // Draft campaigns are unrestricted - nothing has dispatched yet.
        const isMidFlight = existing.status !== 'draft';

        if (isMidFlight && steps) {
            const existingSteps = await prisma.sequenceStep.findMany({
                where: { campaign_id: id },
                orderBy: { step_number: 'asc' },
                select: { step_number: true, step_type: true },
            });
            const maxProgressAgg = await prisma.campaignLead.aggregate({
                where: { campaign_id: id },
                _max: { current_step: true },
            });
            const maxCurrentStep = maxProgressAgg._max.current_step ?? 0;

            const sortedNew = [...steps].sort((a, b) => a.step_number - b.step_number);

            // Invariant 1 - length floor.
            if (sortedNew.length < maxCurrentStep) {
                return res.status(400).json({
                    success: false,
                    error: `Cannot shrink the sequence below step ${maxCurrentStep} - ${maxCurrentStep === 1 ? 'a lead has' : 'leads have'} already advanced past that point. Pause the campaign and complete or archive in-flight leads before truncating.`,
                });
            }

            // Invariant 2 - step_type immutability up to maxCurrentStep.
            // Compare the prefix (1-indexed) against incoming step_type.
            for (let i = 0; i < maxCurrentStep && i < sortedNew.length; i++) {
                const oldType = existingSteps[i]?.step_type;
                const newType = sortedNew[i]?.step_type;
                if (oldType && newType && oldType !== newType) {
                    return res.status(400).json({
                        success: false,
                        error: `Step #${i + 1} type cannot change from "${oldType}" to "${newType}" - active leads have already executed it.`,
                    });
                }
            }
        }

        if (isMidFlight && senders) {
            const existingSenders = await prisma.campaignLinkedInSender.findMany({
                where: { campaign_id: id },
                select: { id: true, linkedin_account_id: true },
            });
            const incomingAccountIds = new Set(senders.map(s => s.linkedin_account_id));
            const removingAccountIds = existingSenders
                .filter(s => !incomingAccountIds.has(s.linkedin_account_id))
                .map(s => s.linkedin_account_id);

            if (removingAccountIds.length > 0) {
                // Block removal of LinkedIn accounts that have ever
                // dispatched on this campaign. SequenceStepExecution
                // stores the polymorphic sender_ref_id as the
                // LinkedInAccount.id for linkedin_* steps (see
                // linkedinDispatcherWorker - sender_ref_type =
                // 'linkedin_account'). If zero executions reference the
                // account, the attachment is safe to drop.
                const dispatchedCount = await prisma.sequenceStepExecution.count({
                    where: {
                        campaign_id: id,
                        sender_ref_type: 'linkedin_account',
                        sender_ref_id: { in: removingAccountIds },
                    },
                });
                if (dispatchedCount > 0) {
                    return res.status(400).json({
                        success: false,
                        error: 'Cannot detach a sender that has already dispatched on this campaign. Pause the campaign and reassign in-flight leads first, or keep the sender attached and disable it instead.',
                    });
                }
            }
        }

        await prisma.$transaction(async (tx) => {
            const scalarUpdate: { name?: string; stop_on_reply?: boolean } = {};
            if (typeof body.name === 'string' && body.name.trim().length > 0) scalarUpdate.name = body.name.trim();
            if (typeof body.stop_on_reply === 'boolean') scalarUpdate.stop_on_reply = body.stop_on_reply;
            if (Object.keys(scalarUpdate).length > 0) {
                await tx.campaign.update({ where: { id }, data: scalarUpdate });
            }

            if (steps) {
                // Full replace - drop existing steps, write new ones with
                // renumbered step_number. The pre-transaction guard above
                // ensured that this is safe: on non-draft campaigns the
                // new list preserves every step active leads have already
                // executed (same prefix length, same step_types).
                await tx.sequenceStep.deleteMany({ where: { campaign_id: id } });
                const sortedSteps = [...steps].sort((a, b) => a.step_number - b.step_number);
                if (sortedSteps.length > 0) {
                    await tx.sequenceStep.createMany({
                        data: sortedSteps.map((s, idx) => ({
                            campaign_id: id,
                            step_number: idx + 1,
                            step_type: s.step_type,
                            delay_days: Math.max(0, s.delay_days ?? 0),
                            delay_hours: Math.max(0, s.delay_hours ?? 0),
                            subject: s.subject ?? '',
                            body_html: s.body_html ?? '',
                            body_text: s.body_text ?? null,
                            condition: s.condition ?? null,
                            step_config: (s.step_config ?? {}) as Prisma.InputJsonValue,
                        })),
                    });
                }
            }

            if (senders) {
                // Full replace of the sender pool. Drop attachments not
                // present in the new list; upsert the ones that are.
                const incomingIds = new Set(senders.map(s => s.linkedin_account_id));
                await tx.campaignLinkedInSender.deleteMany({
                    where: { campaign_id: id, linkedin_account_id: { notIn: Array.from(incomingIds) } },
                });
                for (let idx = 0; idx < senders.length; idx++) {
                    const s = senders[idx];
                    await tx.campaignLinkedInSender.upsert({
                        where: {
                            campaign_id_linkedin_account_id: {
                                campaign_id: id,
                                linkedin_account_id: s.linkedin_account_id,
                            },
                        },
                        create: {
                            campaign_id: id,
                            linkedin_account_id: s.linkedin_account_id,
                            max_invites_per_day: s.max_invites_per_day ?? null,
                            max_messages_per_day: s.max_messages_per_day ?? null,
                            max_inmails_per_day: s.max_inmails_per_day ?? null,
                            rotation_priority: s.rotation_priority ?? idx,
                            enabled: true,
                        },
                        update: {
                            max_invites_per_day: s.max_invites_per_day ?? null,
                            max_messages_per_day: s.max_messages_per_day ?? null,
                            max_inmails_per_day: s.max_inmails_per_day ?? null,
                            rotation_priority: s.rotation_priority ?? idx,
                        },
                    });
                }
            }
        });

        return res.json({ success: true });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return res.status(500).json({ success: false, error: msg });
    }
};

export const detachSender = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const campaignId = String(req.params.id);
        const senderId = String(req.params.senderId);

        const row = await prisma.campaignLinkedInSender.findFirst({
            where: { id: senderId, campaign_id: campaignId, campaign: { organization_id: orgId } },
            select: { id: true, linkedin_account_id: true, campaign: { select: { status: true } } },
        });
        if (!row) return res.status(404).json({ success: false, error: 'Sender attachment not found' });

        // Match the PATCH safety gate: a sender that's already dispatched
        // on this campaign cannot be detached on a non-draft campaign
        // without orphaning the leads it's working. Operators who really
        // want it gone should disable it (enabled=false) - that stops new
        // sends while keeping the audit trail and connection edges intact.
        if (row.campaign.status !== 'draft') {
            const dispatchedCount = await prisma.sequenceStepExecution.count({
                where: {
                    campaign_id: campaignId,
                    sender_ref_type: 'linkedin_account',
                    sender_ref_id: row.linkedin_account_id,
                },
            });
            if (dispatchedCount > 0) {
                return res.status(400).json({
                    success: false,
                    error: 'Cannot detach a sender that has already dispatched on this campaign. Disable the sender attachment (enabled=false) to stop new sends without orphaning in-flight leads.',
                });
            }
        }

        await prisma.campaignLinkedInSender.delete({ where: { id: row.id } });
        return res.json({ success: true });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return res.status(500).json({ success: false, error: msg });
    }
};
