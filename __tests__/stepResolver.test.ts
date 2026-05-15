/**
 * Shared step-resolver tests.
 *
 * This module is THE single source of truth for "what is a lead's next
 * step and whose job is it." The email dispatcher and the LinkedIn worker
 * both resolve through it; a regression here corrupts every sequence.
 * These tests freeze the contract: branch/condition walking, the loop
 * safety cap, resolution by step_number (never array position), and the
 * ownership classification shared between the two executors.
 */

import {
    stepConditionMatches,
    resolveDeliverableStep,
    decideConditionOutcome,
    classifyStepOwner,
    ResolverStep,
} from '../src/services/sequencer/stepResolver';

type S = ResolverStep;
const step = (n: number, extra: Partial<S> = {}): S => ({
    step_number: n,
    step_type: 'email',
    condition: null,
    branch_to_step_number: null,
    ...extra,
});

describe('stepConditionMatches', () => {
    it('null/undefined condition always matches (unconditional step)', () => {
        expect(stepConditionMatches(null, {})).toBe(true);
        expect(stepConditionMatches(undefined, {})).toBe(true);
    });
    it('unknown condition fails open (typo must not stall the sequence)', () => {
        expect(stepConditionMatches('if_full_moon', {})).toBe(true);
    });
    it('if_no_reply / if_replied key off replied_at', () => {
        expect(stepConditionMatches('if_no_reply', { replied_at: null })).toBe(true);
        expect(stepConditionMatches('if_no_reply', { replied_at: new Date() })).toBe(false);
        expect(stepConditionMatches('if_replied', { replied_at: new Date() })).toBe(true);
        expect(stepConditionMatches('if_replied', { replied_at: null })).toBe(false);
    });
    it('opened / clicked conditions key off counts', () => {
        expect(stepConditionMatches('if_opened', { opened_count: 1 })).toBe(true);
        expect(stepConditionMatches('if_opened', { opened_count: 0 })).toBe(false);
        expect(stepConditionMatches('if_not_opened', { opened_count: 0 })).toBe(true);
        expect(stepConditionMatches('if_clicked', { clicked_count: 2 })).toBe(true);
        expect(stepConditionMatches('if_not_clicked', { clicked_count: 0 })).toBe(true);
    });
});

describe('resolveDeliverableStep', () => {
    it('linear: returns the step whose step_number matches the start', () => {
        const steps = [step(1), step(2), step(3)];
        expect(resolveDeliverableStep(1, steps, {})?.step_number).toBe(1);
        expect(resolveDeliverableStep(2, steps, {})?.step_number).toBe(2);
    });

    it('resolves by step_number, NOT array position (gap-safe)', () => {
        // A deleted middle step leaves a gap (1,2,4). Asking for 3 must
        // return null (no such step) — never accidentally steps[2]==4.
        const steps = [step(1), step(2), step(4)];
        expect(resolveDeliverableStep(3, steps, {})).toBeNull();
        expect(resolveDeliverableStep(4, steps, {})?.step_number).toBe(4);
    });

    it('returns null when the step number does not exist (end of sequence)', () => {
        expect(resolveDeliverableStep(99, [step(1)], {})).toBeNull();
    });

    it('condition fails, no branch, later step exists → SKIPS this step and CONTINUES (unified policy)', () => {
        // Product-owner-ratified policy: a failed condition with no branch
        // skips THIS step and continues. This is the email behaviour
        // change; LinkedIn already behaved this way. Both channels now
        // share decideConditionOutcome so they cannot diverge again.
        const steps = [step(1, { condition: 'if_replied' }), step(2)];
        expect(resolveDeliverableStep(1, steps, { replied_at: null })?.step_number).toBe(2);
    });

    it('condition fails, no branch, NO later step → null (runs off the end → complete)', () => {
        // A lead only finishes when there is genuinely no next step.
        const steps = [step(1, { condition: 'if_replied' })];
        expect(resolveDeliverableStep(1, steps, { replied_at: null })).toBeNull();
    });

    it('skip-continue is gap-safe: walks to the next EXISTING step over a number gap', () => {
        // Legacy pre-normalizer campaign 1,2,4. Step 2 fails, no branch →
        // continue to 4, never mistake the 3-gap for end-of-sequence.
        const steps = [step(1), step(2, { condition: 'if_replied' }), step(4)];
        expect(resolveDeliverableStep(2, steps, { replied_at: null })?.step_number).toBe(4);
    });

    it('chained skip-continue falls through consecutive failing steps to the first deliverable', () => {
        const steps = [
            step(1, { condition: 'if_replied' }),
            step(2, { condition: 'if_replied' }),
            step(3),
        ];
        expect(resolveDeliverableStep(1, steps, { replied_at: null })?.step_number).toBe(3);
    });

    it('condition fails with a branch → follows the branch', () => {
        const steps = [
            step(1, { condition: 'if_replied', branch_to_step_number: 3 }),
            step(2),
            step(3),
        ];
        // Not replied → step 1 fails → branch to 3.
        expect(resolveDeliverableStep(1, steps, { replied_at: null })?.step_number).toBe(3);
        // Replied → step 1 matches.
        expect(resolveDeliverableStep(1, steps, { replied_at: new Date() })?.step_number).toBe(1);
    });

    it('self-pointing branch returns null (no infinite loop)', () => {
        const steps = [step(1, { condition: 'if_replied', branch_to_step_number: 1 })];
        expect(resolveDeliverableStep(1, steps, { replied_at: null })).toBeNull();
    });

    it('mutual ping-pong branches terminate via the visited-set guard (no infinite loop)', () => {
        const steps = [
            step(1, { condition: 'if_replied', branch_to_step_number: 2 }),
            step(2, { condition: 'if_replied', branch_to_step_number: 1 }),
        ];
        // Never replied → 1→2→1→2… capped, returns null rather than hang.
        expect(resolveDeliverableStep(1, steps, { replied_at: null })).toBeNull();
    });

    it('returns the caller\'s concrete type (generic passthrough)', () => {
        type Rich = ResolverStep & { subject: string };
        const rich: Rich[] = [{ ...step(1), subject: 'hi' } as Rich];
        const r = resolveDeliverableStep(1, rich, {});
        expect(r?.subject).toBe('hi');
    });
});

describe('decideConditionOutcome (THE single shared condition policy)', () => {
    // This is the one function both the email resolver and the LinkedIn
    // dispatcher route through. If these expectations change, the two
    // channels' behaviour changes together — by construction they can
    // never again encode opposite rules (the mixed-sequence root cause).
    it('condition passed → proceed', () => {
        expect(decideConditionOutcome({ conditionPassed: true, branchToStepNumber: 5, currentStepNumber: 1 }))
            .toEqual({ kind: 'proceed' });
    });
    it('failed + usable branch → branch to that target', () => {
        expect(decideConditionOutcome({ conditionPassed: false, branchToStepNumber: 5, currentStepNumber: 1 }))
            .toEqual({ kind: 'branch', toStepNumber: 5 });
    });
    it('failed + no branch → skip_continue', () => {
        expect(decideConditionOutcome({ conditionPassed: false, branchToStepNumber: null, currentStepNumber: 1 }))
            .toEqual({ kind: 'skip_continue' });
        expect(decideConditionOutcome({ conditionPassed: false, branchToStepNumber: undefined, currentStepNumber: 1 }))
            .toEqual({ kind: 'skip_continue' });
    });
    it('failed + self-pointing branch → skip_continue (same on both channels; no self-jump loop)', () => {
        expect(decideConditionOutcome({ conditionPassed: false, branchToStepNumber: 3, currentStepNumber: 3 }))
            .toEqual({ kind: 'skip_continue' });
    });
});

describe('classifyStepOwner', () => {
    it('email steps belong to the email dispatcher', () => {
        expect(classifyStepOwner('email')).toBe('email');
    });
    it('end is terminal', () => {
        expect(classifyStepOwner('end')).toBe('terminal');
    });
    it('linkedin_* steps belong to the LinkedIn worker', () => {
        expect(classifyStepOwner('linkedin_message')).toBe('linkedin');
        expect(classifyStepOwner('linkedin_connection_request')).toBe('linkedin');
        expect(classifyStepOwner('linkedin_inmail')).toBe('linkedin');
        expect(classifyStepOwner('linkedin_view_profile')).toBe('linkedin');
    });
    it('find_* utility steps belong to the LinkedIn worker', () => {
        expect(classifyStepOwner('find_email')).toBe('linkedin');
        expect(classifyStepOwner('find_linkedin_url')).toBe('linkedin');
    });
    it('unknown step type fails open to email (matches registry philosophy)', () => {
        expect(classifyStepOwner('totally_made_up')).toBe('email');
    });
});
