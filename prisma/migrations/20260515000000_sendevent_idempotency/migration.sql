-- Idempotency identity for native sequencer sends.
--
-- campaign_lead_id + step_number are NULL for every existing row and for
-- all webhook-import (Smartlead/Zapmail) and manual Unibox sends — those
-- paths are inherently single and never traverse the racing dispatcher.
-- Only the send-queue worker populates both, identifying the delivered
-- (lead, step). Postgres treats NULLs as DISTINCT, so the unique index
-- below behaves as a partial index: it enforces at-most-one delivered
-- send per (lead, step) and ignores the NULL rows entirely. No backfill
-- needed; the index builds cleanly over all-NULL existing data.

-- AlterTable
ALTER TABLE "SendEvent" ADD COLUMN     "campaign_lead_id" TEXT,
ADD COLUMN     "step_number" INTEGER;

-- CreateIndex
CREATE UNIQUE INDEX "SendEvent_campaign_lead_id_step_number_key" ON "SendEvent"("campaign_lead_id", "step_number");
