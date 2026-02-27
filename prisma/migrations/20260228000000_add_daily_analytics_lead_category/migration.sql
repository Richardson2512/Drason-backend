-- AlterTable: Add lead_category and cross_campaign_count to Lead
ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "lead_category" TEXT;
ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "cross_campaign_count" INTEGER NOT NULL DEFAULT 0;

-- CreateTable: CampaignDailyAnalytics for date-bucketed analytics from Smartlead
CREATE TABLE IF NOT EXISTS "CampaignDailyAnalytics" (
    "id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "sent_count" INTEGER NOT NULL DEFAULT 0,
    "open_count" INTEGER NOT NULL DEFAULT 0,
    "click_count" INTEGER NOT NULL DEFAULT 0,
    "reply_count" INTEGER NOT NULL DEFAULT 0,
    "bounce_count" INTEGER NOT NULL DEFAULT 0,
    "unsubscribe_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CampaignDailyAnalytics_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "CampaignDailyAnalytics_campaign_id_date_key" ON "CampaignDailyAnalytics"("campaign_id", "date");
CREATE INDEX IF NOT EXISTS "CampaignDailyAnalytics_organization_id_date_idx" ON "CampaignDailyAnalytics"("organization_id", "date");
CREATE INDEX IF NOT EXISTS "CampaignDailyAnalytics_campaign_id_date_idx" ON "CampaignDailyAnalytics"("campaign_id", "date");

-- AddForeignKey
ALTER TABLE "CampaignDailyAnalytics" ADD CONSTRAINT "CampaignDailyAnalytics_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CampaignDailyAnalytics" ADD CONSTRAINT "CampaignDailyAnalytics_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
