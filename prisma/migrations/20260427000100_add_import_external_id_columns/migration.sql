-- One-time-import provenance — every imported entity gets an external id from
-- the source platform (Smartlead lead.id, campaign.id, etc.) so the orchestrator
-- can upsert idempotently on retry. Safe to drop these columns 30d post-import.

ALTER TABLE "Lead"         ADD COLUMN "import_external_id" TEXT;
ALTER TABLE "Campaign"     ADD COLUMN "import_external_id" TEXT;
ALTER TABLE "Mailbox"      ADD COLUMN "import_external_id" TEXT;
ALTER TABLE "SequenceStep" ADD COLUMN "import_external_id" TEXT;
ALTER TABLE "StepVariant"  ADD COLUMN "import_external_id" TEXT;
ALTER TABLE "CampaignLead" ADD COLUMN "import_external_id" TEXT;

-- Day-1 health snapshot from source platform (Option C protection seeding).
-- Read by state machine + warmup service when local SendEvent history is thin.
ALTER TABLE "Mailbox" ADD COLUMN "import_baseline" JSONB;

-- Idempotency keys. Postgres treats NULLs as distinct in unique multi-column
-- indexes, so legacy rows with NULL import_external_id stay valid; only
-- imported rows participate in conflict resolution.
CREATE UNIQUE INDEX "Lead_organization_id_import_external_id_key"
    ON "Lead" ("organization_id", "import_external_id");

CREATE UNIQUE INDEX "Campaign_organization_id_import_external_id_key"
    ON "Campaign" ("organization_id", "import_external_id");

CREATE UNIQUE INDEX "Mailbox_organization_id_import_external_id_key"
    ON "Mailbox" ("organization_id", "import_external_id");

CREATE UNIQUE INDEX "SequenceStep_campaign_id_import_external_id_key"
    ON "SequenceStep" ("campaign_id", "import_external_id");

CREATE UNIQUE INDEX "StepVariant_step_id_import_external_id_key"
    ON "StepVariant" ("step_id", "import_external_id");

CREATE UNIQUE INDEX "CampaignLead_campaign_id_import_external_id_key"
    ON "CampaignLead" ("campaign_id", "import_external_id");
