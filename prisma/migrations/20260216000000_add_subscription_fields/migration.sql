-- Add subscription management fields to Organization table
ALTER TABLE "Organization" ADD COLUMN "subscription_tier" TEXT NOT NULL DEFAULT 'trial';
ALTER TABLE "Organization" ADD COLUMN "subscription_status" TEXT NOT NULL DEFAULT 'trialing';
ALTER TABLE "Organization" ADD COLUMN "polar_customer_id" TEXT;
ALTER TABLE "Organization" ADD COLUMN "polar_subscription_id" TEXT;
ALTER TABLE "Organization" ADD COLUMN "trial_started_at" TIMESTAMP(3);
ALTER TABLE "Organization" ADD COLUMN "trial_ends_at" TIMESTAMP(3);
ALTER TABLE "Organization" ADD COLUMN "subscription_started_at" TIMESTAMP(3);
ALTER TABLE "Organization" ADD COLUMN "next_billing_date" TIMESTAMP(3);

-- Add usage tracking fields to Organization table
ALTER TABLE "Organization" ADD COLUMN "current_lead_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Organization" ADD COLUMN "current_domain_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Organization" ADD COLUMN "current_mailbox_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Organization" ADD COLUMN "usage_last_updated_at" TIMESTAMP(3);

-- Create unique constraints for Polar IDs
CREATE UNIQUE INDEX "Organization_polar_customer_id_key" ON "Organization"("polar_customer_id");
CREATE UNIQUE INDEX "Organization_polar_subscription_id_key" ON "Organization"("polar_subscription_id");

-- Create indexes for subscription management
CREATE INDEX "Organization_subscription_status_idx" ON "Organization"("subscription_status");
CREATE INDEX "Organization_trial_ends_at_idx" ON "Organization"("trial_ends_at");

-- CreateTable
CREATE TABLE "SubscriptionEvent" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "polar_event_id" TEXT,
    "previous_tier" TEXT,
    "new_tier" TEXT,
    "payload" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SubscriptionEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SubscriptionEvent_polar_event_id_key" ON "SubscriptionEvent"("polar_event_id");

-- CreateIndex
CREATE INDEX "SubscriptionEvent_organization_id_created_at_idx" ON "SubscriptionEvent"("organization_id", "created_at");

-- CreateIndex
CREATE INDEX "SubscriptionEvent_event_type_idx" ON "SubscriptionEvent"("event_type");

-- CreateIndex
CREATE INDEX "SubscriptionEvent_polar_event_id_idx" ON "SubscriptionEvent"("polar_event_id");

-- AddForeignKey
ALTER TABLE "SubscriptionEvent" ADD CONSTRAINT "SubscriptionEvent_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
