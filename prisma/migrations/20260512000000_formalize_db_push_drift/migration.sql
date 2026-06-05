-- Formalize db-push-only schema drift.
--
-- Root cause: over time, schema changes were applied to staging via
-- `prisma db push` and never captured as migration files. The migration
-- chain therefore did NOT reproduce schema.prisma — any environment built
-- purely from migrations (e.g. prod via `migrate deploy`) ended up missing
-- columns/indexes the Prisma client expects, causing runtime failures
-- (notably: Lead.lead_score_adjustments missing → every lead.create threw →
-- all CSV imports rejected).
--
-- This migration is the authoritative output of:
--   prisma migrate diff --from-migrations ./prisma/migrations \
--                       --to-schema-datamodel ./prisma/schema.prisma
-- i.e. it closes the FULL gap between the migration chain and the schema,
-- so a fresh `migrate deploy` now reproduces schema.prisma exactly.
--
-- Note: the Domain DROP COLUMNs remove a stale duplicate of phase_bounces/
-- phase_clean_sends — those fields live on Mailbox in the schema (and in
-- code); the Domain copies were never in the schema and are unused.

-- DropForeignKey
ALTER TABLE "Mailbox" DROP CONSTRAINT "Mailbox_domain_id_fkey";

-- DropIndex
DROP INDEX "LeadScoreEvent_organization_id_idx";

-- AlterTable
ALTER TABLE "Domain" DROP COLUMN "phase_bounces",
DROP COLUMN "phase_clean_sends",
ADD COLUMN     "blacklist_score" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "last_full_blacklist_check" TIMESTAMP(3),
ADD COLUMN     "last_sent_at" TIMESTAMP(3),
ADD COLUMN     "paused_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Lead" ADD COLUMN     "bounced" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "health_checks" JSONB,
ADD COLUMN     "is_catch_all" BOOLEAN,
ADD COLUMN     "is_disposable" BOOLEAN,
ADD COLUMN     "lead_score_adjustments" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "validated_at" TIMESTAMP(3),
ADD COLUMN     "validation_score" INTEGER,
ADD COLUMN     "validation_source" TEXT,
ADD COLUMN     "validation_status" TEXT;

-- AlterTable
ALTER TABLE "Mailbox" ADD COLUMN     "connection_error" TEXT,
ADD COLUMN     "imap_status" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "paused_at" TIMESTAMP(3),
ADD COLUMN     "paused_by" TEXT DEFAULT 'system',
ADD COLUMN     "paused_reason" TEXT,
ADD COLUMN     "provider_restrictions" JSONB,
ADD COLUMN     "smtp_status" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "warmup_limit" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "reset_token_expires_at" TIMESTAMP(3),
ADD COLUMN     "reset_token_hash" TEXT;

-- CreateIndex
CREATE INDEX "Lead_organization_id_health_classification_idx" ON "Lead"("organization_id", "health_classification");

-- CreateIndex
CREATE INDEX "Lead_organization_id_validation_status_idx" ON "Lead"("organization_id", "validation_status");

-- CreateIndex
CREATE INDEX "Lead_health_classification_health_checked_at_idx" ON "Lead"("health_classification", "health_checked_at");

-- CreateIndex
CREATE INDEX "Lead_bounced_idx" ON "Lead"("bounced");

-- CreateIndex
CREATE INDEX "LeadScoreEvent_organization_id_created_at_idx" ON "LeadScoreEvent"("organization_id", "created_at");

-- CreateIndex
CREATE INDEX "RoutingRule_target_campaign_id_idx" ON "RoutingRule"("target_campaign_id");

-- CreateIndex
CREATE UNIQUE INDEX "User_reset_token_hash_key" ON "User"("reset_token_hash");

-- AddForeignKey
ALTER TABLE "Mailbox" ADD CONSTRAINT "Mailbox_domain_id_fkey" FOREIGN KEY ("domain_id") REFERENCES "Domain"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoutingRule" ADD CONSTRAINT "RoutingRule_target_campaign_id_fkey" FOREIGN KEY ("target_campaign_id") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "CampaignSuppression_campaign_id_kind_suppressed_campaign_id_sup" RENAME TO "CampaignSuppression_campaign_id_kind_suppressed_campaign_id_key";

