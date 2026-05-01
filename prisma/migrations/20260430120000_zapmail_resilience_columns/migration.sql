-- Zapmail Custom-OAuth resilience columns on ConnectedAccount.
--
-- Each row needs four pieces of state to break the current zombie-row /
-- silent-quota-exhaustion / unbounded-poll failure modes (see fragility
-- audit dated 2026-04-30):
--
--   zapmail_export_id        — Zapmail's orchestration job id. Persisted so a
--                              reconciliation worker can poll the export status
--                              after a process restart or stuck-row sweep.
--   oauth_initiated_at       — when we kicked off the consent-walk for THIS
--                              attempt. Used to (a) bound importStatus polling
--                              at 60 min and (b) detect stale oauth_pending rows
--                              for the reconciler.
--   oauth_attempts           — how many times we've attempted Custom OAuth on
--                              this row in the current 7-day window. Zapmail
--                              caps at 3/mailbox/7d; we pre-check before queueing
--                              so the user gets an actionable error instead of
--                              a generic 429.
--   oauth_first_attempt_at   — anchor of the rolling 7-day quota window. Reset
--                              when the row transitions to active or when the
--                              window has fully passed.
--
-- All four are nullable / default-zero so existing rows are unaffected.

ALTER TABLE "ConnectedAccount"
    ADD COLUMN "zapmail_export_id"      INTEGER,
    ADD COLUMN "oauth_initiated_at"     TIMESTAMP(3),
    ADD COLUMN "oauth_attempts"         INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "oauth_first_attempt_at" TIMESTAMP(3);

-- Recovery worker scans by (connection_status, oauth_initiated_at). Index
-- supports both the stuck-row sweep ("pending older than 30 min") and the
-- expiry check on the importStatus endpoint.
CREATE INDEX "ConnectedAccount_connection_status_oauth_initiated_at_idx"
    ON "ConnectedAccount" ("connection_status", "oauth_initiated_at");
