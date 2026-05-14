/**
 * applySuppression is the pure filter that drops emails matching the
 * resolved suppression set during lead intake. Tests pin:
 *   - case insensitivity (Acme@Corp.com vs acme@corp.com)
 *   - empty / null email handling (we never block a typo to no-email)
 *   - exact count accuracy (the skipped counter feeds the wizard banner)
 *
 * The set-builder helpers (`getSuppressedEmails`, `setSuppressionRules`,
 * cycle detection) are DB-bound and live in the integration-test backlog
 * — they need a Prisma mock or test database.
 */

import { applySuppression } from '../src/services/campaignSuppressionService';

describe('applySuppression', () => {
    it('drops leads whose email matches (case-insensitive)', () => {
        const suppressed = new Set(['blocked@example.com']);
        const leads = [
            { email: 'BLOCKED@example.com' },
            { email: 'allowed@example.com' },
            { email: 'blocked@EXAMPLE.com' },
        ];
        const { kept, skipped } = applySuppression(leads, suppressed);
        expect(kept).toEqual([{ email: 'allowed@example.com' }]);
        expect(skipped).toBe(2);
    });

    it('returns the input unchanged when the suppression set is empty', () => {
        const leads = [{ email: 'a@a.com' }, { email: 'b@b.com' }];
        const { kept, skipped } = applySuppression(leads, new Set());
        expect(kept).toBe(leads); // identity — no copy
        expect(skipped).toBe(0);
    });

    it('keeps leads with no email field rather than dropping them', () => {
        // Defensive: a row with email=undefined shouldn't be suppressed
        // (it'll be rejected later by the health gate for being malformed,
        // but we don't want suppression to mask that case).
        const suppressed = new Set(['blocked@example.com']);
        const leads = [
            { email: undefined },
            { email: null },
            { email: '' },
            { email: 'blocked@example.com' },
        ];
        const { kept, skipped } = applySuppression(leads, suppressed);
        expect(kept).toEqual([
            { email: undefined },
            { email: null },
            { email: '' },
        ]);
        expect(skipped).toBe(1);
    });

    it('trims whitespace on the lead\'s email before comparing', () => {
        const suppressed = new Set(['blocked@example.com']);
        const leads = [{ email: '  blocked@example.com  ' }];
        const { kept, skipped } = applySuppression(leads, suppressed);
        expect(kept).toEqual([]);
        expect(skipped).toBe(1);
    });

    it('preserves the rest of the lead object on filtered rows', () => {
        const suppressed = new Set(['drop@example.com']);
        const leads = [
            { email: 'keep@example.com', first_name: 'Jane', custom: 'x' },
            { email: 'drop@example.com', first_name: 'Drop' },
        ];
        const { kept } = applySuppression(leads, suppressed);
        expect(kept).toEqual([
            { email: 'keep@example.com', first_name: 'Jane', custom: 'x' },
        ]);
    });
});
