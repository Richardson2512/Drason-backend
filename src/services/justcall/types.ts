/**
 * JustCall.io integration types.
 *
 * JustCall's REST API (v2.1, base https://api.justcall.io/v2.1) returns
 * plain JSON - no JSON:API envelope. List responses are typically
 *   { status: 'success', data: [...], count, page, total_pages }
 * single-resource responses
 *   { status: 'success', data: {...} }
 * and errors
 *   { status: 'error', message: '...', code?: '...' }
 *
 * client.ts hides those small variances; everything below is the
 * normalized shape we hand to the controller / worker.
 */

/** A single sales-dialer campaign as JustCall describes it. We surface
 *  only the fields the picker UI actually needs. */
export interface JustCallCampaignSummary {
    id: string;
    name: string;
    type: string | null;            // 'Autodial' | 'Predictive' | 'Dynamic'
    status: string | null;          // 'active' | 'paused' | etc - verbatim
    contactCount: number | null;    // how many contacts already in campaign
}

/** Identity bundle returned by /users when probing the connected account.
 *  JustCall associates a key with a single account; the first user is
 *  effectively "the owner" for display purposes. */
export interface JustCallAccountInfo {
    userId: string;
    userEmail: string;
    accountName: string | null;
}

/** Per-contact input for a sales-dialer push. Mirrors JustCall's
 *  bulk_import body shape so the worker can hand straight off. */
export interface JustCallContactInput {
    /** Free-form display name. Required by JustCall - first+last joined. */
    name: string;
    /** E.164 if possible; JustCall accepts national format too as long as
     *  country_code is present on the campaign. Optional now - for parity
     *  with Outreach we push contacts even when no phone is on file; JustCall
     *  validates per-row and reports unusable rows back via the bulk_import
     *  response (skipped/failed counts). */
    phone_number?: string | null;
    email?: string | null;
    company?: string | null;
    title?: string | null;
}

/** Aggregate counts JustCall returns from a single bulk_import call. The
 *  spec doesn't separate created vs updated - we record the sum as
 *  "added" and treat anything else as skipped/failed. */
export interface JustCallBulkResult {
    /** Total contacts JustCall accepted into the campaign. */
    added: number;
    /** Already-present + invalid combined when JustCall doesn't break them
     *  out per row. */
    skipped: number;
    /** Hard failures (validation errors per row). */
    failed: number;
    /** JustCall's batch identifier when present. Useful for downstream
     *  reconciliation but not depended on. */
    batchId: string | null;
}

/**
 * Typed error so the controller / worker can route on retryability and
 * provider code without parsing strings.
 *
 * `retryable=true` means the worker should keep the job in `running` and
 * try again next tick. `false` finalizes the job as `failed`.
 */
export class JustCallError extends Error {
    constructor(
        message: string,
        public readonly retryable: boolean,
        public readonly providerCode?: string,
        public readonly status?: number,
    ) {
        super(message);
        this.name = 'JustCallError';
    }
}
