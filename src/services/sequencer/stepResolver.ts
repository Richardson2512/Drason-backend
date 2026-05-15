/**
 * Shared sequence step resolver — the single source of truth for
 * "given a lead's progress, what is the next deliverable step, and which
 * executor owns it."
 *
 * Why this module exists: the email dispatcher (sendQueueService) and the
 * LinkedIn worker (linkedinDispatcherWorker) historically each had their
 * OWN notion of "the next step". The email side resolved by `step_number`
 * with branch/condition awareness; the LinkedIn side indexed
 * `steps[current_step]` (array position, branch-blind). They agreed only
 * for contiguous 1..N step_number and silently ignored if/then logic on
 * LinkedIn steps. That divergence is the root cause of mixed-sequence
 * corruption. Both executors MUST resolve the next step through here so
 * there is exactly one implementation that cannot drift.
 *
 * This module is pure (no DB, no IO) and unit-tested.
 */

import { isLinkedInDispatcherStep } from './stepTypeRegistry';

/** Minimal structural shape the resolver needs. SequenceStepWithVariants
 *  (sendQueueService) and the Prisma SequenceStep row both satisfy it, so
 *  the generic resolver returns whatever concrete type the caller passes. */
export interface ResolverStep {
    step_number: number;
    step_type: string;
    condition?: string | null;
    branch_to_step_number?: number | null;
}

/** The CampaignLead-derived state a branching condition is evaluated against. */
export interface ResolverLeadState {
    replied_at?: Date | null;
    opened_count?: number | null;
    clicked_count?: number | null;
}

/** Who executes a resolved step. `terminal` = the lead is finished. */
export type StepOwner = 'email' | 'linkedin' | 'terminal';

/**
 * Evaluate a step's branching condition against a lead's CampaignLead
 * state. Returns true if the step should be sent. Unknown conditions
 * fail-open (treated as no condition) so a typo on the schema enum
 * doesn't silently stop the whole sequence.
 */
export function stepConditionMatches(
    condition: string | null | undefined,
    lead: ResolverLeadState,
): boolean {
    if (!condition) return true;
    const opens = lead.opened_count || 0;
    const clicks = lead.clicked_count || 0;
    switch (condition) {
        case 'if_no_reply':    return !lead.replied_at;
        case 'if_replied':     return !!lead.replied_at;
        case 'if_opened':      return opens > 0;
        case 'if_not_opened':  return opens === 0;
        case 'if_clicked':     return clicks > 0;
        case 'if_not_clicked': return clicks === 0;
        default:               return true;
    }
}

/**
 * Walk the sequence from `startNumber`, honoring per-step `condition` and
 * `branch_to_step_number` until we find a deliverable step or exhaust the
 * branch chain. Returns null when no step in the chain is eligible —
 * caller should mark the lead completed.
 *
 * Resolution is purely by `step_number` (never array position) so it is
 * correct regardless of how steps are ordered or numbered. Safety: capped
 * at 10 hops to defang accidental loops (a step that branches to itself,
 * or two steps that ping-pong via mutual branches).
 *
 * Generic so the caller gets its own concrete step type back (no cast).
 */
export function resolveDeliverableStep<T extends ResolverStep>(
    startNumber: number,
    steps: T[],
    lead: ResolverLeadState,
): T | null {
    let current: number | null = startNumber;
    let safety = 10;
    while (current != null && safety-- > 0) {
        const step = steps.find(s => s.step_number === current);
        if (!step) return null;
        if (stepConditionMatches(step.condition, lead)) return step;
        // Condition failed — try the branch if defined and not self-pointing.
        const branch = step.branch_to_step_number ?? null;
        if (branch == null || branch === current) return null;
        current = branch;
    }
    return null;
}

/**
 * Which executor owns a resolved step. Single source of truth, derived
 * from the step-type registry so the email dispatcher and the LinkedIn
 * worker can never disagree about whose job a step is:
 *
 *   - `end`                       → terminal (lead is finished)
 *   - linkedin_* / find_* utility → linkedin worker
 *   - everything else (`email`)   → email dispatcher
 */
export function classifyStepOwner(stepType: string): StepOwner {
    if (stepType === 'end') return 'terminal';
    if (isLinkedInDispatcherStep(stepType)) return 'linkedin';
    return 'email';
}
