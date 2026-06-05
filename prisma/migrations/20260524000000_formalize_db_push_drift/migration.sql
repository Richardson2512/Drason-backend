-- Formalize db-push-only schema drift (staging).
--
-- Same root cause as main: schema changes were applied to the dev DB via
-- `prisma db push` and never captured as migration files, so the migration
-- chain did not reproduce schema.prisma. A fresh `migrate deploy` failed
-- mid-chain (20260418 referenced DomainInsight, which no migration created).
--
-- The two bridge migrations (20260309_add_missing_bridge_tables,
-- 20260310_add_source_platform_enum) restore the tables/enum the chain was
-- missing before 20260418. This migration is the authoritative output of
--   prisma migrate diff --from-migrations ./prisma/migrations \
--                       --to-schema-datamodel ./prisma/schema.prisma
-- run with those bridges in place, so it closes the FULL remaining gap for
-- staging's (larger) schema — LinkedIn/agency/engagement tables included.
--
-- Verified: fresh DB + full chain -> migrate diff vs schema is empty.

-- DropForeignKey
ALTER TABLE "Mailbox" DROP CONSTRAINT "Mailbox_domain_id_fkey";

-- DropIndex
DROP INDEX "EmailMessage_message_id_idx";

-- DropIndex
DROP INDEX "LeadScoreEvent_organization_id_idx";

-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "deleted_at" TIMESTAMP(3),
ADD COLUMN     "deleted_by_user_id" TEXT;

-- AlterTable
ALTER TABLE "Domain" DROP COLUMN "phase_bounces",
DROP COLUMN "phase_clean_sends",
ADD COLUMN     "blacklist_score" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "last_full_blacklist_check" TIMESTAMP(3),
ADD COLUMN     "last_sent_at" TIMESTAMP(3),
ADD COLUMN     "paused_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "EmailMessage" ADD COLUMN     "send_error" TEXT,
ADD COLUMN     "send_status" TEXT;

-- AlterTable
ALTER TABLE "EngagementEvent" ADD COLUMN     "comment_text" TEXT;

-- AlterTable
ALTER TABLE "IcpProfile" ADD COLUMN     "deleted_at" TIMESTAMP(3),
ADD COLUMN     "deleted_by_user_id" TEXT;

-- AlterTable
ALTER TABLE "Lead" ADD COLUMN     "bounced" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "health_checks" JSONB,
ADD COLUMN     "is_catch_all" BOOLEAN,
ADD COLUMN     "is_disposable" BOOLEAN,
ADD COLUMN     "lead_score_adjustments" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "signal_icebreaker" TEXT,
ADD COLUMN     "signal_icebreaker_event_id" TEXT,
ADD COLUMN     "signal_icebreaker_generated_at" TIMESTAMP(3),
ADD COLUMN     "signal_icebreaker_skip_reason" TEXT,
ADD COLUMN     "validated_at" TIMESTAMP(3),
ADD COLUMN     "validation_score" INTEGER,
ADD COLUMN     "validation_source" TEXT,
ADD COLUMN     "validation_status" TEXT;

-- AlterTable
ALTER TABLE "LinkedInAccount" ADD COLUMN     "max_unipile_actions_per_day" INTEGER NOT NULL DEFAULT 80,
ADD COLUMN     "unipile_actions_today" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "LinkedInPost" ADD COLUMN     "article_title" TEXT,
ADD COLUMN     "post_kind" TEXT,
ADD COLUMN     "text" TEXT;

-- AlterTable
ALTER TABLE "LinkedInProfile" ADD COLUMN     "distinct_posts_engaged_30d" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "engagement_count_30d" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "engagement_score" DOUBLE PRECISION,
ADD COLUMN     "last_engaged_at" TIMESTAMP(3);

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
ALTER TABLE "Notification" ADD COLUMN     "action_url" TEXT,
ADD COLUMN     "entity_id" TEXT,
ADD COLUMN     "entity_type" TEXT;

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "cross_channel_suppression_mode" TEXT NOT NULL DEFAULT 'CLASSIFIED';

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "reset_token_expires_at" TIMESTAMP(3),
ADD COLUMN     "reset_token_hash" TEXT;

-- AlterTable
ALTER TABLE "WarmupPoolMembership" ADD COLUMN     "last_ramp_advanced_on" TIMESTAMP(3);

-- DropTable
DROP TABLE "PendingRegistration";

-- CreateTable
CREATE TABLE "SignalWatchlist" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'TOPICS',
    "keywords" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "icp_profile_id" TEXT,
    "excluded_profile_slugs" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "excluded_company_terms" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "min_reaction_count" INTEGER NOT NULL DEFAULT 20,
    "daily_signal_budget" INTEGER NOT NULL DEFAULT 50,
    "routing_mode" TEXT NOT NULL DEFAULT 'manual_review',
    "target_campaign_id" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "last_run_at" TIMESTAMP(3),
    "last_run_summary" JSONB,
    "next_run_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SignalWatchlist_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SignalWatchlistMatch" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "watchlist_id" TEXT NOT NULL,
    "matched_keyword" TEXT NOT NULL,
    "source_post_unipile_id" TEXT NOT NULL,
    "source_post_url" TEXT,
    "source_post_preview" TEXT,
    "engager_profile_id" TEXT NOT NULL,
    "engagement_type" TEXT NOT NULL,
    "reaction_type" TEXT,
    "comment_text" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending_review',
    "pushed_campaign_id" TEXT,
    "pushed_at" TIMESTAMP(3),
    "reviewed_by_user_id" TEXT,
    "reviewed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SignalWatchlistMatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentRunIcpMatch" (
    "agent_run_id" TEXT NOT NULL,
    "icp_profile_id" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "rationale" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentRunIcpMatch_pkey" PRIMARY KEY ("agent_run_id","icp_profile_id")
);

-- CreateIndex
CREATE INDEX "SignalWatchlist_organization_id_enabled_idx" ON "SignalWatchlist"("organization_id", "enabled");

-- CreateIndex
CREATE INDEX "SignalWatchlist_next_run_at_enabled_idx" ON "SignalWatchlist"("next_run_at", "enabled");

-- CreateIndex
CREATE INDEX "SignalWatchlistMatch_watchlist_id_status_created_at_idx" ON "SignalWatchlistMatch"("watchlist_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "SignalWatchlistMatch_organization_id_status_idx" ON "SignalWatchlistMatch"("organization_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "SignalWatchlistMatch_watchlist_id_source_post_unipile_id_en_key" ON "SignalWatchlistMatch"("watchlist_id", "source_post_unipile_id", "engager_profile_id");

-- CreateIndex
CREATE INDEX "AgentRunIcpMatch_icp_profile_id_idx" ON "AgentRunIcpMatch"("icp_profile_id");

-- CreateIndex
CREATE INDEX "Campaign_organization_id_deleted_at_idx" ON "Campaign"("organization_id", "deleted_at");

-- CreateIndex
CREATE INDEX "CampaignLead_campaign_id_status_next_send_at_idx" ON "CampaignLead"("campaign_id", "status", "next_send_at");

-- CreateIndex
CREATE INDEX "CampaignLinkedInSender_linkedin_account_id_idx" ON "CampaignLinkedInSender"("linkedin_account_id");

-- CreateIndex
CREATE INDEX "EmailMessage_thread_id_direction_sent_at_idx" ON "EmailMessage"("thread_id", "direction", "sent_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "EmailMessage_message_id_key" ON "EmailMessage"("message_id");

-- CreateIndex
CREATE INDEX "EmailThread_organization_id_campaign_id_status_idx" ON "EmailThread"("organization_id", "campaign_id", "status");

-- CreateIndex
CREATE INDEX "EmailThread_organization_id_last_message_at_idx" ON "EmailThread"("organization_id", "last_message_at" DESC);

-- CreateIndex
CREATE INDEX "IcpProfile_organization_id_deleted_at_idx" ON "IcpProfile"("organization_id", "deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "IcpProfile_organization_id_name_key" ON "IcpProfile"("organization_id", "name");

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
CREATE INDEX "LinkedInAccount_organization_id_connected_at_idx" ON "LinkedInAccount"("organization_id", "connected_at");

-- CreateIndex
CREATE INDEX "LinkedInProfile_organization_id_last_engaged_at_idx" ON "LinkedInProfile"("organization_id", "last_engaged_at");

-- CreateIndex
CREATE INDEX "Notification_entity_type_entity_id_idx" ON "Notification"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "RoutingRule_target_campaign_id_idx" ON "RoutingRule"("target_campaign_id");

-- CreateIndex
CREATE UNIQUE INDEX "User_reset_token_hash_key" ON "User"("reset_token_hash");

-- AddForeignKey
ALTER TABLE "Mailbox" ADD CONSTRAINT "Mailbox_domain_id_fkey" FOREIGN KEY ("domain_id") REFERENCES "Domain"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoutingRule" ADD CONSTRAINT "RoutingRule_target_campaign_id_fkey" FOREIGN KEY ("target_campaign_id") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SignalWatchlist" ADD CONSTRAINT "SignalWatchlist_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SignalWatchlistMatch" ADD CONSTRAINT "SignalWatchlistMatch_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SignalWatchlistMatch" ADD CONSTRAINT "SignalWatchlistMatch_watchlist_id_fkey" FOREIGN KEY ("watchlist_id") REFERENCES "SignalWatchlist"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRunIcpMatch" ADD CONSTRAINT "AgentRunIcpMatch_agent_run_id_fkey" FOREIGN KEY ("agent_run_id") REFERENCES "AgentRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRunIcpMatch" ADD CONSTRAINT "AgentRunIcpMatch_icp_profile_id_fkey" FOREIGN KEY ("icp_profile_id") REFERENCES "IcpProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "CampaignLinkedInSender_campaign_account_key" RENAME TO "CampaignLinkedInSender_campaign_id_linkedin_account_id_key";

-- RenameIndex
ALTER INDEX "CampaignSuppression_campaign_id_kind_suppressed_campaign_id_sup" RENAME TO "CampaignSuppression_campaign_id_kind_suppressed_campaign_id_key";

-- RenameIndex
ALTER INDEX "Customer_organization_id_company_linkedin_public_identifie_idx" RENAME TO "Customer_organization_id_company_linkedin_public_identifier_idx";

-- RenameIndex
ALTER INDEX "EngagementEvent_post_actor_event_reaction_key" RENAME TO "EngagementEvent_linkedin_post_id_actor_profile_id_event_typ_key";

