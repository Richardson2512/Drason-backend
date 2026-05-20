/**
 * Lead-distribution algorithm regression tests.
 *
 * Production-readiness round-4 R4-1: the dispatcher's step-1 mailbox picker
 * changed from weighted-greedy (60% capacity / 40% ESP) to strict-fairness-
 * first + ESP-tie-break. The old algorithm concentrated the first ~17 leads
 * on the single best-ESP mailbox before fairness took over; the new
 * algorithm distributes load proportionally and uses ESP affinity only to
 * break ties among equally-loaded mailboxes.
 *
 * These tests freeze the contract of the extracted pure helper
 * `pickAccountForLead`. The dispatcher's inline closure shares the exact
 * algorithm body (copy-paste-equivalent code path), so the helper's
 * regression coverage stands in for the dispatcher path.
 *
 * The contract:
 *   - No eligible mailbox -> null
 *   - All mailboxes equally loaded -> best ESP wins
 *   - One mailbox at capacity, others available -> picks from the
 *     available pool, not the at-capacity one
 *   - Strict round-robin: after mailbox A picks lead 1, lead 2 picks a
 *     DIFFERENT mailbox (because A is now 1/cap and the others are 0/cap)
 *   - After every mailbox has been picked once, round 2 starts from the
 *     best-ESP mailbox again
 *   - Heterogeneous caps (50/day vs 30/day) get proportional load
 *     (fullness ratio, not raw count)
 *   - ESP routing disabled -> degenerates to round-robin (first fair
 *     candidate; the array order determines distribution)
 *   - New mailbox with no ESP data -> treated as espScore 0.5, fairly
 *     considered alongside ESP-known mailboxes within the fair tier
 *   - The 0.5% tolerance bucket -> mailboxes within tolerance are tied
 *     even if their fullness differs slightly
 */

import { pickAccountForLead, FAIRNESS_TOLERANCE_FOR_DISTRIBUTION } from '../src/services/sendQueueService';

// Helper: build espPerfMap entries quickly.
function espPerf(entries: Array<[accountId: string, esp: string, bounceRate: number, sendCount: number]>) {
    const map = new Map<string, { bounceRate: number; sendCount: number }>();
    for (const [accId, esp, br, sc] of entries) {
        map.set(`${accId}:${esp}`, { bounceRate: br, sendCount: sc });
    }
    return map;
}

describe('pickAccountForLead - production-readiness round-4 distribution algorithm', () => {
    it('returns null when no mailboxes have capacity', () => {
        const accounts = [{ id: 'a1', remainingCapacity: 0 }];
        const result = pickAccountForLead({
            accounts,
            accountCounts: new Map([['a1', 0]]),
            espPerfMap: new Map(),
            useEspRouting: true,
            leadEspBucket: 'gmail',
        });
        expect(result).toBeNull();
    });

    it('returns null when every mailbox is at its capacity', () => {
        const accounts = [
            { id: 'a1', remainingCapacity: 5 },
            { id: 'a2', remainingCapacity: 5 },
        ];
        // Both fully assigned this tick already.
        const accountCounts = new Map([['a1', 5], ['a2', 5]]);
        const result = pickAccountForLead({
            accounts,
            accountCounts,
            espPerfMap: new Map(),
            useEspRouting: false,
            leadEspBucket: null,
        });
        expect(result).toBeNull();
    });

    it('picks the ESP-best mailbox when all are equally loaded (round 1)', () => {
        const accounts = [
            { id: 'a1', remainingCapacity: 50 },
            { id: 'a2', remainingCapacity: 50 },
            { id: 'a3', remainingCapacity: 50 },
        ];
        const accountCounts = new Map([['a1', 0], ['a2', 0], ['a3', 0]]);
        // a2 is best for Gmail (lowest bounce rate, enough sends to count).
        const espPerfMap = espPerf([
            ['a1', 'gmail', 0.020, 100],
            ['a2', 'gmail', 0.001, 100],
            ['a3', 'gmail', 0.015, 100],
        ]);
        const result = pickAccountForLead({
            accounts, accountCounts, espPerfMap,
            useEspRouting: true, leadEspBucket: 'gmail',
        });
        expect(result?.id).toBe('a2');
    });

    it('strict round-robin: lead 2 picks a different mailbox than lead 1', () => {
        const accounts = [
            { id: 'a1', remainingCapacity: 50 },
            { id: 'a2', remainingCapacity: 50 },
            { id: 'a3', remainingCapacity: 50 },
        ];
        const accountCounts = new Map([['a1', 0], ['a2', 0], ['a3', 0]]);
        const espPerfMap = espPerf([
            ['a1', 'gmail', 0.020, 100],
            ['a2', 'gmail', 0.001, 100],   // best
            ['a3', 'gmail', 0.005, 100],   // second-best
        ]);
        // Lead 1 picks a2 (best). Simulate that.
        const pick1 = pickAccountForLead({ accounts, accountCounts, espPerfMap, useEspRouting: true, leadEspBucket: 'gmail' });
        expect(pick1?.id).toBe('a2');
        accountCounts.set('a2', 1);

        // Lead 2 must pick from {a1, a3} because a2 is now at fullness 1/50=0.02
        // while a1 and a3 are still at fullness 0. Among fair candidates,
        // a3 has the better ESP score.
        const pick2 = pickAccountForLead({ accounts, accountCounts, espPerfMap, useEspRouting: true, leadEspBucket: 'gmail' });
        expect(pick2?.id).toBe('a3');
    });

    it('completes round 1 across all mailboxes before round 2 begins', () => {
        const accounts = [
            { id: 'a1', remainingCapacity: 50 },
            { id: 'a2', remainingCapacity: 50 },
            { id: 'a3', remainingCapacity: 50 },
        ];
        const accountCounts = new Map([['a1', 0], ['a2', 0], ['a3', 0]]);
        const espPerfMap = espPerf([
            ['a1', 'gmail', 0.020, 100],
            ['a2', 'gmail', 0.001, 100],
            ['a3', 'gmail', 0.005, 100],
        ]);
        // Simulate 3 picks (round 1).
        const picks: string[] = [];
        for (let i = 0; i < 3; i++) {
            const p = pickAccountForLead({ accounts, accountCounts, espPerfMap, useEspRouting: true, leadEspBucket: 'gmail' });
            expect(p).not.toBeNull();
            picks.push(p!.id);
            accountCounts.set(p!.id, (accountCounts.get(p!.id) || 0) + 1);
        }
        // Every mailbox picked exactly once.
        expect(new Set(picks)).toEqual(new Set(['a1', 'a2', 'a3']));

        // Round 2 lead 1 should pick the best ESP again (a2) because all
        // mailboxes are now equally loaded at 1/50.
        const pick4 = pickAccountForLead({ accounts, accountCounts, espPerfMap, useEspRouting: true, leadEspBucket: 'gmail' });
        expect(pick4?.id).toBe('a2');
    });

    it('heterogeneous capacities balance proportionally (fullness ratio, not raw count)', () => {
        // a1 has 50/day, a2 has 30/day. After 5 leads on a1 and 3 leads on a2,
        // both are at 10% fullness - the picker should consider them equally
        // loaded and ESP-tie-break.
        const accounts = [
            { id: 'a1', remainingCapacity: 50 },
            { id: 'a2', remainingCapacity: 30 },
        ];
        const accountCounts = new Map([['a1', 5], ['a2', 3]]);
        const espPerfMap = espPerf([
            ['a1', 'gmail', 0.020, 100],
            ['a2', 'gmail', 0.001, 100],   // a2 better
        ]);
        const result = pickAccountForLead({
            accounts, accountCounts, espPerfMap,
            useEspRouting: true, leadEspBucket: 'gmail',
        });
        // Both at fullness 0.1 → fair-tied → ESP tie-break picks a2.
        expect(result?.id).toBe('a2');
    });

    it('heterogeneous capacities: higher-cap mailbox absorbs more raw leads over time', () => {
        // Realistic verification: simulate 10 picks with no ESP signal so
        // ties resolve by first-fair-candidate (a1 listed first). Assert
        // that the higher-cap mailbox is picked more often.
        const accounts = [
            { id: 'a1', remainingCapacity: 100 },
            { id: 'a2', remainingCapacity: 20 },
        ];
        const accountCounts = new Map([['a1', 0], ['a2', 0]]);

        const picks: string[] = [];
        for (let i = 0; i < 10; i++) {
            const p = pickAccountForLead({
                accounts, accountCounts, espPerfMap: new Map(),
                useEspRouting: false, leadEspBucket: null,
            });
            expect(p).not.toBeNull();
            picks.push(p!.id);
            accountCounts.set(p!.id, (accountCounts.get(p!.id) || 0) + 1);
        }
        // At fullness 0/100 = 0 for a1 and 0/20 = 0 for a2 initially. After
        // each pick, the fullness of the picked mailbox increases more for
        // the smaller-capacity one (1/20 = 0.05 vs 1/100 = 0.01), so a1
        // stays in the fair tier longer and gets the absolute majority.
        const a1Count = picks.filter(p => p === 'a1').length;
        const a2Count = picks.filter(p => p === 'a2').length;
        expect(a1Count).toBeGreaterThan(a2Count);
        expect(a1Count + a2Count).toBe(10);
    });

    it('ESP routing disabled -> round-robin (pure fairness, first fair candidate)', () => {
        const accounts = [
            { id: 'a1', remainingCapacity: 50 },
            { id: 'a2', remainingCapacity: 50 },
            { id: 'a3', remainingCapacity: 50 },
        ];
        const accountCounts = new Map([['a1', 0], ['a2', 0], ['a3', 0]]);
        // ESP data present but routing disabled -> should be ignored.
        const espPerfMap = espPerf([
            ['a1', 'gmail', 0.020, 100],
            ['a2', 'gmail', 0.001, 100],
            ['a3', 'gmail', 0.005, 100],
        ]);
        const pick1 = pickAccountForLead({ accounts, accountCounts, espPerfMap, useEspRouting: false, leadEspBucket: 'gmail' });
        // With routing disabled and all fair, picks the first one in array order.
        expect(pick1?.id).toBe('a1');
    });

    it('mailbox with no ESP data is treated as espScore=0.5 (still gets picked within fair tier)', () => {
        const accounts = [
            { id: 'a1', remainingCapacity: 50 },
            { id: 'a2', remainingCapacity: 50 },   // no ESP data
        ];
        const accountCounts = new Map([['a1', 0], ['a2', 0]]);
        // a1 has poor Gmail performance (high bounce rate)
        const espPerfMap = espPerf([
            ['a1', 'gmail', 0.060, 100],   // espScore = 0.94
        ]);
        // a2 has no entry -> defaults to 0.5. So a1 (0.94) beats a2 (0.5).
        const pick1 = pickAccountForLead({ accounts, accountCounts, espPerfMap, useEspRouting: true, leadEspBucket: 'gmail' });
        expect(pick1?.id).toBe('a1');

        // But if a1 has REALLY bad bounce rate, espScore < 0.5
        const worseEspMap = espPerf([
            ['a1', 'gmail', 0.7, 100],   // espScore = 0.3
        ]);
        const pick2 = pickAccountForLead({ accounts, accountCounts, espPerfMap: worseEspMap, useEspRouting: true, leadEspBucket: 'gmail' });
        // a2 (0.5 default) beats a1 (0.3). The fresh mailbox gets the lead.
        // Important: this enables warm-up bootstrap - new mailboxes get
        // sends even when ESP-known siblings exist.
        expect(pick2?.id).toBe('a2');
    });

    it('ESP performance with sendCount < 10 is treated as no data (espScore 0.5)', () => {
        const accounts = [
            { id: 'a1', remainingCapacity: 50 },
            { id: 'a2', remainingCapacity: 50 },
        ];
        const accountCounts = new Map([['a1', 0], ['a2', 0]]);
        // a1 has ESP data but only 5 sends (below 10-send threshold) - treated as unknown.
        const espPerfMap = espPerf([
            ['a1', 'gmail', 0.001, 5],     // sendCount < 10 -> default 0.5
            ['a2', 'gmail', 0.020, 100],   // espScore = 0.98
        ]);
        // a2 wins because its data is statistically meaningful.
        const result = pickAccountForLead({
            accounts, accountCounts, espPerfMap,
            useEspRouting: true, leadEspBucket: 'gmail',
        });
        expect(result?.id).toBe('a2');
    });

    it('healing mailbox with low warmup_limit gets proportionally fewer leads', () => {
        // Simulate: a1 fully healthy with 50 remaining, a2 in warm-recovery
        // with effective remaining of 10 (warmup_limit took effect).
        // remainingCapacity is what the dispatcher computed for this tick.
        const accounts = [
            { id: 'a1', remainingCapacity: 50 },
            { id: 'a2', remainingCapacity: 10 },
        ];
        const accountCounts = new Map([['a1', 0], ['a2', 0]]);

        // Simulate 50 picks; a2's fullness rises 5x faster than a1's,
        // so it drops out of the fair tier and stops getting picks.
        const picks: string[] = [];
        for (let i = 0; i < 50; i++) {
            const p = pickAccountForLead({
                accounts, accountCounts, espPerfMap: new Map(),
                useEspRouting: false, leadEspBucket: null,
            });
            if (!p) break;
            picks.push(p.id);
            accountCounts.set(p.id, (accountCounts.get(p.id) || 0) + 1);
        }
        // a2 should hit its cap at exactly 10 picks; a1 fills the rest.
        const a1Count = picks.filter(p => p === 'a1').length;
        const a2Count = picks.filter(p => p === 'a2').length;
        expect(a2Count).toBeLessThanOrEqual(10);   // bounded by remainingCapacity
        expect(a1Count + a2Count).toBe(50);
    });

    it('fairness tolerance: mailboxes within 0.5% fullness are tied for ESP tie-break', () => {
        // a1 at 9/50 = 18.0% full, a2 at 9/50 = 18.0% (identical), a3 at 10/50 = 20%.
        // a1 and a2 tied; a3 outside tolerance.
        const accounts = [
            { id: 'a1', remainingCapacity: 50 },
            { id: 'a2', remainingCapacity: 50 },
            { id: 'a3', remainingCapacity: 50 },
        ];
        const accountCounts = new Map([['a1', 9], ['a2', 9], ['a3', 10]]);
        // a3 has the BEST ESP score, but is outside the fair tier.
        const espPerfMap = espPerf([
            ['a1', 'gmail', 0.020, 100],
            ['a2', 'gmail', 0.015, 100],   // best within fair tier
            ['a3', 'gmail', 0.001, 100],   // absolute best, but excluded by fairness
        ]);
        const result = pickAccountForLead({
            accounts, accountCounts, espPerfMap,
            useEspRouting: true, leadEspBucket: 'gmail',
        });
        // a2 wins (best ESP among the fair tier {a1, a2}).
        // CRITICAL: a3 does NOT win despite its better ESP - fairness gates ESP.
        expect(result?.id).toBe('a2');
    });

    it('FAIRNESS_TOLERANCE_FOR_DISTRIBUTION is the documented 0.5%', () => {
        // If we ever need to retune this, the test surfaces the change so
        // a reviewer notices. 0.005 was chosen because it's narrower than
        // a single lead's fullness at the typical 50-200/day cap range,
        // but wide enough to tolerate floating-point rounding artifacts.
        expect(FAIRNESS_TOLERANCE_FOR_DISTRIBUTION).toBe(0.005);
    });

    it('single eligible mailbox -> returns it directly (short-circuit)', () => {
        const accounts = [
            { id: 'a1', remainingCapacity: 50 },
            { id: 'a2', remainingCapacity: 0 },   // at-capacity, excluded
        ];
        const accountCounts = new Map([['a1', 5], ['a2', 0]]);
        const result = pickAccountForLead({
            accounts, accountCounts, espPerfMap: new Map(),
            useEspRouting: true, leadEspBucket: 'gmail',
        });
        expect(result?.id).toBe('a1');
    });

    it('1000 leads / 100 mailboxes / equal caps converges to exactly 10 each', () => {
        // The end-to-end "your hypothetical scenario" test. 100 mailboxes,
        // each with 50/day cap, dispatch 1000 leads. After all 1000 picks,
        // every mailbox should have exactly 10 leads.
        const accounts = Array.from({ length: 100 }, (_, i) => ({
            id: `a${i}`, remainingCapacity: 50,
        }));
        const accountCounts = new Map(accounts.map(a => [a.id, 0]));
        // Random ESP performance variation so ESP tie-break has real signal.
        const espPerfMap = new Map<string, { bounceRate: number; sendCount: number }>();
        for (let i = 0; i < 100; i++) {
            espPerfMap.set(`a${i}:gmail`, { bounceRate: 0.001 + (i / 1000), sendCount: 100 });
        }

        for (let i = 0; i < 1000; i++) {
            const p = pickAccountForLead({
                accounts, accountCounts, espPerfMap,
                useEspRouting: true, leadEspBucket: 'gmail',
            });
            expect(p).not.toBeNull();
            accountCounts.set(p!.id, (accountCounts.get(p!.id) || 0) + 1);
        }

        // Every mailbox should have exactly 10 leads.
        for (const a of accounts) {
            expect(accountCounts.get(a.id)).toBe(10);
        }
    });
});
