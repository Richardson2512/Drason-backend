-- Backfill the 4 in-progress-assessment columns that were declared in
-- prisma/schema.prisma but never had a corresponding migration. The
-- deployed Prisma client SELECTs them on every Organization read, so
-- without these columns every authenticated request that touches
-- Organization throws "column does not exist" — including login.
ALTER TABLE "Organization"
    ADD COLUMN IF NOT EXISTS "assessment_running"     BOOLEAN  NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS "assessment_started_at"  TIMESTAMP(3),
    ADD COLUMN IF NOT EXISTS "assessment_finished_at" TIMESTAMP(3),
    ADD COLUMN IF NOT EXISTS "assessment_last_error"  TEXT;
