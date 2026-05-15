/**
 * Lead-progression tests.
 *
 * This module is the single source of truth for the state a CampaignLead
 * moves to after a step is delivered, and the only guarded write path.
 * The email dispatcher and (Phase 4) the LinkedIn worker both go through
 * it, so a regression here corrupts every sequence. These tests freeze:
 * the date math, the finished-vs-active decision, the legacy-gap
 * fallback, the canonical guarded write shape, and the status='active'
 * guard that stops a replied/paused lead being resurrected.
 */

import {
    progressionFromNextStep,
    computeProgression,
    progressionWhere,
    progressionWriteData,
    writeProgression,
    completeLead,
    ProgressionState,
} from '../src/services/sequencer/leadProgression';

const NOW = new Date('2026-05-16T12:00:00.000Z');

describe('progressionFromNextStep', () => {
    it('null next step → sequence completed, next_send_at null', () => {
        const s = progressionFromNextStep({ deliveredStepNumber: 3, nextStep: null, now: NOW });
        expect(s).toEqual({
            current_step: 3,
            last_sent_at: NOW,
            next_send_at: null,
            status: 'completed',
        });
    });

    it('next step present → active, next_send_at = now + days + hours', () => {
        const s = progressionFromNextStep({
            deliveredStepNumber: 1,
            nextStep: { delay_days: 2, delay_hours: 3 },
            now: NOW,
        });
        const expected = new Date(NOW);
        expected.setDate(expected.getDate() + 2);
        expected.setHours(expected.getHours() + 3);
        expect(s.status).toBe('active');
        expect(s.current_step).toBe(1);
        expect(s.next_send_at).toEqual(expected);
        expect(s.last_sent_at).toEqual(NOW);
    });

    it('does not mutate the passed-in now', () => {
        const now = new Date(NOW);
        progressionFromNextStep({ deliveredStepNumber: 1, nextStep: { delay_days: 5, delay_hours: 0 }, now });
        expect(now).toEqual(NOW);
    });
});

describe('computeProgression', () => {
    const steps = [
        { step_number: 1, delay_days: 0, delay_hours: 0 },
        { step_number: 2, delay_days: 3, delay_hours: 0 },
        { step_number: 3, delay_days: 1, delay_hours: 12 },
    ];

    it('delivered the last step → completed', () => {
        const s = computeProgression({ deliveredStepNumber: 3, steps, now: NOW });
        expect(s.status).toBe('completed');
        expect(s.next_send_at).toBeNull();
        expect(s.current_step).toBe(3);
    });

    it('delivered step 1 → active, scheduled by step 2 delay', () => {
        const s = computeProgression({ deliveredStepNumber: 1, steps, now: NOW });
        const expected = new Date(NOW);
        expected.setDate(expected.getDate() + 3);
        expect(s.status).toBe('active');
        expect(s.current_step).toBe(1);
        expect(s.next_send_at).toEqual(expected);
    });

    it('legacy gap: higher step exists but delivered+1 missing → active, delay 0', () => {
        // Steps 1,2,4 (3 deleted). Delivered 2: a higher step (4) exists
        // but step 3 is missing → schedule now (delay 0); the next tick's
        // resolver walks to step 4.
        const gapped = [
            { step_number: 1, delay_days: 0, delay_hours: 0 },
            { step_number: 2, delay_days: 1, delay_hours: 0 },
            { step_number: 4, delay_days: 5, delay_hours: 0 },
        ];
        const s = computeProgression({ deliveredStepNumber: 2, steps: gapped, now: NOW });
        expect(s.status).toBe('active');
        expect(s.next_send_at).toEqual(NOW); // delay 0 from now
    });

    it('delivered the only step → completed', () => {
        const s = computeProgression({
            deliveredStepNumber: 1,
            steps: [{ step_number: 1, delay_days: 0, delay_hours: 0 }],
            now: NOW,
        });
        expect(s.status).toBe('completed');
        expect(s.next_send_at).toBeNull();
    });
});

describe('canonical guarded write shape', () => {
    it('progressionWhere always guards on status=active', () => {
        expect(progressionWhere('lead-1')).toEqual({ id: 'lead-1', status: 'active' });
    });

    it('progressionWriteData maps exactly the four progression fields', () => {
        const state: ProgressionState = {
            current_step: 2,
            last_sent_at: NOW,
            next_send_at: null,
            status: 'completed',
        };
        expect(progressionWriteData(state)).toEqual({
            current_step: 2,
            last_sent_at: NOW,
            next_send_at: null,
            status: 'completed',
        });
    });
});

describe('writeProgression / completeLead are guarded', () => {
    function mockClient() {
        const calls: any[] = [];
        return {
            calls,
            campaignLead: {
                updateMany: async (args: any) => {
                    calls.push(args);
                    return { count: 1 };
                },
            },
        };
    }

    it('writeProgression writes the guarded shape and returns count', async () => {
        const c = mockClient();
        const state: ProgressionState = {
            current_step: 4,
            last_sent_at: NOW,
            next_send_at: NOW,
            status: 'active',
        };
        const n = await writeProgression(c, 'lead-9', state);
        expect(n).toBe(1);
        expect(c.calls[0].where).toEqual({ id: 'lead-9', status: 'active' });
        expect(c.calls[0].data).toEqual(progressionWriteData(state));
    });

    it('completeLead writes completed + null next_send_at, guarded on active', async () => {
        const c = mockClient();
        const n = await completeLead(c, 'lead-7');
        expect(n).toBe(1);
        expect(c.calls[0].where).toEqual({ id: 'lead-7', status: 'active' });
        expect(c.calls[0].data).toEqual({ status: 'completed', next_send_at: null });
    });
});
