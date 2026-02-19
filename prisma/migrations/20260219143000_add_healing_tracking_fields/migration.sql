-- Add healing tracking fields to Mailbox table
ALTER TABLE "Mailbox" ADD COLUMN IF NOT EXISTS "phase_clean_sends" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Mailbox" ADD COLUMN IF NOT EXISTS "phase_bounces" INTEGER NOT NULL DEFAULT 0;

-- Add healing tracking fields to Domain table
ALTER TABLE "Domain" ADD COLUMN IF NOT EXISTS "phase_clean_sends" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Domain" ADD COLUMN IF NOT EXISTS "phase_bounces" INTEGER NOT NULL DEFAULT 0;
