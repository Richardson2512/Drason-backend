-- Add Clay webhook secret field for webhook validation
ALTER TABLE "Organization" ADD COLUMN IF NOT EXISTS "clay_webhook_secret" TEXT;
