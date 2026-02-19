-- Add Smartlead email account ID to Mailbox for warmup API calls
ALTER TABLE "Mailbox" ADD COLUMN "smartlead_email_account_id" INTEGER;

-- Remove healing campaign fields from Campaign table (no longer using healing campaigns)
ALTER TABLE "Campaign" DROP COLUMN IF EXISTS "is_healing_campaign";
ALTER TABLE "Campaign" DROP COLUMN IF EXISTS "healing_mailbox_id";
ALTER TABLE "Campaign" DROP COLUMN IF EXISTS "healing_phase";
ALTER TABLE "Campaign" DROP COLUMN IF EXISTS "completed_at";
