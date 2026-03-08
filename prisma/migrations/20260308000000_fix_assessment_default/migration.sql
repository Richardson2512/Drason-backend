-- Change default so new orgs don't show "assessment in progress" before first sync
ALTER TABLE "Organization" ALTER COLUMN "assessment_completed" SET DEFAULT true;

-- Fix any existing orgs that have no domains yet (never synced) but show assessment in progress
UPDATE "Organization" SET "assessment_completed" = true
WHERE "assessment_completed" = false
AND "id" NOT IN (SELECT DISTINCT "organization_id" FROM "Domain");
