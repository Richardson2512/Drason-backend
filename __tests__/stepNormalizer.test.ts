/**
 * Canonical step-normalizer tests.
 *
 * The resolver addresses steps strictly by step_number. This normalizer
 * is what guarantees step_number is always contiguous 1..N in intended
 * order with branch targets remapped — making the position-vs-number
 * ambiguity structurally impossible rather than guarded at runtime. Both
 * campaign create and update persist through it. These tests freeze that
 * contract.
 */

import { normalizeSequenceSteps } from '../src/services/sequencer/stepNormalizer';

describe('normalizeSequenceSteps', () => {
    it('returns [] for non-array / empty input', () => {
        expect(normalizeSequenceSteps(undefined)).toEqual([]);
        expect(normalizeSequenceSteps(null)).toEqual([]);
        expect(normalizeSequenceSteps([])).toEqual([]);
    });

    it('collapses a post-delete gap (1,2,4) to contiguous 1,2,3', () => {
        const out = normalizeSequenceSteps([
            { step_number: 1, step_type: 'email' },
            { step_number: 2, step_type: 'linkedin_message' },
            { step_number: 4, step_type: 'email' },
        ]);
        expect(out.map(s => s.step_number)).toEqual([1, 2, 3]);
        expect(out.map(s => s.step_type)).toEqual(['email', 'linkedin_message', 'email']);
    });

    it('reorders by intended step_number, not array order', () => {
        const out = normalizeSequenceSteps([
            { step_number: 30, subject: 'C' },
            { step_number: 10, subject: 'A' },
            { step_number: 20, subject: 'B' },
        ]);
        expect(out.map(s => s.step_number)).toEqual([1, 2, 3]);
        expect(out.map(s => s.subject)).toEqual(['A', 'B', 'C']);
    });

    it('remaps branch_to_step_number through the old→new numbering', () => {
        // Steps numbered 10,20,30; step 10 branches to 30. After
        // renumber (1,2,3) the branch must point at 3, not 30.
        const out = normalizeSequenceSteps([
            { step_number: 10, branch_to_step_number: 30, condition: 'if_replied' },
            { step_number: 20 },
            { step_number: 30 },
        ]);
        expect(out[0].step_number).toBe(1);
        expect(out[0].branch_to_step_number).toBe(3);
        expect(out[0].condition).toBe('if_replied');
    });

    it('branch to a deleted target becomes null (sequence ends there)', () => {
        // step 1 branched to 5, but 5 was deleted in this edit.
        const out = normalizeSequenceSteps([
            { step_number: 1, branch_to_step_number: 5 },
            { step_number: 2 },
        ]);
        expect(out[0].branch_to_step_number).toBeNull();
    });

    it('preserves the full shape incl. step_type / step_config / body_text', () => {
        const out = normalizeSequenceSteps([
            {
                step_number: 1,
                step_type: 'linkedin_message',
                step_config: { body_template: 'hi {{first_name}}' },
                body_text: 'plain',
                condition: 'if_no_reply',
            },
        ]);
        expect(out[0]).toMatchObject({
            step_number: 1,
            step_type: 'linkedin_message',
            step_config: { body_template: 'hi {{first_name}}' },
            body_text: 'plain',
            condition: 'if_no_reply',
        });
    });

    it('accepts camelCase keys and applies defaults', () => {
        const out = normalizeSequenceSteps([
            { stepType: 'email', bodyHtml: '<p>1</p>' },
            { stepType: 'email', bodyHtml: '<p>2</p>', delayDays: 3 },
        ]);
        expect(out[0].step_number).toBe(1);
        expect(out[0].step_type).toBe('email');
        expect(out[0].body_html).toBe('<p>1</p>');
        // First step defaults to 0-day delay, later steps to 1 unless given.
        expect(out[0].delay_days).toBe(0);
        expect(out[1].delay_days).toBe(3);
    });

    it('no explicit step_number → uses array order, becomes 1..N', () => {
        const out = normalizeSequenceSteps([
            { subject: 'A' }, { subject: 'B' }, { subject: 'C' },
        ]);
        expect(out.map(s => s.step_number)).toEqual([1, 2, 3]);
        expect(out.map(s => s.subject)).toEqual(['A', 'B', 'C']);
    });

    it('stable tiebreak when two steps share a step_number', () => {
        const out = normalizeSequenceSteps([
            { step_number: 1, subject: 'first' },
            { step_number: 1, subject: 'second' },
        ]);
        expect(out.map(s => s.step_number)).toEqual([1, 2]);
        expect(out.map(s => s.subject)).toEqual(['first', 'second']);
    });
});
