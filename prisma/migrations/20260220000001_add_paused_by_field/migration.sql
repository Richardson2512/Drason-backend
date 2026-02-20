-- Add paused_by field to Campaign model
ALTER TABLE "Campaign" ADD COLUMN "paused_by" TEXT DEFAULT 'system';

-- Add paused_by field to Domain model
ALTER TABLE "Domain" ADD COLUMN "paused_by" TEXT DEFAULT 'system';
