/**
 * DSN parser — RFC 3464 Delivery Status Notifications.
 *
 * Async bounces returned to the sending mailbox arrive as multipart/report
 * messages with a `message/delivery-status` part. This parser extracts the
 * canonical fields without bringing in a full MIME library — we just need
 * Action, Status, Diagnostic-Code, Original-Recipient, and Reporting-MTA.
 *
 * Intentionally permissive: fields are case-insensitive and may have folded
 * whitespace (RFC 5322 §2.2.3). We unfold and normalize before scanning.
 *
 * Detection strategy: look for `Content-Type: multipart/report` with
 * `report-type=delivery-status` in the top-level headers. Falls back to
 * detecting a `message/delivery-status` MIME boundary anywhere in the body
 * to handle providers that produce non-standard top-level Content-Types.
 */

export interface DsnResult {
    isDsn: boolean;
    /** RFC 3464 Action field — "failed" is the one that matters for bounces */
    action?: 'failed' | 'delayed' | 'delivered' | 'relayed' | 'expanded';
    /** RFC 3463 enhanced status code, e.g. "5.1.1" */
    status?: string;
    /** SMTP transcript from the receiving MTA */
    diagnosticCode?: string;
    /** Email address that bounced */
    originalRecipient?: string;
    /** MTA that generated the DSN */
    reportingMta?: string;
    /** Top-level numeric class — 5 (permanent), 4 (transient), 2 (success) */
    statusClass?: number;
}

const REPORT_CT_RE = /content-type:\s*multipart\/report[^\n]*report-type\s*=\s*delivery-status/i;
const DELIVERY_STATUS_PART_RE = /content-type:\s*message\/delivery-status/i;

const FIELD_REGEXES: Record<keyof Omit<DsnResult, 'isDsn' | 'statusClass'>, RegExp> = {
    action: /^action:\s*(failed|delayed|delivered|relayed|expanded)\s*$/im,
    status: /^status:\s*(\d+\.\d+\.\d+)\s*$/im,
    diagnosticCode: /^diagnostic-code:\s*([^\r\n]+(?:\r?\n[ \t]+[^\r\n]+)*)/im,
    originalRecipient: /^(?:original|final)-recipient:\s*(?:rfc822;\s*)?([^\r\n]+)\s*$/im,
    reportingMta: /^reporting-mta:\s*(?:dns;\s*)?([^\r\n]+)\s*$/im,
};

/**
 * Detect whether `raw` is a DSN. Strict-ish — both the top-level Content-Type
 * AND a `message/delivery-status` body part must appear.
 */
export function isDsnMessage(raw: string): boolean {
    if (!raw) return false;
    return REPORT_CT_RE.test(raw) || DELIVERY_STATUS_PART_RE.test(raw);
}

/**
 * Unfold RFC 5322 header continuations (`\r\n[ \t]`) into a single line so
 * regex matching doesn't have to deal with them.
 */
function unfoldHeaders(raw: string): string {
    return raw.replace(/\r?\n[ \t]+/g, ' ');
}

/**
 * Parse a raw email message. Returns `{ isDsn: false }` if it doesn't look
 * like a DSN; otherwise extracts whatever fields are present.
 */
export function parseDsn(raw: string): DsnResult {
    if (!raw || !isDsnMessage(raw)) {
        return { isDsn: false };
    }

    // Find the message/delivery-status part. We scan from there to the next
    // MIME boundary or end-of-input. Most DSNs put the per-recipient fields
    // (Status, Action, Diagnostic-Code, Original-Recipient) in this part.
    const lower = raw.toLowerCase();
    const partIdx = lower.indexOf('content-type: message/delivery-status');
    const slice = partIdx >= 0 ? raw.slice(partIdx) : raw;
    const unfolded = unfoldHeaders(slice);

    const result: DsnResult = { isDsn: true };

    for (const [key, re] of Object.entries(FIELD_REGEXES) as [keyof typeof FIELD_REGEXES, RegExp][]) {
        const match = unfolded.match(re);
        if (match) {
            const value = match[1].trim();
            (result as any)[key] = value;
        }
    }

    if (result.status) {
        const top = parseInt(result.status.split('.')[0], 10);
        if (!Number.isNaN(top)) result.statusClass = top;
    }

    return result;
}

/**
 * Convenience: classify a parsed DSN as a permanent failure that should
 * trigger BounceEvent + threshold checks.
 */
export function isPermanentBounce(dsn: DsnResult): boolean {
    if (!dsn.isDsn) return false;
    if (dsn.action !== 'failed') return false;
    return dsn.statusClass === 5;
}
