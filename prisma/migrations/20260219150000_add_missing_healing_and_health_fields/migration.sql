-- Add missing health and healing fields to Lead table
ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "health_classification" TEXT NOT NULL DEFAULT 'green';
ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "health_score_calc" DOUBLE PRECISION NOT NULL DEFAULT 100;
ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "health_checked_at" TIMESTAMP(3);

-- Add missing healing and tracking fields to Mailbox table
ALTER TABLE "Mailbox" ADD COLUMN IF NOT EXISTS "recovery_phase" TEXT NOT NULL DEFAULT 'healthy';
ALTER TABLE "Mailbox" ADD COLUMN IF NOT EXISTS "healing_origin" TEXT;
ALTER TABLE "Mailbox" ADD COLUMN IF NOT EXISTS "phase_entered_at" TIMESTAMP(3);
ALTER TABLE "Mailbox" ADD COLUMN IF NOT EXISTS "clean_sends_since_phase" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Mailbox" ADD COLUMN IF NOT EXISTS "resilience_score" INTEGER NOT NULL DEFAULT 50;
ALTER TABLE "Mailbox" ADD COLUMN IF NOT EXISTS "relapse_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Mailbox" ADD COLUMN IF NOT EXISTS "trend_state" TEXT NOT NULL DEFAULT 'stable';
ALTER TABLE "Mailbox" ADD COLUMN IF NOT EXISTS "initial_bounce_rate" DOUBLE PRECISION;
ALTER TABLE "Mailbox" ADD COLUMN IF NOT EXISTS "initial_assessment_at" TIMESTAMP(3);

-- Add missing fields to Domain table
ALTER TABLE "Domain" ADD COLUMN IF NOT EXISTS "recovery_phase" TEXT NOT NULL DEFAULT 'healthy';
ALTER TABLE "Domain" ADD COLUMN IF NOT EXISTS "healing_origin" TEXT;
ALTER TABLE "Domain" ADD COLUMN IF NOT EXISTS "phase_entered_at" TIMESTAMP(3);
ALTER TABLE "Domain" ADD COLUMN IF NOT EXISTS "clean_sends_since_phase" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Domain" ADD COLUMN IF NOT EXISTS "resilience_score" INTEGER NOT NULL DEFAULT 50;
ALTER TABLE "Domain" ADD COLUMN IF NOT EXISTS "relapse_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Domain" ADD COLUMN IF NOT EXISTS "trend_state" TEXT NOT NULL DEFAULT 'stable';
ALTER TABLE "Domain" ADD COLUMN IF NOT EXISTS "provider_restrictions" JSONB;
ALTER TABLE "Domain" ADD COLUMN IF NOT EXISTS "warning_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Domain" ADD COLUMN IF NOT EXISTS "aggregated_bounce_rate_trend" DOUBLE PRECISION NOT NULL DEFAULT 0.0;
ALTER TABLE "Domain" ADD COLUMN IF NOT EXISTS "paused_reason" TEXT;
ALTER TABLE "Domain" ADD COLUMN IF NOT EXISTS "last_pause_at" TIMESTAMP(3);
ALTER TABLE "Domain" ADD COLUMN IF NOT EXISTS "cooldown_until" TIMESTAMP(3);
ALTER TABLE "Domain" ADD COLUMN IF NOT EXISTS "consecutive_pauses" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Domain" ADD COLUMN IF NOT EXISTS "spf_valid" BOOLEAN;
ALTER TABLE "Domain" ADD COLUMN IF NOT EXISTS "dkim_valid" BOOLEAN;
ALTER TABLE "Domain" ADD COLUMN IF NOT EXISTS "dmarc_policy" TEXT;
ALTER TABLE "Domain" ADD COLUMN IF NOT EXISTS "blacklist_results" JSONB;
ALTER TABLE "Domain" ADD COLUMN IF NOT EXISTS "dns_checked_at" TIMESTAMP(3);
ALTER TABLE "Domain" ADD COLUMN IF NOT EXISTS "initial_assessment_score" DOUBLE PRECISION;

-- Add missing fields to Campaign table
ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "paused_reason" TEXT;
ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "paused_at" TIMESTAMP(3);
ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "bounce_rate" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "warning_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "total_sent" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "total_bounced" INTEGER NOT NULL DEFAULT 0;

-- Add missing fields to Organization table (subscription/usage tracking)
ALTER TABLE "Organization" ADD COLUMN IF NOT EXISTS "current_lead_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Organization" ADD COLUMN IF NOT EXISTS "current_domain_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Organization" ADD COLUMN IF NOT EXISTS "current_mailbox_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Organization" ADD COLUMN IF NOT EXISTS "usage_last_updated_at" TIMESTAMP(3);
ALTER TABLE "Organization" ADD COLUMN IF NOT EXISTS "next_billing_date" TIMESTAMP(3);
ALTER TABLE "Organization" ADD COLUMN IF NOT EXISTS "subscription_started_at" TIMESTAMP(3);

-- Create indices for recovery_phase if they don't exist
CREATE INDEX IF NOT EXISTS "Mailbox_recovery_phase_idx" ON "Mailbox"("recovery_phase");
CREATE INDEX IF NOT EXISTS "Domain_recovery_phase_idx" ON "Domain"("recovery_phase");
