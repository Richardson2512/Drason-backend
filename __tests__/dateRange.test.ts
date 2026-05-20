/**
 * Date-range parser tests. Reports audit R5.
 */

import { parseDateRange } from '../src/utils/dateRange';

describe('parseDateRange - happy path', () => {
    it('uses the default window when nothing is supplied', () => {
        const r = parseDateRange(undefined, undefined, { defaultDays: 7 });
        expect(r.ok).toBe(true);
        if (r.ok) {
            const span = (r.end.getTime() - r.start.getTime()) / (24 * 60 * 60 * 1000);
            expect(span).toBeGreaterThan(6.9);
            expect(span).toBeLessThan(7.1);
        }
    });
    it('accepts ISO-8601 start + end', () => {
        const r = parseDateRange('2026-01-01T00:00:00Z', '2026-01-31T23:59:59Z');
        expect(r.ok).toBe(true);
    });
});

describe('parseDateRange - reject list', () => {
    it('rejects a malformed start_date', () => {
        const r = parseDateRange('not-a-date', undefined);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.code).toBe('invalid_start');
    });
    it('rejects a malformed end_date', () => {
        const r = parseDateRange('2026-01-01', 'tomorrow');
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.code).toBe('invalid_end');
    });
    it('rejects an inverted range', () => {
        const r = parseDateRange('2026-02-01', '2026-01-01');
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.code).toBe('range_inverted');
    });
    it('rejects a range exceeding 366 days', () => {
        const r = parseDateRange('2020-01-01', '2026-01-01');
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.code).toBe('range_too_large');
    });
    it('rejects non-string types', () => {
        const r = parseDateRange(42 as any, undefined);
        expect(r.ok).toBe(false);
    });
});
