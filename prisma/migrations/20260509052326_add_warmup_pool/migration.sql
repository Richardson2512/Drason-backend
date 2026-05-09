-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "warmup_pool_consent" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "warmup_pool_consent_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "WarmupPoolMembership" (
    "id" TEXT NOT NULL,
    "mailbox_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "receive_enabled" BOOLEAN NOT NULL DEFAULT true,
    "start_daily" INTEGER NOT NULL DEFAULT 5,
    "target_daily" INTEGER NOT NULL DEFAULT 50,
    "ramp_days" INTEGER NOT NULL DEFAULT 21,
    "current_daily" INTEGER NOT NULL DEFAULT 5,
    "ramp_step" INTEGER NOT NULL DEFAULT 0,
    "maintenance_daily" INTEGER NOT NULL DEFAULT 10,
    "total_sent" INTEGER NOT NULL DEFAULT 0,
    "total_received" INTEGER NOT NULL DEFAULT 0,
    "total_opened" INTEGER NOT NULL DEFAULT 0,
    "total_replied" INTEGER NOT NULL DEFAULT 0,
    "total_recovered_from_spam" INTEGER NOT NULL DEFAULT 0,
    "spam_rate_30d" DOUBLE PRECISION,
    "health" TEXT NOT NULL DEFAULT 'warming',
    "last_error" TEXT,
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "WarmupPoolMembership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WarmupTemplate" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "spintax" TEXT NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'en',
    "weight" INTEGER NOT NULL DEFAULT 1,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "tag" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "WarmupTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WarmupExchange" (
    "id" TEXT NOT NULL,
    "sender_mailbox_id" TEXT NOT NULL,
    "sender_membership_id" TEXT NOT NULL,
    "recipient_mailbox_id" TEXT NOT NULL,
    "recipient_membership_id" TEXT NOT NULL,
    "message_id" TEXT,
    "subject" TEXT NOT NULL,
    "body_preview" TEXT NOT NULL,
    "thread_id" TEXT NOT NULL,
    "thread_depth" INTEGER NOT NULL DEFAULT 0,
    "state" TEXT NOT NULL DEFAULT 'scheduled',
    "scheduled_at" TIMESTAMP(3) NOT NULL,
    "sent_at" TIMESTAMP(3),
    "delivered_at" TIMESTAMP(3),
    "opened_at" TIMESTAMP(3),
    "replied_at" TIMESTAMP(3),
    "recovered_at" TIMESTAMP(3),
    "landed_in" TEXT,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WarmupExchange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WarmupPoolMembership_mailbox_id_key" ON "WarmupPoolMembership"("mailbox_id");
CREATE INDEX "WarmupPoolMembership_organization_id_idx" ON "WarmupPoolMembership"("organization_id");
CREATE INDEX "WarmupPoolMembership_health_idx" ON "WarmupPoolMembership"("health");
CREATE INDEX "WarmupPoolMembership_enabled_receive_enabled_idx" ON "WarmupPoolMembership"("enabled", "receive_enabled");
CREATE INDEX "WarmupTemplate_kind_active_idx" ON "WarmupTemplate"("kind", "active");
CREATE INDEX "WarmupTemplate_language_kind_idx" ON "WarmupTemplate"("language", "kind");
CREATE INDEX "WarmupExchange_sender_mailbox_id_idx" ON "WarmupExchange"("sender_mailbox_id");
CREATE INDEX "WarmupExchange_recipient_mailbox_id_idx" ON "WarmupExchange"("recipient_mailbox_id");
CREATE INDEX "WarmupExchange_thread_id_idx" ON "WarmupExchange"("thread_id");
CREATE INDEX "WarmupExchange_state_scheduled_at_idx" ON "WarmupExchange"("state", "scheduled_at");

-- AddForeignKey
ALTER TABLE "WarmupPoolMembership" ADD CONSTRAINT "WarmupPoolMembership_mailbox_id_fkey" FOREIGN KEY ("mailbox_id") REFERENCES "Mailbox"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WarmupPoolMembership" ADD CONSTRAINT "WarmupPoolMembership_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
