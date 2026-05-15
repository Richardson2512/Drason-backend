/**
 * SequenceStepExecution audit writer.
 *
 * Every step dispatch attempt - successful, failed, skipped, or branched -
 * writes a row here. The dispatcher (Phase 5) calls these. Until then, the
 * functions are unused but available so the contract is stable when the
 * dispatcher lands.
 *
 * The audit table is INSERT-only from this service. Updates only happen on
 * the row written by markScheduled() when the dispatcher later reports the
 * SENT/FAILED outcome (see markSent / markFailed).
 */

import { Prisma } from '@prisma/client';
import { prisma } from '../../prisma';
import { logger } from '../observabilityService';

export type ExecStatus = 'SCHEDULED' | 'SENT' | 'FAILED' | 'SKIPPED' | 'BRANCHED';
export type SenderRefType = 'mailbox' | 'linkedin_account';

export interface MarkScheduledInput {
    organization_id: string;
    campaign_id: string;
    campaign_lead_id: string;
    sequence_step_id: string;
    step_number: number;
    step_type: string;
    sender_ref_id?: string | null;
    sender_ref_type?: SenderRefType | null;
}

/** Insert a SCHEDULED row when the step enters the dispatch queue. */
export async function markScheduled(input: MarkScheduledInput): Promise<string> {
    const row = await prisma.sequenceStepExecution.create({
        data: {
            organization_id: input.organization_id,
            campaign_id: input.campaign_id,
            campaign_lead_id: input.campaign_lead_id,
            sequence_step_id: input.sequence_step_id,
            step_number: input.step_number,
            step_type: input.step_type,
            status: 'SCHEDULED',
            sender_ref_id: input.sender_ref_id ?? null,
            sender_ref_type: input.sender_ref_type ?? null,
        },
        select: { id: true },
    });
    return row.id;
}

export interface MarkSkippedInput extends MarkScheduledInput {
    skip_reason: string;
}

/** SKIPPED rows have status='SKIPPED' from inception - never SCHEDULED. */
export async function markSkipped(input: MarkSkippedInput): Promise<void> {
    await prisma.sequenceStepExecution.create({
        data: {
            organization_id: input.organization_id,
            campaign_id: input.campaign_id,
            campaign_lead_id: input.campaign_lead_id,
            sequence_step_id: input.sequence_step_id,
            step_number: input.step_number,
            step_type: input.step_type,
            status: 'SKIPPED',
            skip_reason: input.skip_reason,
            sender_ref_id: input.sender_ref_id ?? null,
            sender_ref_type: input.sender_ref_type ?? null,
            completed_at: new Date(),
        },
    });
}

export interface MarkBranchedInput extends MarkScheduledInput {
    branched_to_step: number;
    branch_reason?: string;
}

/** BRANCHED rows record the runtime jump triggered by step.condition. */
export async function markBranched(input: MarkBranchedInput): Promise<void> {
    await prisma.sequenceStepExecution.create({
        data: {
            organization_id: input.organization_id,
            campaign_id: input.campaign_id,
            campaign_lead_id: input.campaign_lead_id,
            sequence_step_id: input.sequence_step_id,
            step_number: input.step_number,
            step_type: input.step_type,
            status: 'BRANCHED',
            branched_to_step: input.branched_to_step,
            skip_reason: input.branch_reason ?? null,
            completed_at: new Date(),
        },
    });
}

export async function markSent(executionId: string): Promise<void> {
    try {
        await prisma.sequenceStepExecution.update({
            where: { id: executionId },
            data: { status: 'SENT', completed_at: new Date() },
        });
    } catch (err) {
        // The partial unique index
        //   (campaign_lead_id, step_number) WHERE status = 'SENT'
        // fired: a sibling row already records THIS exact (lead, step)
        // as delivered - a stalled job re-run, or a second tick that
        // also cleared the pre-dispatch guard. The step IS delivered
        // (by the sibling row); this attempt's row simply stays
        // SCHEDULED as harmless audit noise. Swallow so the caller does
        // NOT markFailed a step that actually succeeded, and the lead is
        // not double-advanced. This is the LinkedIn analogue of the
        // SendEvent unique backstop on the email side.
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
            logger.warn('[STEP-EXEC] markSent suppressed - (lead, step) already recorded SENT', { executionId });
            return;
        }
        throw err;
    }
}

export async function markFailed(executionId: string, errorMessage: string): Promise<void> {
    await prisma.sequenceStepExecution.update({
        where: { id: executionId },
        data: { status: 'FAILED', error_message: errorMessage.slice(0, 1000), completed_at: new Date() },
    });
}

// ────────────────────────────────────────────────────────────────────
// Reads - used by Lead Analytics and the dashboard
// ────────────────────────────────────────────────────────────────────

export interface LeadExecutionTimelineEntry {
    id: string;
    step_number: number;
    step_type: string;
    status: ExecStatus;
    skip_reason: string | null;
    branched_to_step: number | null;
    sender_ref_id: string | null;
    sender_ref_type: SenderRefType | null;
    attempted_at: Date;
    completed_at: Date | null;
    error_message: string | null;
}

/** Full step-by-step history for one lead - ordered by attempt time. */
export async function listForLead(organizationId: string, campaignLeadId: string): Promise<LeadExecutionTimelineEntry[]> {
    try {
        const rows = await prisma.sequenceStepExecution.findMany({
            where: { organization_id: organizationId, campaign_lead_id: campaignLeadId },
            orderBy: { attempted_at: 'asc' },
        });
        return rows.map(r => ({
            id: r.id,
            step_number: r.step_number,
            step_type: r.step_type,
            status: r.status as ExecStatus,
            skip_reason: r.skip_reason,
            branched_to_step: r.branched_to_step,
            sender_ref_id: r.sender_ref_id,
            sender_ref_type: r.sender_ref_type as SenderRefType | null,
            attempted_at: r.attempted_at,
            completed_at: r.completed_at,
            error_message: r.error_message,
        }));
    } catch (err) {
        logger.error('[STEP-EXEC] listForLead failed', err instanceof Error ? err : new Error(String(err)));
        return [];
    }
}

/** Aggregate skip-reason counts for a campaign - drives the analytics drilldown. */
export async function aggregateSkipsForCampaign(organizationId: string, campaignId: string): Promise<Record<string, number>> {
    const rows = await prisma.sequenceStepExecution.groupBy({
        by: ['skip_reason'],
        where: {
            organization_id: organizationId,
            campaign_id: campaignId,
            status: 'SKIPPED',
            NOT: { skip_reason: null },
        },
        _count: { _all: true },
    });
    const out: Record<string, number> = {};
    for (const r of rows) {
        if (r.skip_reason) out[r.skip_reason] = r._count._all;
    }
    return out;
}
