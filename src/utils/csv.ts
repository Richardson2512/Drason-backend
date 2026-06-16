/**
 * CSV field escaping - the single source of truth for serializing one cell.
 *
 * Two concerns, both required, previously implemented inconsistently across
 * five separate CSV exporters (admin + dashboard did both correctly; the
 * campaign-leads, contacts, and cold-call-list exports each missed one or
 * both). Centralized here so every export is safe and they can't drift again.
 *
 *  1. CSV-injection (a.k.a. formula injection): a cell whose value starts with
 *     = + - @ TAB or CR is interpreted as a formula by Excel / Google Sheets /
 *     LibreOffice when the file is opened - a real RCE/exfil vector since these
 *     values (name, company, title, ...) come from externally-ingested leads
 *     (Clay, Apollo, CSV upload). Neutralized by prefixing a single quote, the
 *     OWASP-recommended mitigation. Quoting alone does NOT prevent this - the
 *     spreadsheet strips CSV quotes before evaluating the cell.
 *
 *  2. RFC 4180 structural escaping: a value containing a comma, double-quote,
 *     or newline must be wrapped in double-quotes with embedded quotes doubled,
 *     or it corrupts the row/column structure.
 */
export function escapeCsvField(val: unknown): string {
    if (val === null || val === undefined) return '';
    let str = String(val);

    // 1. Formula-injection neutralization (must run before quoting).
    if (/^[=+\-@\t\r]/.test(str)) {
        str = `'${str}`;
    }

    // 2. RFC 4180 quoting.
    if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
        str = `"${str.replace(/"/g, '""')}"`;
    }

    return str;
}
