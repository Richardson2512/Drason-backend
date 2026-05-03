/**
 * Mailbox Import Provider — shared interface for bulk-import resellers.
 *
 * Resellers like Zapmail, Premium Inboxes, Mission Inbox, and Scaled Mail
 * sell pre-warmed Gmail/Outlook mailboxes in bulk. Each one exposes a
 * different API surface, but the contract Superkabe needs is identical:
 *
 *   1. Validate the customer's API key for the reseller.
 *   2. List the customer's mailboxes with credentials (email + appPassword).
 *   3. Bulk-create ConnectedAccount rows from selected mailboxes.
 *   4. Disconnect (clear the stored API key).
 *
 * This file defines the shared contract. Each reseller has its own
 * implementation file in this directory that satisfies it. A registry
 * (./registry.ts) lets controllers dispatch by provider key.
 *
 * Architectural rule: providers MUST NOT touch ConnectedAccount directly.
 * They return raw credential bundles; the controller layer encrypts and
 * persists them. This keeps encryption + provisioning in one place and
 * means a buggy provider can't accidentally leak plaintext to the DB.
 */

/** Stable string IDs used in URLs, DB columns, and frontend buttons. */
export type MailboxImportProviderKey =
    | 'zapmail'
    | 'premium_inboxes'
    | 'mission_inbox'
    | 'scaled_mail';

/** What a provider returns for each mailbox after listing the customer's
 *  inventory. The credentials are PLAINTEXT — the controller is responsible
 *  for encrypting before any DB write. */
export interface RemoteMailboxCredential {
    /** Provider-side mailbox identifier (used for selecting/excluding in bulk import). */
    remoteId: string;
    email: string;
    /** Display name / first-last name combined. Optional — not all resellers expose. */
    displayName?: string;
    provider: 'google' | 'microsoft';
    /** Domain the mailbox lives on, if known. */
    domain?: string;
    /** App password (Gmail) or SMTP password (Microsoft). REQUIRED for SMTP-based send.
     *  If null, the mailbox isn't ready (still being provisioned by the reseller). */
    appPassword: string | null;
    /** Optional 2FA TOTP secret. Useful for any future flow that needs to log
     *  in interactively (e.g., re-issuing app passwords). */
    totpSecret?: string | null;
    /** Recovery email, if the reseller exposes it. */
    recoveryEmail?: string | null;
    /** Operational state from the reseller (e.g., "active" / "warming-up").
     *  Surfaced verbatim in our UI; we do NOT block import on these. */
    remoteStatus?: string | null;
    /** True if the reseller flags this mailbox as warmed up. */
    isWarmedUp?: boolean;
}

/** Result of a bulk-import operation. Maps 1:1 to selected remoteIds. */
export interface BulkImportResultItem {
    remoteId: string;
    email: string;
    status: 'imported' | 'updated' | 'skipped' | 'failed';
    /** ConnectedAccount.id when status is 'imported' or 'updated'. */
    connectedAccountId?: string;
    /** Reason when status is 'skipped' or 'failed'. */
    error?: string;
}

export interface BulkImportResult {
    total: number;
    imported: number;
    updated: number;
    skipped: number;
    failed: number;
    items: BulkImportResultItem[];
}

/**
 * Required interface every reseller integration must satisfy.
 *
 * Implementations live in this directory and are registered in ./registry.ts.
 * Methods are async because every implementation will hit a remote API.
 */
export interface MailboxImportProvider {
    /** Stable identifier — matches the URL slug and DB string. */
    readonly key: MailboxImportProviderKey;

    /** Human-readable name for UI. */
    readonly displayName: string;

    /** Whether this provider's API is fully implemented or stub-only.
     *  False = controller should return 501 Not Implemented for write ops. */
    readonly isImplemented: boolean;

    /** Validate that the API key works against the reseller's API.
     *  Returns true on success. Throws on transport errors. Returns false
     *  for explicit "key invalid" responses (so callers can show a
     *  user-friendly error instead of a 500). */
    validateApiKey(apiKey: string): Promise<boolean>;

    /** List ALL mailboxes the customer has access to with this API key.
     *  Some resellers paginate — implementations should handle pagination
     *  internally and return the flattened list. */
    listMailboxes(apiKey: string): Promise<RemoteMailboxCredential[]>;
}
