-- Lead Control Plane: Validation Batches, ESP Classification, Send/Reply Tracking

-- Add ESP bucket cache to DomainInsight
ALTER TABLE "DomainInsight" ADD COLUMN IF NOT EXISTS "esp_bucket" TEXT;

-- ValidationBatch: represents one upload/import session
CREATE TABLE IF NOT EXISTS "ValidationBatch" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'processing',
    "file_name" TEXT,
    "total_count" INTEGER NOT NULL DEFAULT 0,
    "valid_count" INTEGER NOT NULL DEFAULT 0,
    "invalid_count" INTEGER NOT NULL DEFAULT 0,
    "risky_count" INTEGER NOT NULL DEFAULT 0,
    "duplicate_count" INTEGER NOT NULL DEFAULT 0,
    "routed_count" INTEGER NOT NULL DEFAULT 0,
    "target_campaign_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "ValidationBatch_pkey" PRIMARY KEY ("id")
);

-- ValidationBatchLead: each lead within a batch
CREATE TABLE IF NOT EXISTS "ValidationBatchLead" (
    "id" TEXT NOT NULL,
    "batch_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "first_name" TEXT,
    "last_name" TEXT,
    "company" TEXT,
    "persona" TEXT,
    "lead_score" INTEGER,
    "validation_status" TEXT NOT NULL DEFAULT 'pending',
    "validation_score" INTEGER,
    "rejection_reason" TEXT,
    "is_disposable" BOOLEAN,
    "is_catch_all" BOOLEAN,
    "esp_bucket" TEXT,
    "routed_to_campaign_id" TEXT,
    "routed_at" TIMESTAMP(3),
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ValidationBatchLead_pkey" PRIMARY KEY ("id")
);

-- SendEvent: tracks every email sent for ESP performance scoring
CREATE TABLE IF NOT EXISTS "SendEvent" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "mailbox_id" TEXT NOT NULL,
    "campaign_id" TEXT,
    "recipient_email" TEXT NOT NULL,
    "recipient_esp" TEXT,
    "sent_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SendEvent_pkey" PRIMARY KEY ("id")
);

-- ReplyEvent: tracks replies for ESP performance scoring
CREATE TABLE IF NOT EXISTS "ReplyEvent" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "mailbox_id" TEXT NOT NULL,
    "campaign_id" TEXT,
    "recipient_email" TEXT NOT NULL,
    "recipient_esp" TEXT,
    "replied_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReplyEvent_pkey" PRIMARY KEY ("id")
);

-- MailboxEspPerformance: rolling 30-day aggregates per mailbox × ESP
CREATE TABLE IF NOT EXISTS "MailboxEspPerformance" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "mailbox_id" TEXT NOT NULL,
    "esp_bucket" TEXT NOT NULL,
    "send_count_30d" INTEGER NOT NULL DEFAULT 0,
    "bounce_count_30d" INTEGER NOT NULL DEFAULT 0,
    "reply_count_30d" INTEGER NOT NULL DEFAULT 0,
    "bounce_rate_30d" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "last_updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MailboxEspPerformance_pkey" PRIMARY KEY ("id")
);

-- Foreign keys
ALTER TABLE "ValidationBatch" ADD CONSTRAINT "ValidationBatch_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ValidationBatchLead" ADD CONSTRAINT "ValidationBatchLead_batch_id_fkey"
    FOREIGN KEY ("batch_id") REFERENCES "ValidationBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Indexes: ValidationBatch
CREATE INDEX IF NOT EXISTS "ValidationBatch_organization_id_created_at_idx" ON "ValidationBatch"("organization_id", "created_at");
CREATE INDEX IF NOT EXISTS "ValidationBatch_organization_id_status_idx" ON "ValidationBatch"("organization_id", "status");

-- Indexes: ValidationBatchLead
CREATE INDEX IF NOT EXISTS "ValidationBatchLead_batch_id_validation_status_idx" ON "ValidationBatchLead"("batch_id", "validation_status");
CREATE INDEX IF NOT EXISTS "ValidationBatchLead_batch_id_esp_bucket_idx" ON "ValidationBatchLead"("batch_id", "esp_bucket");

-- Indexes: SendEvent
CREATE INDEX IF NOT EXISTS "SendEvent_organization_id_sent_at_idx" ON "SendEvent"("organization_id", "sent_at");
CREATE INDEX IF NOT EXISTS "SendEvent_mailbox_id_recipient_esp_idx" ON "SendEvent"("mailbox_id", "recipient_esp");
CREATE INDEX IF NOT EXISTS "SendEvent_mailbox_id_sent_at_idx" ON "SendEvent"("mailbox_id", "sent_at");

-- Indexes: ReplyEvent
CREATE INDEX IF NOT EXISTS "ReplyEvent_organization_id_replied_at_idx" ON "ReplyEvent"("organization_id", "replied_at");
CREATE INDEX IF NOT EXISTS "ReplyEvent_mailbox_id_recipient_esp_idx" ON "ReplyEvent"("mailbox_id", "recipient_esp");
CREATE INDEX IF NOT EXISTS "ReplyEvent_mailbox_id_replied_at_idx" ON "ReplyEvent"("mailbox_id", "replied_at");

-- Indexes: MailboxEspPerformance
CREATE UNIQUE INDEX IF NOT EXISTS "MailboxEspPerformance_mailbox_id_esp_bucket_key" ON "MailboxEspPerformance"("mailbox_id", "esp_bucket");
CREATE INDEX IF NOT EXISTS "MailboxEspPerformance_organization_id_mailbox_id_idx" ON "MailboxEspPerformance"("organization_id", "mailbox_id");
CREATE INDEX IF NOT EXISTS "MailboxEspPerformance_mailbox_id_bounce_rate_30d_idx" ON "MailboxEspPerformance"("mailbox_id", "bounce_rate_30d");
