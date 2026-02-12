-- CreateTable
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "system_mode" TEXT NOT NULL DEFAULT 'observe',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "name" TEXT,
    "role" TEXT NOT NULL DEFAULT 'viewer',
    "organization_id" TEXT NOT NULL,
    "last_login_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiKey" (
    "id" TEXT NOT NULL,
    "key_hash" TEXT NOT NULL,
    "key_prefix" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "scopes" TEXT[],
    "organization_id" TEXT NOT NULL,
    "last_used_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Lead" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "persona" TEXT NOT NULL,
    "lead_score" INTEGER NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'clay',
    "status" TEXT NOT NULL DEFAULT 'held',
    "health_state" TEXT NOT NULL DEFAULT 'healthy',
    "assigned_campaign_id" TEXT,
    "organization_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "Lead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Campaign" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'email',
    "status" TEXT NOT NULL DEFAULT 'active',
    "organization_id" TEXT NOT NULL,
    "last_synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Mailbox" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'healthy',
    "hard_bounce_count" INTEGER NOT NULL DEFAULT 0,
    "delivery_failure_count" INTEGER NOT NULL DEFAULT 0,
    "total_sent_count" INTEGER NOT NULL DEFAULT 0,
    "window_sent_count" INTEGER NOT NULL DEFAULT 0,
    "window_bounce_count" INTEGER NOT NULL DEFAULT 0,
    "window_start_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_pause_at" TIMESTAMP(3),
    "cooldown_until" TIMESTAMP(3),
    "consecutive_pauses" INTEGER NOT NULL DEFAULT 0,
    "last_activity_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "domain_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Mailbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Domain" (
    "id" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'healthy',
    "warning_count" INTEGER NOT NULL DEFAULT 0,
    "aggregated_bounce_rate_trend" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "paused_reason" TEXT,
    "last_pause_at" TIMESTAMP(3),
    "cooldown_until" TIMESTAMP(3),
    "consecutive_pauses" INTEGER NOT NULL DEFAULT 0,
    "organization_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Domain_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoutingRule" (
    "id" TEXT NOT NULL,
    "persona" TEXT NOT NULL,
    "min_score" INTEGER NOT NULL DEFAULT 0,
    "target_campaign_id" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "organization_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RoutingRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RawEvent" (
    "id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT,
    "payload" JSONB NOT NULL,
    "idempotency_key" TEXT,
    "processed" BOOLEAN NOT NULL DEFAULT false,
    "processed_at" TIMESTAMP(3),
    "error_message" TEXT,
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "organization_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RawEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StateTransition" (
    "id" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "from_state" TEXT NOT NULL,
    "to_state" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "triggered_by" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StateTransition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MailboxMetrics" (
    "id" TEXT NOT NULL,
    "mailbox_id" TEXT NOT NULL,
    "window_1h_sent" INTEGER NOT NULL DEFAULT 0,
    "window_1h_bounce" INTEGER NOT NULL DEFAULT 0,
    "window_1h_failure" INTEGER NOT NULL DEFAULT 0,
    "window_1h_start" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "window_24h_sent" INTEGER NOT NULL DEFAULT 0,
    "window_24h_bounce" INTEGER NOT NULL DEFAULT 0,
    "window_24h_failure" INTEGER NOT NULL DEFAULT 0,
    "window_24h_start" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "window_7d_sent" INTEGER NOT NULL DEFAULT 0,
    "window_7d_bounce" INTEGER NOT NULL DEFAULT 0,
    "window_7d_failure" INTEGER NOT NULL DEFAULT 0,
    "window_7d_start" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "risk_score" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "velocity" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MailboxMetrics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entity_id" TEXT,
    "trigger" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "details" TEXT,
    "correlation_id" TEXT,
    "user_id" TEXT,
    "ip_address" TEXT,
    "organization_id" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrganizationSetting" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "is_secret" BOOLEAN NOT NULL DEFAULT false,
    "organization_id" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganizationSetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemSetting" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,

    CONSTRAINT "SystemSetting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "_CampaignToMailbox" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "Organization_slug_key" ON "Organization"("slug");

-- CreateIndex
CREATE INDEX "Organization_slug_idx" ON "Organization"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_organization_id_idx" ON "User"("organization_id");

-- CreateIndex
CREATE INDEX "User_email_idx" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "ApiKey_key_hash_key" ON "ApiKey"("key_hash");

-- CreateIndex
CREATE INDEX "ApiKey_organization_id_idx" ON "ApiKey"("organization_id");

-- CreateIndex
CREATE INDEX "ApiKey_key_hash_idx" ON "ApiKey"("key_hash");

-- CreateIndex
CREATE INDEX "Lead_organization_id_status_idx" ON "Lead"("organization_id", "status");

-- CreateIndex
CREATE INDEX "Lead_organization_id_assigned_campaign_id_idx" ON "Lead"("organization_id", "assigned_campaign_id");

-- CreateIndex
CREATE INDEX "Lead_status_idx" ON "Lead"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Lead_organization_id_email_key" ON "Lead"("organization_id", "email");

-- CreateIndex
CREATE INDEX "Campaign_organization_id_status_idx" ON "Campaign"("organization_id", "status");

-- CreateIndex
CREATE INDEX "Campaign_organization_id_idx" ON "Campaign"("organization_id");

-- CreateIndex
CREATE INDEX "Mailbox_organization_id_status_idx" ON "Mailbox"("organization_id", "status");

-- CreateIndex
CREATE INDEX "Mailbox_organization_id_domain_id_idx" ON "Mailbox"("organization_id", "domain_id");

-- CreateIndex
CREATE INDEX "Mailbox_domain_id_idx" ON "Mailbox"("domain_id");

-- CreateIndex
CREATE INDEX "Domain_organization_id_status_idx" ON "Domain"("organization_id", "status");

-- CreateIndex
CREATE INDEX "Domain_organization_id_idx" ON "Domain"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "Domain_organization_id_domain_key" ON "Domain"("organization_id", "domain");

-- CreateIndex
CREATE INDEX "RoutingRule_organization_id_priority_idx" ON "RoutingRule"("organization_id", "priority");

-- CreateIndex
CREATE INDEX "RoutingRule_organization_id_idx" ON "RoutingRule"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "RawEvent_idempotency_key_key" ON "RawEvent"("idempotency_key");

-- CreateIndex
CREATE INDEX "RawEvent_organization_id_event_type_idx" ON "RawEvent"("organization_id", "event_type");

-- CreateIndex
CREATE INDEX "RawEvent_organization_id_entity_type_entity_id_idx" ON "RawEvent"("organization_id", "entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "RawEvent_processed_created_at_idx" ON "RawEvent"("processed", "created_at");

-- CreateIndex
CREATE INDEX "RawEvent_idempotency_key_idx" ON "RawEvent"("idempotency_key");

-- CreateIndex
CREATE INDEX "StateTransition_organization_id_entity_type_entity_id_idx" ON "StateTransition"("organization_id", "entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "StateTransition_entity_type_entity_id_created_at_idx" ON "StateTransition"("entity_type", "entity_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "MailboxMetrics_mailbox_id_key" ON "MailboxMetrics"("mailbox_id");

-- CreateIndex
CREATE INDEX "MailboxMetrics_mailbox_id_idx" ON "MailboxMetrics"("mailbox_id");

-- CreateIndex
CREATE INDEX "AuditLog_organization_id_entity_entity_id_idx" ON "AuditLog"("organization_id", "entity", "entity_id");

-- CreateIndex
CREATE INDEX "AuditLog_organization_id_timestamp_idx" ON "AuditLog"("organization_id", "timestamp");

-- CreateIndex
CREATE INDEX "AuditLog_correlation_id_idx" ON "AuditLog"("correlation_id");

-- CreateIndex
CREATE INDEX "OrganizationSetting_organization_id_idx" ON "OrganizationSetting"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationSetting_organization_id_key_key" ON "OrganizationSetting"("organization_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "_CampaignToMailbox_AB_unique" ON "_CampaignToMailbox"("A", "B");

-- CreateIndex
CREATE INDEX "_CampaignToMailbox_B_index" ON "_CampaignToMailbox"("B");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Mailbox" ADD CONSTRAINT "Mailbox_domain_id_fkey" FOREIGN KEY ("domain_id") REFERENCES "Domain"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Mailbox" ADD CONSTRAINT "Mailbox_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Domain" ADD CONSTRAINT "Domain_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoutingRule" ADD CONSTRAINT "RoutingRule_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RawEvent" ADD CONSTRAINT "RawEvent_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StateTransition" ADD CONSTRAINT "StateTransition_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailboxMetrics" ADD CONSTRAINT "MailboxMetrics_mailbox_id_fkey" FOREIGN KEY ("mailbox_id") REFERENCES "Mailbox"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationSetting" ADD CONSTRAINT "OrganizationSetting_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_CampaignToMailbox" ADD CONSTRAINT "_CampaignToMailbox_A_fkey" FOREIGN KEY ("A") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_CampaignToMailbox" ADD CONSTRAINT "_CampaignToMailbox_B_fkey" FOREIGN KEY ("B") REFERENCES "Mailbox"("id") ON DELETE CASCADE ON UPDATE CASCADE;
