-- Add activity tracking fields to Lead table for Smartlead webhook enrichment
ALTER TABLE "Lead" ADD COLUMN "emails_sent" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Lead" ADD COLUMN "emails_opened" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Lead" ADD COLUMN "emails_clicked" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Lead" ADD COLUMN "emails_replied" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Lead" ADD COLUMN "last_activity_at" TIMESTAMP(3);
