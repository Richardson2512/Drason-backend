/**
 * Lead contactability - THE single source of truth for "is this
 * CampaignLead row still reachable for outbound contact (cold call,
 * dialer push, sales-engagement export, CSV call sheet)?"
 *
 * Why this module exists: the rule used to be three inline checks inside
 * coldCallListService.generateProspectList and NOWHERE else - so the
 * snapshot read path, the CSV builder, and the JustCall/Outreach export
 * endpoints all happily surfaced bounced / unsubscribed / GDPR-erased
 * people. That divergence (one inline copy, skipped everywhere else) is
 * the root cause of the cold-call leak findings. Every path that surfaces
 * or exports a prospect MUST go through here so the policy cannot drift
 * again.
 *
 * Two distinct concepts, deliberately separate:
 *
 *   isHardSuppressed - bounced OR unsubscribed OR erased. NEVER put these
 *     into a call sheet, a dialer, or a sales sequence. Applied at list
 *     generation, CSV build, and (authoritatively, stale-client-proof) at
 *     the export ingestion boundary.
 *
 *   isErased - the GDPR right-to-erasure tombstone only (a strict subset
 *     of hard-suppressed). Used where erased must be REMOVED outright for
 *     privacy even though bounced/unsubscribed rows may legitimately stay
 *     visible-but-flagged in the UI (post-snapshot state-change awareness).
 *
 * Reply handling is intentionally NOT here: "replied" is a per-list rule
 * (ListRules.requireNoReply), not an absolute contactability bar, and the
 * UI deliberately flags repliers rather than hiding them (a reply can be
 * exactly who an SDR wants to call). Keeping reply logic in the rules
 * layer is the correct boundary, not an omission.
 *
 * Pure (no IO) - unit-tested.
 */

/** Minimal structural shape any CampaignLead-derived row satisfies. */
export interface ContactabilityRow {
    status?: string | null;
    bounced_at?: Date | null;
    unsubscribed_at?: Date | null;
    email?: string | null;
}

/**
 * The erasure tombstone sentinel. eraseLeadPII flips CampaignLead/Lead
 * `status` to 'erased' AND rewrites `email` to `erased-<uuid>@anonymized
 * .invalid`. The codebase already uses the `erased-` email prefix as the
 * canonical "already erased" marker in the erasure-skip loops; we check
 * BOTH so a legacy row that has only one of the two set is still caught.
 */
export function isErased(row: { status?: string | null; email?: string | null }): boolean {
    if (row.status === 'erased') return true;
    return typeof row.email === 'string' && row.email.startsWith('erased-');
}

/**
 * Absolute "do not contact" gate. True when the prospect bounced, the
 * recipient unsubscribed, or the lead was erased. A `true` here means the
 * row must not appear on a call sheet, be exported to a dialer/sequence,
 * or be written to a downloadable CSV - regardless of which entry point
 * asked.
 */
export function isHardSuppressed(row: ContactabilityRow): boolean {
    if (row.bounced_at != null) return true;
    if (row.unsubscribed_at != null) return true;
    const s = row.status;
    if (s === 'bounced' || s === 'unsubscribed') return true;
    return isErased(row);
}

/**
 * Same policy as isHardSuppressed, expressed over a hydrated ProspectRow
 * (which carries the already-derived `bounced`/`unsubscribed` booleans
 * instead of the raw *_at columns). The booleans are faithful projections
 * (`bounced = bounced_at !== null`), so this is the SAME rule, not a
 * second copy of it - it just adapts the shape. Used by the CSV builder
 * (a downloadable call sheet must never contain unreachable rows).
 */
export function isProspectRowSuppressed(p: {
    bounced?: boolean | null;
    unsubscribed?: boolean | null;
    email?: string | null;
}): boolean {
    return Boolean(p.bounced) || Boolean(p.unsubscribed) || isErased(p);
}

/**
 * Whether it is worth spending one BYOK enrichment lookup on this
 * prospect's phone. True ONLY when there is no usable number on file AND
 * the prospect is still contactable. Centralised here so the policy
 * "never burn the customer's enrichment credits on a bounced /
 * unsubscribed / erased lead, and never re-enrich a lead that already has
 * a number" lives in exactly one place. Pure - unit-tested.
 */
export function shouldEnrichPhone(
    row: ContactabilityRow & { phone?: string | null },
): boolean {
    if (isHardSuppressed(row)) return false;
    return !(typeof row.phone === 'string' && row.phone.trim().length > 0);
}
