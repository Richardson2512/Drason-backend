-- Phase 5 — LinkedIn-side campaign sender association.
--
-- The existing CampaignAccount join is email-only (mailbox / domain). LinkedIn
-- campaigns rotate a separate pool of LinkedInAccount senders with per-
-- account-per-campaign working hours (HeyReach: same account can have
-- different schedules in different campaigns).
--
-- This migration adds a parallel join table for LinkedIn. Kept separate
-- from CampaignAccount intentionally — the email and LinkedIn rotation
-- algorithms have different capacity semantics (mailbox warmup curve vs
-- LinkedIn weekly cap).

CREATE TABLE "CampaignLinkedInSender" (
    "id"                    TEXT NOT NULL,
    "campaign_id"           TEXT NOT NULL,
    "linkedin_account_id"   TEXT NOT NULL,
    -- Per-campaign overrides of the account's default caps. NULL = use
    -- the account default (LinkedInAccount.max_*_per_day/week). The
    -- dispatcher reads these on every dispatch decision.
    "max_invites_per_day"   INTEGER,
    "max_messages_per_day"  INTEGER,
    "max_inmails_per_day"   INTEGER,
    -- Working hours window for THIS account on THIS campaign. JSON
    -- shape: { tz: "America/New_York", days: [1..7], start: "09:00", end: "18:00" }.
    -- NULL = sender follows the account-level default (Phase 5.1 will
    -- add a per-account default when we ship the working-hours UI).
    "working_hours"         JSONB,
    -- Rotation order — lower index = higher priority. Same-priority
    -- senders are tie-broken by remaining-capacity.
    "rotation_priority"     INTEGER NOT NULL DEFAULT 0,
    "enabled"               BOOLEAN NOT NULL DEFAULT true,
    "created_at"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"            TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CampaignLinkedInSender_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CampaignLinkedInSender_campaign_account_key"
    ON "CampaignLinkedInSender"("campaign_id", "linkedin_account_id");

CREATE INDEX "CampaignLinkedInSender_campaign_id_enabled_idx"
    ON "CampaignLinkedInSender"("campaign_id", "enabled");

ALTER TABLE "CampaignLinkedInSender"
    ADD CONSTRAINT "CampaignLinkedInSender_campaign_id_fkey"
    FOREIGN KEY ("campaign_id") REFERENCES "Campaign"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CampaignLinkedInSender"
    ADD CONSTRAINT "CampaignLinkedInSender_linkedin_account_id_fkey"
    FOREIGN KEY ("linkedin_account_id") REFERENCES "LinkedInAccount"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
