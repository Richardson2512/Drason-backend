/**
 * Freezes the CSV-field escaping contract: formula-injection neutralization
 * + RFC 4180 structural quoting. Regression guard for the three exports
 * (campaign leads, contacts, cold-call list) that previously quoted (or not)
 * but never neutralized formula injection on externally-ingested lead data.
 */

import { escapeCsvField } from '../src/utils/csv';

describe('escapeCsvField', () => {
    it('passes plain values through unchanged', () => {
        expect(escapeCsvField('Acme Inc')).toBe('Acme Inc');
        expect(escapeCsvField('john@acme.com')).toBe('john@acme.com');
        expect(escapeCsvField(42)).toBe('42');
    });

    it('renders null/undefined as empty', () => {
        expect(escapeCsvField(null)).toBe('');
        expect(escapeCsvField(undefined)).toBe('');
    });

    it('neutralizes formula-injection leading characters with a quote prefix', () => {
        expect(escapeCsvField('=1+1')).toBe("'=1+1");
        expect(escapeCsvField('+44 20 1234')).toBe("'+44 20 1234");
        expect(escapeCsvField('-2')).toBe("'-2");
        expect(escapeCsvField('@SUM(A1)')).toBe("'@SUM(A1)");
        expect(escapeCsvField('\tcmd')).toBe("'\tcmd"); // tab is not an RFC-quote trigger
        // CR gets the formula-prefix AND then triggers RFC 4180 quoting (a field
        // containing CR must be quoted), so the cell is wrapped.
        expect(escapeCsvField('\rcmd')).toBe('"\'\rcmd"');
    });

    it('RFC 4180 quotes values with comma / quote / newline and doubles quotes', () => {
        expect(escapeCsvField('Smith, John')).toBe('"Smith, John"');
        expect(escapeCsvField('say "hi"')).toBe('"say ""hi"""');
        expect(escapeCsvField('line1\nline2')).toBe('"line1\nline2"');
    });

    it('applies BOTH guards: a formula value that also needs quoting', () => {
        // leading '=' AND contains a comma -> prefix quote first, then RFC-quote the whole cell
        expect(escapeCsvField('=HYPERLINK("http://x"),"a")')).toBe('"\'=HYPERLINK(""http://x""),""a"")"');
    });

    it('the classic exfil payload is neutralized', () => {
        // would auto-execute in Excel/Sheets without the leading-quote guard
        const payload = '=cmd|\'/C calc\'!A1';
        expect(escapeCsvField(payload).startsWith("'=")).toBe(true);
    });
});
