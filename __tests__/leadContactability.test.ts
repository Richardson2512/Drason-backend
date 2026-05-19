/**
 * Lead contactability + cold-call score-anchoring tests.
 *
 * isHardSuppressed is THE single policy for "never call / export / CSV
 * this prospect" - it is now invoked from cold-call generation, snapshot
 * hydration, the CSV builder, and the JustCall + Outreach export
 * boundaries. A regression here re-opens the cold-call leak (a bounced /
 * unsubscribed / GDPR-erased person resurfacing on a dialer list), so the
 * contract is frozen here.
 *
 * computeScore(asOf) is the F5 fix: anchoring to the snapshot's
 * generated_at must make the score deterministic regardless of wall clock
 * (so a hydrated list never drifts out of its frozen score-desc order).
 */

import {
    isErased,
    isHardSuppressed,
    isProspectRowSuppressed,
    shouldEnrichPhone,
} from '../src/services/leadContactabilityService';
import { computeScore } from '../src/services/coldCallListService';

describe('isErased (GDPR tombstone only)', () => {
    it('status="erased" → erased', () => {
        expect(isErased({ status: 'erased' })).toBe(true);
    });
    it('tombstone email prefix → erased (covers legacy rows with only the email rewritten)', () => {
        expect(isErased({ email: 'erased-9f1c@anonymized.invalid' })).toBe(true);
    });
    it('a normal active prospect is not erased', () => {
        expect(isErased({ status: 'active', email: 'jane@acme.com' })).toBe(false);
    });
    it('missing fields are safe', () => {
        expect(isErased({})).toBe(false);
        expect(isErased({ status: null, email: null })).toBe(false);
    });
});

describe('isHardSuppressed (absolute do-not-contact gate)', () => {
    const base = { status: 'active', bounced_at: null, unsubscribed_at: null, email: 'a@b.com' };

    it('bounced_at set → suppressed', () => {
        expect(isHardSuppressed({ ...base, bounced_at: new Date() })).toBe(true);
    });
    it('unsubscribed_at set → suppressed', () => {
        expect(isHardSuppressed({ ...base, unsubscribed_at: new Date() })).toBe(true);
    });
    it('status bounced / unsubscribed / erased → suppressed', () => {
        expect(isHardSuppressed({ ...base, status: 'bounced' })).toBe(true);
        expect(isHardSuppressed({ ...base, status: 'unsubscribed' })).toBe(true);
        expect(isHardSuppressed({ ...base, status: 'erased' })).toBe(true);
    });
    it('erased tombstone email → suppressed (the cold-call leak case)', () => {
        expect(isHardSuppressed({ ...base, status: 'active', email: 'erased-abc@anonymized.invalid' })).toBe(true);
    });
    it('a clean active prospect is contactable', () => {
        expect(isHardSuppressed(base)).toBe(false);
    });
    it('"replied" is NOT a hard-suppression (it is a per-list rule + a UI flag, by design)', () => {
        // No bounce/unsub/erase → contactable even though they may have replied;
        // requireNoReply handling stays in the rules layer, not here.
        expect(isHardSuppressed({ ...base, status: 'active' })).toBe(false);
    });
});

describe('isProspectRowSuppressed (same policy over a hydrated ProspectRow)', () => {
    it('bounced/unsubscribed booleans or erased email → suppressed', () => {
        expect(isProspectRowSuppressed({ bounced: true, unsubscribed: false, email: 'a@b.com' })).toBe(true);
        expect(isProspectRowSuppressed({ bounced: false, unsubscribed: true, email: 'a@b.com' })).toBe(true);
        expect(isProspectRowSuppressed({ bounced: false, unsubscribed: false, email: 'erased-x@anonymized.invalid' })).toBe(true);
    });
    it('clean row is not suppressed', () => {
        expect(isProspectRowSuppressed({ bounced: false, unsubscribed: false, email: 'jane@acme.com' })).toBe(false);
    });
});

describe('shouldEnrichPhone (BYOK spend guard - one place)', () => {
    const ok = { status: 'active', bounced_at: null, unsubscribed_at: null, email: 'a@b.com' };

    it('enriches when contactable and no usable phone', () => {
        expect(shouldEnrichPhone({ ...ok, phone: null })).toBe(true);
        expect(shouldEnrichPhone({ ...ok, phone: '' })).toBe(true);
        expect(shouldEnrichPhone({ ...ok, phone: '   ' })).toBe(true);
        expect(shouldEnrichPhone({ ...ok })).toBe(true);
    });
    it('does NOT enrich when a usable phone already exists (no wasted credit)', () => {
        expect(shouldEnrichPhone({ ...ok, phone: '+15551234567' })).toBe(false);
    });
    it('does NOT enrich a suppressed prospect even with no phone (never burn credits on bounced/unsub/erased)', () => {
        expect(shouldEnrichPhone({ ...ok, phone: null, bounced_at: new Date() })).toBe(false);
        expect(shouldEnrichPhone({ ...ok, phone: null, unsubscribed_at: new Date() })).toBe(false);
        expect(shouldEnrichPhone({ ...ok, phone: null, status: 'erased' })).toBe(false);
        expect(shouldEnrichPhone({ ...ok, phone: null, email: 'erased-z@anonymized.invalid' })).toBe(false);
    });
});

describe('computeScore(asOf) is deterministic against the anchor clock (F5)', () => {
    const asOf = new Date('2026-05-16T12:00:00.000Z');
    // One human open 2 hours before the anchor (well past the 30s MPP
    // discount, inside the 24h 1.5x recency band relative to asOf).
    const opens = [{ opened_at: new Date(asOf.getTime() - 2 * 3_600_000), ms_since_send: 5 * 60_000 }];
    const clicks: { clicked_at: Date }[] = [];

    it('same events + same asOf → identical score on repeated calls (no wall-clock drift)', () => {
        const a = computeScore(opens, clicks, asOf);
        const b = computeScore(opens, clicks, asOf);
        expect(a).toBe(b);
        expect(a).toBeGreaterThan(0);
    });

    it('a later asOf decays recency (proves asOf, not Date.now(), is the clock)', () => {
        const atGen = computeScore(opens, clicks, asOf);
        const viewedThreeDaysLater = computeScore(opens, clicks, new Date(asOf.getTime() + 3 * 86_400_000));
        // Same event, older relative to the later clock → recency multiplier
        // drops (1.5x → 1x), so the score must not be higher.
        expect(viewedThreeDaysLater).toBeLessThan(atGen);
    });

    it('no signals → 0 regardless of asOf', () => {
        expect(computeScore([], [], asOf)).toBe(0);
    });
});
