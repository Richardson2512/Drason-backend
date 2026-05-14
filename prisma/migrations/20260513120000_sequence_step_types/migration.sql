-- Phase 3 — Sequence engine extension for multi-channel steps.
--
-- Extends both SequenceStep (campaign-side, executable) and
-- SequenceTemplateStep (templates page, cloned at campaign load) with:
--   - step_type: enum of channel-specific step types (email|linkedin_*|find_email|...)
--   - step_config: per-step-type JSONB payload (e.g. note text, reaction type)
--
-- Adds SequenceStepExecution audit table — one row per attempt, including
-- skips with reasons. Phase 5 (campaign dispatcher) is what reads these.
--
-- Backward-compat: all existing rows get step_type='email' and step_config='{}'
-- so the email dispatcher keeps using subject/preheader/body_html as before.

-- AlterTable: SequenceStep (campaign-side)
ALTER TABLE "SequenceStep" ADD COLUMN "step_type"   TEXT NOT NULL DEFAULT 'email';
ALTER TABLE "SequenceStep" ADD COLUMN "step_config" JSONB NOT NULL DEFAULT '{}';
CREATE INDEX "SequenceStep_step_type_idx" ON "SequenceStep"("step_type");

-- AlterTable: SequenceTemplateStep
ALTER TABLE "SequenceTemplateStep" ADD COLUMN "step_type"   TEXT NOT NULL DEFAULT 'email';
ALTER TABLE "SequenceTemplateStep" ADD COLUMN "step_config" JSONB NOT NULL DEFAULT '{}';
CREATE INDEX "SequenceTemplateStep_step_type_idx" ON "SequenceTemplateStep"("step_type");

-- CreateTable: SequenceStepExecution
CREATE TABLE "SequenceStepExecution" (
    "id"                  TEXT NOT NULL,
    "organization_id"     TEXT NOT NULL,
    "campaign_id"         TEXT NOT NULL,
    "campaign_lead_id"    TEXT NOT NULL,
    "sequence_step_id"    TEXT NOT NULL,
    "step_number"         INTEGER NOT NULL,
    "step_type"           TEXT NOT NULL,
    "status"              TEXT NOT NULL,
    "skip_reason"         TEXT,
    "branched_to_step"    INTEGER,
    "sender_ref_id"       TEXT,
    "sender_ref_type"     TEXT,
    "attempted_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at"        TIMESTAMP(3),
    "error_message"       TEXT,

    CONSTRAINT "SequenceStepExecution_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SequenceStepExecution_organization_id_campaign_id_idx"
    ON "SequenceStepExecution"("organization_id", "campaign_id");
CREATE INDEX "SequenceStepExecution_campaign_lead_id_attempted_at_idx"
    ON "SequenceStepExecution"("campaign_lead_id", "attempted_at");
CREATE INDEX "SequenceStepExecution_sequence_step_id_idx"
    ON "SequenceStepExecution"("sequence_step_id");
CREATE INDEX "SequenceStepExecution_status_idx"
    ON "SequenceStepExecution"("status");

ALTER TABLE "SequenceStepExecution"
    ADD CONSTRAINT "SequenceStepExecution_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "Organization"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
