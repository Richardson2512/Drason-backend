/**
 * Connection error classifier tests.
 *
 * This is the single source of truth for "what should the user-facing
 * last_error say?" across every OAuth integration. Each classification
 * triggers a different remediation prompt in the UI, so wrong
 * classification = confused user. The contract is frozen below.
 */

import { classifyConnectionError } from '../src/utils/connectionErrorClassifier';

describe('classifyConnectionError - scope drift (F5)', () => {
    it('identifies HubSpot-style insufficient_scope (403)', () => {
        const r = classifyConnectionError(403, { message: 'insufficient_scope: missing contacts.read' }, 'HubSpot');
        expect(r.kind).toBe('scope_drift');
        expect(r.message).toMatch(/Reconnect the integration/);
    });
    it('identifies Outreach-style "required scope" (403)', () => {
        const r = classifyConnectionError(403, { error: 'forbidden', detail: 'required scope: sequences.write' }, 'Outreach');
        expect(r.kind).toBe('scope_drift');
    });
    it('does NOT flag scope_drift on a 401 - that is unauthorized', () => {
        const r = classifyConnectionError(401, { message: 'insufficient_scope' }, 'CRM');
        expect(r.kind).toBe('unauthorized');
    });
});

describe('classifyConnectionError - other kinds', () => {
    it('invalid_grant -> expired_token regardless of status code', () => {
        const r = classifyConnectionError(400, { error: 'invalid_grant' }, 'Outreach');
        expect(r.kind).toBe('expired_token');
    });
    it('401 -> unauthorized', () => {
        const r = classifyConnectionError(401, { error: 'unauthorized' }, 'CRM');
        expect(r.kind).toBe('unauthorized');
    });
    it('429 -> rate_limit, NOT a credential problem', () => {
        const r = classifyConnectionError(429, {}, 'JustCall');
        expect(r.kind).toBe('rate_limit');
        expect(r.message).toMatch(/no action needed/i);
    });
    it('500+ -> transient', () => {
        expect(classifyConnectionError(500, {}, 'X').kind).toBe('transient');
        expect(classifyConnectionError(503, {}, 'X').kind).toBe('transient');
    });
    it('422 -> validation, explicitly NOT a credential problem', () => {
        const r = classifyConnectionError(422, {}, 'X');
        expect(r.kind).toBe('validation');
        expect(r.message).toMatch(/not a credential problem/);
    });
    it('unknown status falls through to unknown', () => {
        expect(classifyConnectionError(418, {}, 'X').kind).toBe('unknown');
    });
});
