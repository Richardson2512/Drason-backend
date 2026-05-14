/**
 * Step-type registry tests.
 *
 * Why this file matters: the registry is the single source of truth for
 * which step types exist, which channel they run on, which preconditions
 * gate them, and (post-refactor) which dispatcher picks them up. A drift
 * between the registry and the dispatchers was the bug pattern that left
 * `find_email` silently broken. These tests freeze the registry's
 * contract so regressions show up at CI rather than in production.
 */

import {
    STEP_TYPES,
    getStepType,
    isLinkedInStepType,
    isLinkedInDispatcherStep,
    listStepTypes,
    validateStepConfig,
} from '../src/services/sequencer/stepTypeRegistry';

describe('stepTypeRegistry — STEP_TYPES contract', () => {
    it('exposes every step type the wizard offers', () => {
        // Wizard's STEP_TYPE_META keys (campaigns/new/page.tsx). The
        // registry must cover every wizard option — a wizard pick with no
        // backend step type round-trips to a dispatcher error.
        const expected = [
            'email',
            'linkedin_view_profile',
            'linkedin_follow',
            'linkedin_like_post',
            'linkedin_connection_request',
            'linkedin_message',
            'linkedin_inmail',
            'find_email',
            'find_linkedin_url',
            'end',
        ];
        for (const key of expected) {
            expect(STEP_TYPES[key]).toBeDefined();
            expect(STEP_TYPES[key].key).toBe(key);
        }
    });

    it('every registered step has channel, label, required_sender, preconditions', () => {
        for (const def of listStepTypes()) {
            expect(def.channel).toBeDefined();
            expect(['email', 'linkedin', 'utility']).toContain(def.channel);
            expect(typeof def.label).toBe('string');
            expect(def.label.length).toBeGreaterThan(0);
            expect(['mailbox', 'linkedin_account', 'none']).toContain(def.required_sender);
            expect(Array.isArray(def.preconditions)).toBe(true);
        }
    });

    it('LinkedIn DM and InMail require a 1st-degree connection precondition (CR is the inverse)', () => {
        expect(STEP_TYPES.linkedin_message.preconditions).toContain('sender_is_first_degree');
        expect(STEP_TYPES.linkedin_inmail.preconditions).toContain('lead_has_linkedin_profile');
        expect(STEP_TYPES.linkedin_connection_request.preconditions).toContain('sender_is_not_first_degree');
    });
});

describe('stepTypeRegistry — getStepType', () => {
    it('returns the def for a known key', () => {
        const def = getStepType('linkedin_view_profile');
        expect(def?.label).toBe('View Profile');
    });

    it('returns undefined for an unknown key (never throws)', () => {
        expect(getStepType('not_a_real_step')).toBeUndefined();
    });
});

describe('stepTypeRegistry — isLinkedInStepType', () => {
    it('returns true only for channel=linkedin', () => {
        expect(isLinkedInStepType('linkedin_message')).toBe(true);
        expect(isLinkedInStepType('linkedin_view_profile')).toBe(true);
        expect(isLinkedInStepType('email')).toBe(false);
        expect(isLinkedInStepType('find_linkedin_url')).toBe(false);
        expect(isLinkedInStepType('find_email')).toBe(false);
        expect(isLinkedInStepType('end')).toBe(false);
    });

    it('returns false for an unknown step type (doesn\'t crash)', () => {
        expect(isLinkedInStepType('made_up')).toBe(false);
    });
});

describe('stepTypeRegistry — isLinkedInDispatcherStep', () => {
    // This is the bug-prevention test for the filter/switch desync that
    // originally let find_email silently skip every dispatch tick.
    it('claims every linkedin_* step', () => {
        expect(isLinkedInDispatcherStep('linkedin_view_profile')).toBe(true);
        expect(isLinkedInDispatcherStep('linkedin_follow')).toBe(true);
        expect(isLinkedInDispatcherStep('linkedin_like_post')).toBe(true);
        expect(isLinkedInDispatcherStep('linkedin_connection_request')).toBe(true);
        expect(isLinkedInDispatcherStep('linkedin_message')).toBe(true);
        expect(isLinkedInDispatcherStep('linkedin_inmail')).toBe(true);
    });

    it('claims senderless utility steps (find_*) — these were the silently-broken ones', () => {
        expect(isLinkedInDispatcherStep('find_email')).toBe(true);
        expect(isLinkedInDispatcherStep('find_linkedin_url')).toBe(true);
    });

    it('disclaims email steps (those go to sendQueueService)', () => {
        expect(isLinkedInDispatcherStep('email')).toBe(false);
    });

    it('disclaims the terminal end step', () => {
        expect(isLinkedInDispatcherStep('end')).toBe(false);
    });

    it('disclaims unknown step types (forward-compat — new step gets explicit dispatcher wiring)', () => {
        expect(isLinkedInDispatcherStep('linkedin_future_step')).toBe(false);
        expect(isLinkedInDispatcherStep('not_real')).toBe(false);
    });
});

describe('stepTypeRegistry — validateStepConfig', () => {
    it('rejects unknown step_type', () => {
        const issues = validateStepConfig('made_up', {});
        expect(issues.length).toBeGreaterThan(0);
        expect(issues[0].key).toBe('step_type');
    });

    it('rejects non-object config', () => {
        const issues = validateStepConfig('linkedin_message', null);
        expect(issues.length).toBeGreaterThan(0);
    });

    it('accepts an empty config for a step with no required schema', () => {
        const issues = validateStepConfig('linkedin_view_profile', {});
        expect(issues).toEqual([]);
    });

    it('accepts a valid config for linkedin_message', () => {
        const issues = validateStepConfig('linkedin_message', {
            body_template: 'Hi {{first_name}}',
        });
        expect(issues).toEqual([]);
    });
});
