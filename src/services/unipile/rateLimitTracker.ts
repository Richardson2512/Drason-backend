/**
 * Per-account Unipile 429 telemetry.
 *
 * Centralized counter the Unipile HTTP client increments every time it
 * observes a 429 response. We keep a rolling 60-minute ring of timestamps
 * per LinkedInAccount id so the account-detail UI can surface a banner
 * like "5 rate-limit events in the last hour — Unipile is throttling
 * this account; expect delays". This is the surface that lets operators
 * spot a per-account rate-limit issue before it turns into a CONNECTING
 * / ERROR account-status event.
 *
 * Memory-only by design — the data is operational signal, not historical
 * record. If the process restarts, the counter resets; the longer-form
 * audit lives in the worker logs.
 *
 * Workspace-wide stats are exposed via `getUnipile429Aggregate()` so the
 * health page / observability dashboard can render a banner that scopes
 * across all accounts even when the caller doesn't know which account
 * was hit.
 */

const WINDOW_MS = 60 * 60 * 1000;
const MAX_EVENTS_PER_ACCOUNT = 200; // safety cap — keep the ring bounded

interface AccountRing {
    timestamps: number[]; // unix ms, append-only until prune
}

const byAccount = new Map<string, AccountRing>();

function prune(ring: AccountRing, now: number): void {
    const cutoff = now - WINDOW_MS;
    // Find first non-stale; since timestamps are append-only, a single
    // pass from the front is enough.
    let firstFresh = 0;
    while (firstFresh < ring.timestamps.length && ring.timestamps[firstFresh] < cutoff) {
        firstFresh += 1;
    }
    if (firstFresh > 0) ring.timestamps.splice(0, firstFresh);
    if (ring.timestamps.length > MAX_EVENTS_PER_ACCOUNT) {
        ring.timestamps.splice(0, ring.timestamps.length - MAX_EVENTS_PER_ACCOUNT);
    }
}

export function recordUnipile429(accountId: string | undefined | null): void {
    if (!accountId) return;
    const now = Date.now();
    let ring = byAccount.get(accountId);
    if (!ring) {
        ring = { timestamps: [] };
        byAccount.set(accountId, ring);
    }
    ring.timestamps.push(now);
    prune(ring, now);
}

export interface Unipile429Stats {
    /** Count of 429s in the last hour. */
    count_60m: number;
    /** Count of 429s in the last 5 minutes — surfaces the "hot" state
     *  even when the hourly count has decayed. */
    count_5m: number;
    /** ISO timestamp of the most recent 429, or null. */
    last_at: string | null;
}

export function getUnipile429Stats(accountId: string): Unipile429Stats {
    const ring = byAccount.get(accountId);
    if (!ring) return { count_60m: 0, count_5m: 0, last_at: null };
    const now = Date.now();
    prune(ring, now);
    const fiveMinAgo = now - 5 * 60 * 1000;
    let count5 = 0;
    for (let i = ring.timestamps.length - 1; i >= 0; i--) {
        if (ring.timestamps[i] >= fiveMinAgo) count5 += 1;
        else break;
    }
    const last = ring.timestamps.length > 0 ? ring.timestamps[ring.timestamps.length - 1] : null;
    return {
        count_60m: ring.timestamps.length,
        count_5m: count5,
        last_at: last ? new Date(last).toISOString() : null,
    };
}

export function getUnipile429Aggregate(): { total_60m: number; accounts_affected: number } {
    const now = Date.now();
    let total = 0;
    let affected = 0;
    for (const ring of byAccount.values()) {
        prune(ring, now);
        if (ring.timestamps.length > 0) {
            total += ring.timestamps.length;
            affected += 1;
        }
    }
    return { total_60m: total, accounts_affected: affected };
}

/** Test/dev helper — wipes all rings. */
export function resetUnipile429Tracker(): void {
    byAccount.clear();
}
