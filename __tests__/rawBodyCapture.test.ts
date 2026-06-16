/**
 * Freezes the raw-body capture contract. Regression guard for the bug where
 * HubSpot webhooks and the Clay HMAC path were silently NOT captured, so their
 * verifiers hashed a re-stringified body and rejected every real call.
 *
 * The rule is matched by CATEGORY (any provider webhook / ingest endpoint), so
 * these assertions also cover provider webhooks that don't exist yet.
 */

import { needsRawBody } from '../src/utils/rawBodyCapture';

describe('needsRawBody', () => {
    it('captures every signed-payload category', () => {
        // Slack
        expect(needsRawBody('/slack/events')).toBe(true);
        expect(needsRawBody('/slack/commands')).toBe(true);
        expect(needsRawBody('/slack/oauth/callback')).toBe(true);
        // Billing (Polar) + legacy alias
        expect(needsRawBody('/api/billing/polar-webhook')).toBe(true);
        expect(needsRawBody('/api/billing/webhook')).toBe(true);
        // Ingest (Clay + generic) - the HMAC path
        expect(needsRawBody('/api/ingest')).toBe(true);
        expect(needsRawBody('/api/ingest/clay')).toBe(true);
        // Provider webhooks - HubSpot today, and any future provider by category
        expect(needsRawBody('/api/integrations/hubspot/webhooks')).toBe(true);
        expect(needsRawBody('/api/integrations/salesforce/webhook')).toBe(true);
        expect(needsRawBody('/api/integrations/some-future-crm/webhooks')).toBe(true);
    });

    it('does NOT capture ordinary API paths (avoids doubling memory everywhere)', () => {
        expect(needsRawBody('/api/sequencer/campaigns')).toBe(false);
        expect(needsRawBody('/api/integrations/hubspot/authorize')).toBe(false);
        expect(needsRawBody('/api/integrations/apollo/connect')).toBe(false);
        expect(needsRawBody('/api/integrations/outreach/exports')).toBe(false);
        expect(needsRawBody('/api/leads/ingest-ish-but-not')).toBe(false); // not under /api/ingest
        expect(needsRawBody('/health')).toBe(false);
        expect(needsRawBody('')).toBe(false);
    });

    it('the webhook regex requires the /webhooks segment, not a substring', () => {
        // a path that merely contains "webhook" elsewhere must not match
        expect(needsRawBody('/api/integrations/hubspot/webhook-settings')).toBe(false);
        expect(needsRawBody('/api/integrations/hubspot/list-webhooks-config')).toBe(false);
    });
});
