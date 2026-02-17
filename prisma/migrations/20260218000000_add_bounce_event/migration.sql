-- Create BounceEvent table for detailed bounce analytics
CREATE TABLE "BounceEvent" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "lead_id" TEXT,
    "mailbox_id" TEXT,
    "campaign_id" TEXT,
    "bounce_type" TEXT NOT NULL,
    "bounce_reason" TEXT,
    "email_address" TEXT NOT NULL,
    "sent_at" TIMESTAMP(3),
    "bounced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "raw_event_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BounceEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BounceEvent_organization_id_created_at_idx" ON "BounceEvent"("organization_id", "created_at");

-- CreateIndex
CREATE INDEX "BounceEvent_lead_id_idx" ON "BounceEvent"("lead_id");

-- CreateIndex
CREATE INDEX "BounceEvent_mailbox_id_idx" ON "BounceEvent"("mailbox_id");

-- CreateIndex
CREATE INDEX "BounceEvent_campaign_id_idx" ON "BounceEvent"("campaign_id");

-- CreateIndex
CREATE INDEX "BounceEvent_bounce_type_idx" ON "BounceEvent"("bounce_type");
