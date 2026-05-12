-- CampaignSuppression — per-campaign lead suppression rules.
-- See schema.prisma for the kind discriminator semantics.

CREATE TABLE "CampaignSuppression" (
    "id"                     TEXT NOT NULL,
    "campaign_id"            TEXT NOT NULL,
    "kind"                   TEXT NOT NULL,
    "suppressed_campaign_id" TEXT,
    "suppressed_email"       TEXT,
    "created_at"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CampaignSuppression_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CampaignSuppression_campaign_id_idx"
    ON "CampaignSuppression"("campaign_id");
CREATE INDEX "CampaignSuppression_suppressed_campaign_id_idx"
    ON "CampaignSuppression"("suppressed_campaign_id");

-- Each (kind, suppressed_campaign_id, suppressed_email) tuple is unique
-- per campaign so the upsert path can rely on a single index for dedup.
CREATE UNIQUE INDEX "CampaignSuppression_campaign_id_kind_suppressed_campaign_id_suppressed_email_key"
    ON "CampaignSuppression"("campaign_id", "kind", "suppressed_campaign_id", "suppressed_email");

ALTER TABLE "CampaignSuppression"
    ADD CONSTRAINT "CampaignSuppression_campaign_id_fkey"
    FOREIGN KEY ("campaign_id") REFERENCES "Campaign"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CampaignSuppression"
    ADD CONSTRAINT "CampaignSuppression_suppressed_campaign_id_fkey"
    FOREIGN KEY ("suppressed_campaign_id") REFERENCES "Campaign"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
