/**
 * CSV helper tests - the contract every report/export in the backend
 * relies on. A regression here = the formula-injection (R2) or
 * unbounded-export (R3) attack surface coming back.
 */

import { escapeField, toCsv, toCsvDownload, type CsvColumn } from '../src/utils/csv';

describe('escapeField - formula injection mitigation', () => {
    // The output is wrapped in double-quotes ONLY when it also
    // contains , / " / \n. Each case below sets its expected pattern
    // accordingly. The load-bearing assertion is the leading "'" -
    // that's what stops Excel from evaluating the formula.
    it('prefixes = with a single quote (and wraps because of the embedded ",")', () => {
        // The HYPERLINK example contains commas + embedded quotes, so it wraps.
        const out = escapeField('=HYPERLINK("http://attacker","Click")');
        expect(out.startsWith('"\'=HYPERLINK')).toBe(true);
    });
    it('prefixes + with a single quote (no wrap needed)', () => {
        expect(escapeField('+CMD|...')).toBe("'+CMD|...");
    });
    it('prefixes - with a single quote (no wrap needed)', () => {
        expect(escapeField('-2+3')).toBe("'-2+3");
    });
    it('prefixes @ with a single quote (no wrap needed)', () => {
        expect(escapeField('@SUM(A1:A9)')).toBe("'@SUM(A1:A9)");
    });
    it('prefixes leading tab with a single quote (no wrap needed)', () => {
        expect(escapeField('\tinjected')).toBe("'\tinjected");
    });
    it('leaves a safe string alone', () => {
        expect(escapeField('alice@example.com')).toBe('alice@example.com');
    });
    it('wraps + doubles embedded quotes', () => {
        expect(escapeField('she said "hi"')).toBe('"she said ""hi"""');
    });
    it('wraps strings containing a comma', () => {
        expect(escapeField('Bond, James')).toBe('"Bond, James"');
    });
    it('wraps strings containing a newline', () => {
        expect(escapeField('line1\nline2')).toBe('"line1\nline2"');
    });
    it('returns empty string for null / undefined', () => {
        expect(escapeField(null)).toBe('');
        expect(escapeField(undefined)).toBe('');
    });
});

describe('toCsv - serialization', () => {
    it('emits header + body in the column order', () => {
        const cols: CsvColumn<{ a: string; b: number }>[] = [
            { key: 'a', label: 'A' },
            { key: 'b', label: 'B' },
        ];
        const csv = toCsv([{ a: 'x', b: 1 }, { a: 'y', b: 2 }], cols);
        expect(csv).toBe('A,B\nx,1\ny,2');
    });
    it('uses the value extractor when supplied', () => {
        const cols: CsvColumn<{ a: string }>[] = [
            { key: 'a', label: 'A_UPPER', value: (r) => r.a.toUpperCase() },
        ];
        expect(toCsv([{ a: 'hello' }], cols)).toBe('A_UPPER\nHELLO');
    });
});

describe('toCsvDownload - row cap + truncation flag', () => {
    function mockRes() {
        const headers: Record<string, string> = {};
        let sentBody = '';
        const res: any = {
            setHeader(k: string, v: string | number) { headers[k.toLowerCase()] = String(v); },
            send(body: string) { sentBody = body; return this; },
        };
        return { res, headers, getBody: () => sentBody };
    }

    it('writes all rows when under maxRows and does NOT set X-Truncated', () => {
        const m = mockRes();
        const r = toCsvDownload(m.res, [{ a: 1 }, { a: 2 }], [{ key: 'a', label: 'A' }], {
            filename: 'small.csv', maxRows: 10,
        });
        expect(r.written).toBe(2);
        expect(r.truncated).toBe(false);
        expect(m.headers['x-truncated']).toBeUndefined();
    });

    it('caps at maxRows and emits X-Truncated headers with totals', () => {
        const m = mockRes();
        const rows = Array.from({ length: 50 }, (_, i) => ({ a: i }));
        const r = toCsvDownload(m.res, rows, [{ key: 'a', label: 'A' }], {
            filename: 'big.csv', maxRows: 10,
        });
        expect(r.written).toBe(10);
        expect(r.truncated).toBe(true);
        expect(m.headers['x-truncated']).toBe('true');
        expect(m.headers['x-truncated-cap']).toBe('10');
        expect(m.headers['x-truncated-total']).toBe('50');
    });

    it('sanitises the filename', () => {
        const m = mockRes();
        toCsvDownload(m.res, [], [{ key: 'a', label: 'A' }], {
            filename: '../../etc/passwd.csv', maxRows: 10,
        });
        // No path separators in the resulting Content-Disposition.
        expect(m.headers['content-disposition']).not.toMatch(/\.\.\//);
        expect(m.headers['content-disposition']).toMatch(/filename=".+passwd\.csv"/);
    });
});
