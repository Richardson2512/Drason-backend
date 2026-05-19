-- Make ValidationAttempt the single email-validation credit ledger.
-- Bulk validation (CSV batch, Clay ingest, by-tag) runs BEFORE a Lead row
-- exists, so attempts there were silently NOT recorded - splitting credit
-- accounting across two incompatible counters. Relaxing lead_id to
-- nullable lets every engine run write exactly one ledger row regardless
-- of Lead existence; organization_id + created_at is the usage key.
--
-- Non-destructive: DROP NOT NULL only relaxes the constraint; existing
-- rows are unaffected. lead_id has no FK relation (bare indexed column),
-- so nothing else changes.

-- AlterTable
ALTER TABLE "ValidationAttempt" ALTER COLUMN "lead_id" DROP NOT NULL;
