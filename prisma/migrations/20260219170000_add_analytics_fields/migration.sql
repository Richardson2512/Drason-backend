-- AlterTable: Add analytics fields to Campaign model
ALTER TABLE "Campaign" ADD COLUMN "open_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Campaign" ADD COLUMN "click_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Campaign" ADD COLUMN "reply_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Campaign" ADD COLUMN "unsubscribed_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Campaign" ADD COLUMN "open_rate" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "Campaign" ADD COLUMN "click_rate" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "Campaign" ADD COLUMN "reply_rate" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "Campaign" ADD COLUMN "analytics_updated_at" TIMESTAMP(3);

-- AlterTable: Add analytics fields to Mailbox model
ALTER TABLE "Mailbox" ADD COLUMN "open_count_lifetime" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Mailbox" ADD COLUMN "click_count_lifetime" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Mailbox" ADD COLUMN "reply_count_lifetime" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Mailbox" ADD COLUMN "spam_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Mailbox" ADD COLUMN "engagement_rate" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "Mailbox" ADD COLUMN "warmup_reputation" TEXT;
ALTER TABLE "Mailbox" ADD COLUMN "warmup_status" TEXT;

-- AlterTable: Add analytics fields to Domain model
ALTER TABLE "Domain" ADD COLUMN "total_sent_lifetime" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Domain" ADD COLUMN "total_opens" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Domain" ADD COLUMN "total_clicks" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Domain" ADD COLUMN "total_replies" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Domain" ADD COLUMN "engagement_rate" DOUBLE PRECISION NOT NULL DEFAULT 0;
