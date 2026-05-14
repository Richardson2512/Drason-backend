-- Rename the legacy 'heyreach_only' inbox_sync_mode value to 'sequence_only'.
-- The column is a free-form TEXT, so this is a data-only update — no DDL.

UPDATE "LinkedInAccount"
SET "inbox_sync_mode" = 'sequence_only'
WHERE "inbox_sync_mode" = 'heyreach_only';
