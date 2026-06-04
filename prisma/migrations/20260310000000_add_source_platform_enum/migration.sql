-- Bridge migration: SourcePlatform enum and source_platform columns
-- These were created via db push and later dropped in 20260426114009.
-- Must exist for 20260425232826 to add 'sequencer' via ALTER TYPE.

CREATE TYPE "SourcePlatform" AS ENUM ('smartlead', 'instantly', 'emailbison', 'replyio');

ALTER TABLE "Campaign"
    ADD COLUMN IF NOT EXISTS "source_platform" "SourcePlatform",
    ADD COLUMN IF NOT EXISTS "external_id" TEXT,
    ADD COLUMN IF NOT EXISTS "last_synced_at" TIMESTAMP(3);

ALTER TABLE "Domain"
    ADD COLUMN IF NOT EXISTS "source_platform" "SourcePlatform";

ALTER TABLE "Lead"
    ADD COLUMN IF NOT EXISTS "source_platform" "SourcePlatform";

ALTER TABLE "Mailbox"
    ADD COLUMN IF NOT EXISTS "source_platform" "SourcePlatform",
    ADD COLUMN IF NOT EXISTS "external_email_account_id" TEXT,
    ADD COLUMN IF NOT EXISTS "smartlead_email_account_id" INTEGER;

CREATE UNIQUE INDEX IF NOT EXISTS "Campaign_organization_id_source_platform_external_id_key"
    ON "Campaign"("organization_id", "source_platform", "external_id");

CREATE INDEX IF NOT EXISTS "Campaign_organization_id_source_platform_idx"
    ON "Campaign"("organization_id", "source_platform");

CREATE INDEX IF NOT EXISTS "Domain_organization_id_source_platform_idx"
    ON "Domain"("organization_id", "source_platform");

CREATE INDEX IF NOT EXISTS "Lead_organization_id_source_platform_idx"
    ON "Lead"("organization_id", "source_platform");

CREATE INDEX IF NOT EXISTS "Mailbox_organization_id_source_platform_idx"
    ON "Mailbox"("organization_id", "source_platform");
