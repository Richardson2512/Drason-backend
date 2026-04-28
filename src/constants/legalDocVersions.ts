/**
 * Legal Document Versions
 *
 * Single source of truth for the current Terms of Service and Privacy Policy
 * version identifiers. The version string is the date the document was last
 * substantively revised (YYYY-MM-DD), matching the "Last updated" line on the
 * customer-facing pages.
 *
 * When you edit /terms/page.tsx or /privacy/page.tsx in a way that materially
 * changes obligations, increment the corresponding version here. The
 * requireFreshConsent middleware will then trigger a blocking re-acceptance
 * modal for every existing user on their next authenticated request.
 *
 * The version string is the consent-record's persistent identity. We do not
 * normally store the full document text in DB — git history at this version
 * date is the canonical archive. document_hash is optional and only set when
 * we have a deterministic hash of the doc text at acceptance time.
 */

export const TOS_VERSION = '2026-04-28';
export const PRIVACY_VERSION = '2026-04-28';

/**
 * URL paths shown to the user, included in the consent record's metadata so
 * the audit trail captures exactly where they viewed the document.
 */
export const TOS_PATH = '/terms';
export const PRIVACY_PATH = '/privacy';

/**
 * Cookie-banner version. Bump when categories change (e.g., adding a new
 * tracker class). Existing analytics consents remain valid for the version
 * they were given against; bumping triggers a fresh banner.
 */
export const COOKIE_POLICY_VERSION = '2026-04-28';

export const LEGAL_VERSIONS = {
    tos: TOS_VERSION,
    privacy: PRIVACY_VERSION,
    cookies: COOKIE_POLICY_VERSION,
} as const;
