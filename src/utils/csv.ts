/**
 * CSV serialization helpers - the ONE place every report/export in the
 * backend goes for "convert these rows into a downloadable .csv".
 *
 * Pre-fix (Reports audit R2 + R3): two parallel implementations existed.
 *   - adminController had the GOOD one (escapeField + toCsv) that
 *     prefixes formula-leading characters and double-quotes embedded
 *     quotes - the documented OWASP "CSV injection" mitigation.
 *   - campaignController.exportCampaignLeads had the BAD inline form
 *     `row.map(cell => "\"${cell}\"").join(',')` that wraps every cell
 *     in raw quotes WITHOUT escaping embedded quotes (breaks the CSV
 *     when a lead's persona contains a quote) and WITHOUT prefixing
 *     formula-leading chars. A lead persona starting with
 *     `=HYPERLINK("http://attacker","Click")` becomes a live formula
 *     when the customer opens the file in Excel.
 * Same class as Notifications N2 / API/MCP G3 (parallel reimplementation
 * of a primitive the codebase already has).
 *
 * This module is the single source of truth. The original `escapeField`
 * lives here unchanged; `toCsvDownload` adds the row-cap + truncation
 * indicator that closes R3 (unbounded exports OOM-ing the worker on
 * an org with a million leads).
 */

import type { Response } from 'express';

/**
 * Escape one CSV field.
 *
 *   - Formula-leading chars (= + - @ \t \r) get a single-quote prefix
 *     so Excel / Numbers / LibreOffice don't interpret them as a
 *     formula on open (OWASP "CSV injection" mitigation).
 *   - Embedded quotes are doubled per RFC 4180.
 *   - Strings containing commas / quotes / newlines get wrapped.
 */
export function escapeField(val: unknown): string {
    if (val === null || val === undefined) return '';
    let str = String(val);
    if (/^[=+\-@\t\r]/.test(str)) {
        str = "'" + str;
    }
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        str = '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
}

export interface CsvColumn<T = Record<string, unknown>> {
    key: keyof T & string;
    label: string;
    /** Optional value extractor for computed columns. */
    value?: (row: T) => unknown;
}

/**
 * Serialize a list of rows to CSV. Simple form - no cap, no streaming.
 * For exports that could span millions of rows, use `toCsvDownload`
 * which bakes in the row cap + truncation header.
 */
export function toCsv<T extends Record<string, any>>(
    rows: T[],
    columns: CsvColumn<T>[]
): string {
    const header = columns.map(c => escapeField(c.label)).join(',');
    const body = rows
        .map(row => columns.map(c => escapeField(c.value ? c.value(row) : row[c.key])).join(','))
        .join('\n');
    return header + '\n' + body;
}

export interface CsvDownloadOpts {
    /** Maximum rows to include in the download. Default 50_000.
     *  Should match the `take` limit on the upstream findMany so the
     *  truncation flag is honest. */
    maxRows?: number;
    /** Customer-visible filename (no path, no separators). */
    filename: string;
}

export interface CsvDownloadResult {
    /** Number of rows actually written. */
    written: number;
    /** True when the input row count exceeded `maxRows`. */
    truncated: boolean;
}

/**
 * Build the CSV body and write it to the Express response with the
 * standard download headers. Caps at `maxRows` and sets an
 * `X-Truncated: true` header when the input exceeded the cap so a
 * future UI / scripted consumer can detect partial exports without
 * parsing the body.
 *
 * Doesn't stream yet - the existing call sites buffer their findMany
 * result in memory anyway. Streaming is a separate improvement that
 * would also need the upstream queries to be cursor-paginated; this
 * helper at least bounds the buffer at a known upper limit.
 */
export function toCsvDownload<T extends Record<string, any>>(
    res: Response,
    rows: T[],
    columns: CsvColumn<T>[],
    opts: CsvDownloadOpts,
): CsvDownloadResult {
    const maxRows = opts.maxRows ?? 50_000;
    const truncated = rows.length > maxRows;
    const visible = truncated ? rows.slice(0, maxRows) : rows;
    const csv = toCsv(visible, columns);

    const safeFilename = opts.filename.replace(/[^a-z0-9._-]/gi, '_');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}"`);
    if (truncated) {
        res.setHeader('X-Truncated', 'true');
        res.setHeader('X-Truncated-Cap', String(maxRows));
        res.setHeader('X-Truncated-Total', String(rows.length));
    }
    res.send(csv);

    return { written: visible.length, truncated };
}
