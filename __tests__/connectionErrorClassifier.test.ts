/**
 * Connection error classifier contract (F5). Turns an upstream CRM/OAuth HTTP
 * failure into an actionable operator message - the key case being 403 +
 * scope language -> "reconnect to re-grant access" rather than a bare status.
 * Wired into the HubSpot/Salesforce client error paths (message only;
 * retryable + code are preserved).
 */

import { classifyConnectionError } from '../src/utils/connectionErrorClassifier';

describe('classifyConnectionError', () => {
    it('classifies 403 + scope language as scope_drift (reconnect)', () => {
        const r = classifyConnectionError(403, '{"message":"insufficient_scope"}', 'HubSpot');
        expect(r.kind).toBe('scope_drift');
        expect(r.message.toLowerCase()).toContain('reconnect');
        expect(r.message).toContain('HubSpot');
    });

    it('classifies invalid_grant as expired_token regardless of status', () => {
        expect(classifyConnectionError(400, 'error=invalid_grant', 'Salesforce').kind).toBe('expired_token');
    });

    it('classifies 401 as unauthorized', () => {
        expect(classifyConnectionError(401, 'Unauthorized', 'HubSpot').kind).toBe('unauthorized');
    });

    it('classifies 429 as rate_limit (not a credential problem)', () => {
        expect(classifyConnectionError(429, 'rate limited', 'HubSpot').kind).toBe('rate_limit');
    });

    it('classifies 5xx as transient', () => {
        expect(classifyConnectionError(503, 'bad gateway', 'Salesforce').kind).toBe('transient');
    });

    it('classifies 400/422 (non-scope) as validation', () => {
        expect(classifyConnectionError(422, 'bad field', 'HubSpot').kind).toBe('validation');
        expect(classifyConnectionError(400, 'malformed', 'HubSpot').kind).toBe('validation');
    });

    it('falls back to unknown for unexpected statuses', () => {
        expect(classifyConnectionError(418, 'teapot', 'HubSpot').kind).toBe('unknown');
    });

    it('plain 403 without scope language is not misread as scope_drift', () => {
        // 403 with no scope signal should not claim scope drift; it falls through.
        expect(classifyConnectionError(403, 'forbidden', 'HubSpot').kind).not.toBe('scope_drift');
    });
});
