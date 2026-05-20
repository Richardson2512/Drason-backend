/**
 * Shared date-range parser for analytics + reporting query strings.
 *
 * Pre-fix (Reports audit R5): every analytics controller did its own
 * `new Date(req.query.start_date as string)`. `new Date('foo')` returns
 * Invalid Date - silent: Prisma later rejects the comparison with an
 * opaque error and the user sees a 500. Just sloppy UX, not a security
 * hole, but easy to fix and consistent with the rest of the audit's
 * "shared utility" theme.
 *
 * Contract:
 *   - Accepts ISO-8601 strings only (`new Date(...)` round-trip check).
 *   - Returns explicit defaults (default = last 30 days for queries that
 *     don't pass anything).
 *   - Caps the range at MAX_RANGE_DAYS so a user can't request "all
 *     events from 1970" and OOM the worker.
 */

const MAX_RANGE_DAYS = 366; // one year + leap

export interface DateRangeOpts {
    /** Default span when neither bound is supplied. */
    defaultDays?: number;
}

export interface DateRangeResult {
    ok: true;
    start: Date;
    end: Date;
}
export interface DateRangeError {
    ok: false;
    code: 'invalid_start' | 'invalid_end' | 'range_inverted' | 'range_too_large';
    message: string;
}

export function parseDateRange(
    rawStart: unknown,
    rawEnd: unknown,
    opts: DateRangeOpts = {},
): DateRangeResult | DateRangeError {
    const defaultDays = opts.defaultDays ?? 30;
    const now = new Date();
    const fallbackStart = new Date(now.getTime() - defaultDays * 24 * 60 * 60 * 1000);

    let start: Date;
    if (rawStart === undefined || rawStart === null || rawStart === '') {
        start = fallbackStart;
    } else if (typeof rawStart === 'string') {
        const d = new Date(rawStart);
        if (Number.isNaN(d.getTime())) {
            return { ok: false, code: 'invalid_start', message: `start_date "${rawStart}" is not a valid ISO-8601 date` };
        }
        start = d;
    } else {
        return { ok: false, code: 'invalid_start', message: 'start_date must be an ISO-8601 string' };
    }

    let end: Date;
    if (rawEnd === undefined || rawEnd === null || rawEnd === '') {
        end = now;
    } else if (typeof rawEnd === 'string') {
        const d = new Date(rawEnd);
        if (Number.isNaN(d.getTime())) {
            return { ok: false, code: 'invalid_end', message: `end_date "${rawEnd}" is not a valid ISO-8601 date` };
        }
        end = d;
    } else {
        return { ok: false, code: 'invalid_end', message: 'end_date must be an ISO-8601 string' };
    }

    if (end.getTime() < start.getTime()) {
        return { ok: false, code: 'range_inverted', message: 'end_date must be on or after start_date' };
    }

    const rangeDays = (end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000);
    if (rangeDays > MAX_RANGE_DAYS) {
        return {
            ok: false,
            code: 'range_too_large',
            message: `date range exceeds ${MAX_RANGE_DAYS} days (got ${Math.ceil(rangeDays)}). Narrow the range or split into multiple queries.`,
        };
    }

    return { ok: true, start, end };
}
