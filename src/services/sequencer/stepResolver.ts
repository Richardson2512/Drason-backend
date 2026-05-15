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
 * THE single condition-outcome policy. Given whether a step's condition
 * passed and its branch target, decide what happens next. This is the ONE
 * place that rule lives — both the email resolver (below) and the LinkedIn
 * dispatcher call it, so the two channels can never again encode opposite
 * rules for the same construct (the mixed-sequence divergence root cause).
 *
 *   - condition passed                       → proceed (deliver this step)
 *   - failed, has a usable branch            → branch (jump to target)
 *   - failed, no branch (or self-pointing)   → skip_continue (skip THIS
 *     step, move on to the next step). A self-pointing branch is treated
 *     as "no usable branch" identically on both channels.
 *
 * Policy decision (product-owner ratified): a failed condition with no
 * branch SKIPS the one step and CONTINUES. Ending a lead only happens via
 * an explicit `end` step, a branch, or running off the last step. This is
 * the least-surprising behaviour and matches mainstream sequence tools.
 */
export type ConditionOutcome =
    | { kind: 'proceed' }
    | { kind: 'branch'; toStepNumber: number }
    | { kind: 'skip_continue' };

export function decideConditionOutcome(args: {
    conditionPassed: boolean;
    branchToStepNumber: number | null | undefined;
    currentStepNumber: number;
}): ConditionOutcome {
    if (args.conditionPassed) return { kind: 'proceed' };
    const b = args.branchToStepNumber;
    if (b != null && b !== args.currentStepNumber) {
        return { kind: 'branch', toStepNumber: b };
    }
    return { kind: 'skip_continue' };
}

/** Smallest step_number strictly greater than `n`, or null when none.
 *  Gap-safe: with normalized contiguous 1..N this is just n+1, but a
 *  legacy non-contiguous campaign (pre-normalizer) still advances over the
 *  hole instead of mistaking the gap for end-of-sequence. */
function nextStepNumberAfter(n: number, steps: { step_number: number }[]): number | null {
    let best: number | null = null;
    for (const s of steps) {
        if (s.step_number > n && (best === null || s.step_number < best)) best = s.step_number;
    }
    return best;
}

/**
 * Walk the sequence from `startNumber`, honoring per-step `condition` and
 * `branch_to_step_number` via the shared decideConditionOutcome policy,
 * until we find a deliverable step or run off the end. Returns null only
 * when no step remains (no such step_number, or the chain walked past the
 * last step) — caller marks the lead completed.
 *
 * Resolution is purely by `step_number` (never array position) so it is
 * correct regardless of how steps are ordered or numbered. Loop safety:
 * a visited-set, not a fixed hop cap — forward skip_continue moves can
 * never revisit (step_number strictly increases), so only branches can
 * loop; revisiting any step_number terminates the walk. This both kills
 * self/ping-pong branch loops AND can't prematurely truncate a long but
 * legitimate sequence the way a 10-hop cap could.
 *
 * Generic so the caller gets its own concrete step type back (no cast).
 */
export function resolveDeliverableStep<T extends ResolverStep>(
    startNumber: number,
    steps: T[],
    lead: ResolverLeadState,
): T | null {
    let current: number | null = startNumber;
    const visited = new Set<number>();
    while (current != null) {
        if (visited.has(current)) return null; // branch loop (self / ping-pong)
        visited.add(current);
        const step = steps.find(s => s.step_number === current);
        if (!step) return null; // no such step_number → end of sequence (gap-safe)
        const outcome = decideConditionOutcome({
            conditionPassed: stepConditionMatches(step.condition, lead),
            branchToStepNumber: step.branch_to_step_number,
            currentStepNumber: current,
        });
        if (outcome.kind === 'proceed') return step;
        if (outcome.kind === 'branch') { current = outcome.toStepNumber; continue; }
        // skip_continue: skip THIS step, advance to the next existing step.
        current = nextStepNumberAfter(current, steps);
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
