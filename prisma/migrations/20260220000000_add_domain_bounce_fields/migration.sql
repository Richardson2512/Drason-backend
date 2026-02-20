-- Add missing bounce analytics fields to Domain model
ALTER TABLE "Domain" ADD COLUMN "total_bounces" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Domain" ADD COLUMN "bounce_rate" DOUBLE PRECISION NOT NULL DEFAULT 0;
