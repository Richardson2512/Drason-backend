-- AlterEnum
ALTER TYPE "SourcePlatform" ADD VALUE 'sequencer';

-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "daily_limit" INTEGER,
ADD COLUMN     "esp_routing" BOOLEAN,
ADD COLUMN     "include_unsubscribe" BOOLEAN,
ADD COLUMN     "launched_at" TIMESTAMP(3),
ADD COLUMN     "schedule_days" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "schedule_end_time" TEXT,
ADD COLUMN     "schedule_start_time" TEXT,
ADD COLUMN     "schedule_timezone" TEXT,
ADD COLUMN     "send_gap_minutes" INTEGER,
ADD COLUMN     "start_date" TIMESTAMP(3),
ADD COLUMN     "stop_on_bounce" BOOLEAN,
ADD COLUMN     "stop_on_reply" BOOLEAN,
ADD COLUMN     "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "total_leads" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "track_clicks" BOOLEAN,
ADD COLUMN     "track_opens" BOOLEAN,
ADD COLUMN     "tracking_domain" TEXT;

-- AlterTable
ALTER TABLE "Domain" ADD COLUMN     "mx_records" JSONB,
ADD COLUMN     "mx_valid" BOOLEAN;

-- AlterTable
ALTER TABLE "Lead" ADD COLUMN     "company" TEXT,
ADD COLUMN     "first_name" TEXT,
ADD COLUMN     "full_name" TEXT,
ADD COLUMN     "last_name" TEXT,
ADD COLUMN     "linkedin_url" TEXT,
ADD COLUMN     "phone" TEXT,
ADD COLUMN     "title" TEXT,
ADD COLUMN     "website" TEXT;

-- AlterTable
ALTER TABLE "Mailbox" ADD COLUMN     "connected_account_id" TEXT,
ADD COLUMN     "ip_blacklist_results" JSONB,
ADD COLUMN     "ip_blacklist_score" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "last_ip_blacklist_check" TIMESTAMP(3),
ADD COLUMN     "sending_ip" TEXT,
ADD COLUMN     "sending_ip_resolved_at" TIMESTAMP(3),
ADD COLUMN     "sending_ip_source" TEXT;

-- CreateTable
CREATE TABLE "CampaignLeadImport" (
    "id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "source_file" TEXT,
    "source_label" TEXT,
    "total_submitted" INTEGER NOT NULL DEFAULT 0,
    "added_count" INTEGER NOT NULL DEFAULT 0,
    "blocked_count" INTEGER NOT NULL DEFAULT 0,
    "duplicate_count" INTEGER NOT NULL DEFAULT 0,
    "created_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CampaignLeadImport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEndpoint" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "events" TEXT[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "internal" BOOLEAN NOT NULL DEFAULT false,
    "provider" TEXT NOT NULL DEFAULT 'generic',
    "failure_count" INTEGER NOT NULL DEFAULT 0,
    "disabled_at" TIMESTAMP(3),
    "disabled_reason" TEXT,
    "last_delivery_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebhookEndpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookDelivery" (
    "id" TEXT NOT NULL,
    "endpoint_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3),
    "response_code" INTEGER,
    "response_body" TEXT,
    "request_headers" JSONB,
    "duration_ms" INTEGER,
    "delivered_at" TIMESTAMP(3),
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BusinessProfile" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "source_url" TEXT NOT NULL,
    "profile_json" JSONB NOT NULL,
    "scraped_chars" INTEGER NOT NULL DEFAULT 0,
    "model_used" TEXT NOT NULL,
    "prompt_tokens" INTEGER NOT NULL DEFAULT 0,
    "completion_tokens" INTEGER NOT NULL DEFAULT 0,
    "extracted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BusinessProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConnectedAccount" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "display_name" TEXT,
    "provider" TEXT NOT NULL,
    "access_token" TEXT,
    "refresh_token" TEXT,
    "token_expires_at" TIMESTAMP(3),
    "smtp_host" TEXT,
    "smtp_port" INTEGER,
    "smtp_username" TEXT,
    "smtp_password" TEXT,
    "imap_host" TEXT,
    "imap_port" INTEGER,
    "connection_status" TEXT NOT NULL DEFAULT 'active',
    "last_error" TEXT,
    "daily_send_limit" INTEGER NOT NULL DEFAULT 50,
    "sends_today" INTEGER NOT NULL DEFAULT 0,
    "sends_reset_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "warmup_complete" BOOLEAN NOT NULL DEFAULT false,
    "signature_html" TEXT,
    "tracking_domain" TEXT,
    "tracking_domain_verified" BOOLEAN NOT NULL DEFAULT false,
    "tracking_domain_verified_at" TIMESTAMP(3),
    "tracking_domain_last_check_at" TIMESTAMP(3),
    "tracking_domain_last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConnectedAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignAccount" (
    "id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "daily_limit_override" INTEGER,

    CONSTRAINT "CampaignAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SequenceStep" (
    "id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "step_number" INTEGER NOT NULL,
    "delay_days" INTEGER NOT NULL DEFAULT 1,
    "delay_hours" INTEGER NOT NULL DEFAULT 0,
    "subject" TEXT NOT NULL DEFAULT '',
    "body_html" TEXT NOT NULL DEFAULT '',
    "body_text" TEXT,
    "condition" TEXT,
    "branch_to_step_number" INTEGER,

    CONSTRAINT "SequenceStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StepVariant" (
    "id" TEXT NOT NULL,
    "step_id" TEXT NOT NULL,
    "variant_label" TEXT NOT NULL DEFAULT 'A',
    "subject" TEXT NOT NULL,
    "body_html" TEXT NOT NULL,
    "body_text" TEXT,
    "weight" INTEGER NOT NULL DEFAULT 50,
    "sends" INTEGER NOT NULL DEFAULT 0,
    "opens" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "replies" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "StepVariant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignLead" (
    "id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "first_name" TEXT,
    "last_name" TEXT,
    "company" TEXT,
    "title" TEXT,
    "custom_variables" JSONB,
    "status" TEXT NOT NULL DEFAULT 'active',
    "current_step" INTEGER NOT NULL DEFAULT 0,
    "esp_bucket" TEXT,
    "validation_status" TEXT,
    "validation_score" INTEGER,
    "last_sent_at" TIMESTAMP(3),
    "next_send_at" TIMESTAMP(3),
    "opened_count" INTEGER NOT NULL DEFAULT 0,
    "clicked_count" INTEGER NOT NULL DEFAULT 0,
    "replied_at" TIMESTAMP(3),
    "bounced_at" TIMESTAMP(3),
    "unsubscribed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "import_id" TEXT,
    "assigned_account_id" TEXT,

    CONSTRAINT "CampaignLead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignAccountUsage" (
    "id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "sends_today" INTEGER NOT NULL DEFAULT 0,
    "sends_reset_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CampaignAccountUsage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailTemplate" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body_html" TEXT NOT NULL,
    "body_text" TEXT,
    "category" TEXT NOT NULL DEFAULT 'general',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailSignature" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "html_content" TEXT NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailSignature_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SequencerSettings" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "default_daily_limit" INTEGER NOT NULL DEFAULT 50,
    "default_timezone" TEXT NOT NULL DEFAULT 'America/New_York',
    "default_start_time" TEXT NOT NULL DEFAULT '09:00',
    "default_end_time" TEXT NOT NULL DEFAULT '17:00',
    "default_active_days" TEXT[] DEFAULT ARRAY['mon', 'tue', 'wed', 'thu', 'fri']::TEXT[],
    "delay_between_emails" INTEGER NOT NULL DEFAULT 1,
    "global_daily_max" INTEGER NOT NULL DEFAULT 500,
    "tracking_domain" TEXT,
    "default_track_opens" BOOLEAN NOT NULL DEFAULT true,
    "default_track_clicks" BOOLEAN NOT NULL DEFAULT true,
    "default_unsubscribe" BOOLEAN NOT NULL DEFAULT true,
    "auto_pause_on_bounce" BOOLEAN NOT NULL DEFAULT true,
    "bounce_threshold" DOUBLE PRECISION NOT NULL DEFAULT 3.0,
    "stop_on_reply_default" BOOLEAN NOT NULL DEFAULT true,
    "notify_on_reply" BOOLEAN NOT NULL DEFAULT true,
    "notify_on_bounce" BOOLEAN NOT NULL DEFAULT true,
    "notify_on_complete" BOOLEAN NOT NULL DEFAULT true,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SequencerSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailThread" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "contact_email" TEXT NOT NULL,
    "contact_name" TEXT,
    "subject" TEXT NOT NULL,
    "campaign_id" TEXT,
    "campaign_name" TEXT,
    "lead_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "is_read" BOOLEAN NOT NULL DEFAULT false,
    "is_starred" BOOLEAN NOT NULL DEFAULT false,
    "last_message_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "message_count" INTEGER NOT NULL DEFAULT 1,
    "snippet" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailThread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailMessage" (
    "id" TEXT NOT NULL,
    "thread_id" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "from_email" TEXT NOT NULL,
    "from_name" TEXT,
    "to_email" TEXT NOT NULL,
    "to_name" TEXT,
    "subject" TEXT NOT NULL,
    "body_html" TEXT NOT NULL,
    "body_text" TEXT,
    "message_id" TEXT,
    "in_reply_to" TEXT,
    "references" TEXT,
    "has_attachments" BOOLEAN NOT NULL DEFAULT false,
    "is_read" BOOLEAN NOT NULL DEFAULT true,
    "sent_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "quality_class" TEXT,
    "quality_confidence" TEXT,
    "quality_signals" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "quality_classified_at" TIMESTAMP(3),

    CONSTRAINT "EmailMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailOpenEvent" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "campaign_lead_id" TEXT NOT NULL,
    "lead_id" TEXT,
    "recipient_email" TEXT NOT NULL,
    "ms_since_send" INTEGER,
    "opened_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailOpenEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailClickEvent" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "campaign_lead_id" TEXT NOT NULL,
    "lead_id" TEXT,
    "recipient_email" TEXT NOT NULL,
    "url" TEXT,
    "ms_since_send" INTEGER,
    "clicked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailClickEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ColdCallListSettings" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "min_opens" INTEGER NOT NULL DEFAULT 3,
    "time_window_days" INTEGER NOT NULL DEFAULT 7,
    "require_click" BOOLEAN NOT NULL DEFAULT false,
    "require_no_reply" BOOLEAN NOT NULL DEFAULT true,
    "exclude_recent_days" INTEGER NOT NULL DEFAULT 7,
    "title_filter" TEXT,
    "campaign_filter" JSONB,
    "max_list_size" INTEGER NOT NULL DEFAULT 200,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ColdCallListSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ColdCallDailySnapshot" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "snapshot_date" DATE NOT NULL,
    "prospect_ids" JSONB NOT NULL,
    "prospect_count" INTEGER NOT NULL DEFAULT 0,
    "generated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'success',
    "error_message" TEXT,

    CONSTRAINT "ColdCallDailySnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ColdCallCustomSnapshot" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "user_id" TEXT,
    "prospect_ids" JSONB NOT NULL,
    "prospect_count" INTEGER NOT NULL DEFAULT 0,
    "rule_snapshot" JSONB NOT NULL,
    "downloaded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ColdCallCustomSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CampaignLeadImport_campaign_id_created_at_idx" ON "CampaignLeadImport"("campaign_id", "created_at");

-- CreateIndex
CREATE INDEX "CampaignLeadImport_organization_id_idx" ON "CampaignLeadImport"("organization_id");

-- CreateIndex
CREATE INDEX "WebhookEndpoint_organization_id_active_idx" ON "WebhookEndpoint"("organization_id", "active");

-- CreateIndex
CREATE INDEX "WebhookEndpoint_organization_id_internal_idx" ON "WebhookEndpoint"("organization_id", "internal");

-- CreateIndex
CREATE INDEX "WebhookDelivery_endpoint_id_created_at_idx" ON "WebhookDelivery"("endpoint_id", "created_at");

-- CreateIndex
CREATE INDEX "WebhookDelivery_status_next_attempt_at_idx" ON "WebhookDelivery"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "WebhookDelivery_event_id_idx" ON "WebhookDelivery"("event_id");

-- CreateIndex
CREATE UNIQUE INDEX "BusinessProfile_organization_id_key" ON "BusinessProfile"("organization_id");

-- CreateIndex
CREATE INDEX "BusinessProfile_organization_id_idx" ON "BusinessProfile"("organization_id");

-- CreateIndex
CREATE INDEX "ConnectedAccount_organization_id_provider_idx" ON "ConnectedAccount"("organization_id", "provider");

-- CreateIndex
CREATE INDEX "ConnectedAccount_organization_id_connection_status_idx" ON "ConnectedAccount"("organization_id", "connection_status");

-- CreateIndex
CREATE UNIQUE INDEX "ConnectedAccount_organization_id_email_key" ON "ConnectedAccount"("organization_id", "email");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignAccount_campaign_id_account_id_key" ON "CampaignAccount"("campaign_id", "account_id");

-- CreateIndex
CREATE INDEX "SequenceStep_campaign_id_idx" ON "SequenceStep"("campaign_id");

-- CreateIndex
CREATE UNIQUE INDEX "SequenceStep_campaign_id_step_number_key" ON "SequenceStep"("campaign_id", "step_number");

-- CreateIndex
CREATE INDEX "StepVariant_step_id_idx" ON "StepVariant"("step_id");

-- CreateIndex
CREATE INDEX "CampaignLead_campaign_id_status_idx" ON "CampaignLead"("campaign_id", "status");

-- CreateIndex
CREATE INDEX "CampaignLead_campaign_id_next_send_at_idx" ON "CampaignLead"("campaign_id", "next_send_at");

-- CreateIndex
CREATE INDEX "CampaignLead_campaign_id_current_step_idx" ON "CampaignLead"("campaign_id", "current_step");

-- CreateIndex
CREATE INDEX "CampaignLead_import_id_idx" ON "CampaignLead"("import_id");

-- CreateIndex
CREATE INDEX "CampaignLead_assigned_account_id_idx" ON "CampaignLead"("assigned_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignLead_campaign_id_email_key" ON "CampaignLead"("campaign_id", "email");

-- CreateIndex
CREATE INDEX "CampaignAccountUsage_account_id_idx" ON "CampaignAccountUsage"("account_id");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignAccountUsage_campaign_id_account_id_key" ON "CampaignAccountUsage"("campaign_id", "account_id");

-- CreateIndex
CREATE INDEX "EmailTemplate_organization_id_category_idx" ON "EmailTemplate"("organization_id", "category");

-- CreateIndex
CREATE INDEX "EmailTemplate_organization_id_created_at_idx" ON "EmailTemplate"("organization_id", "created_at");

-- CreateIndex
CREATE INDEX "EmailSignature_organization_id_idx" ON "EmailSignature"("organization_id");

-- CreateIndex
CREATE INDEX "EmailSignature_organization_id_is_default_idx" ON "EmailSignature"("organization_id", "is_default");

-- CreateIndex
CREATE UNIQUE INDEX "SequencerSettings_organization_id_key" ON "SequencerSettings"("organization_id");

-- CreateIndex
CREATE INDEX "EmailThread_organization_id_status_last_message_at_idx" ON "EmailThread"("organization_id", "status", "last_message_at");

-- CreateIndex
CREATE INDEX "EmailThread_organization_id_is_read_idx" ON "EmailThread"("organization_id", "is_read");

-- CreateIndex
CREATE INDEX "EmailThread_organization_id_is_starred_idx" ON "EmailThread"("organization_id", "is_starred");

-- CreateIndex
CREATE INDEX "EmailThread_organization_id_account_id_idx" ON "EmailThread"("organization_id", "account_id");

-- CreateIndex
CREATE INDEX "EmailThread_organization_id_contact_email_idx" ON "EmailThread"("organization_id", "contact_email");

-- CreateIndex
CREATE INDEX "EmailThread_campaign_id_idx" ON "EmailThread"("campaign_id");

-- CreateIndex
CREATE INDEX "EmailMessage_thread_id_sent_at_idx" ON "EmailMessage"("thread_id", "sent_at");

-- CreateIndex
CREATE INDEX "EmailMessage_message_id_idx" ON "EmailMessage"("message_id");

-- CreateIndex
CREATE INDEX "EmailMessage_direction_quality_class_idx" ON "EmailMessage"("direction", "quality_class");

-- CreateIndex
CREATE INDEX "EmailOpenEvent_organization_id_opened_at_idx" ON "EmailOpenEvent"("organization_id", "opened_at");

-- CreateIndex
CREATE INDEX "EmailOpenEvent_campaign_id_opened_at_idx" ON "EmailOpenEvent"("campaign_id", "opened_at");

-- CreateIndex
CREATE INDEX "EmailOpenEvent_campaign_lead_id_opened_at_idx" ON "EmailOpenEvent"("campaign_lead_id", "opened_at");

-- CreateIndex
CREATE INDEX "EmailOpenEvent_lead_id_opened_at_idx" ON "EmailOpenEvent"("lead_id", "opened_at");

-- CreateIndex
CREATE INDEX "EmailClickEvent_organization_id_clicked_at_idx" ON "EmailClickEvent"("organization_id", "clicked_at");

-- CreateIndex
CREATE INDEX "EmailClickEvent_campaign_id_clicked_at_idx" ON "EmailClickEvent"("campaign_id", "clicked_at");

-- CreateIndex
CREATE INDEX "EmailClickEvent_campaign_lead_id_clicked_at_idx" ON "EmailClickEvent"("campaign_lead_id", "clicked_at");

-- CreateIndex
CREATE INDEX "EmailClickEvent_lead_id_clicked_at_idx" ON "EmailClickEvent"("lead_id", "clicked_at");

-- CreateIndex
CREATE UNIQUE INDEX "ColdCallListSettings_organization_id_key" ON "ColdCallListSettings"("organization_id");

-- CreateIndex
CREATE INDEX "ColdCallDailySnapshot_organization_id_snapshot_date_idx" ON "ColdCallDailySnapshot"("organization_id", "snapshot_date");

-- CreateIndex
CREATE UNIQUE INDEX "ColdCallDailySnapshot_organization_id_snapshot_date_key" ON "ColdCallDailySnapshot"("organization_id", "snapshot_date");

-- CreateIndex
CREATE INDEX "ColdCallCustomSnapshot_organization_id_downloaded_at_idx" ON "ColdCallCustomSnapshot"("organization_id", "downloaded_at");

-- CreateIndex
CREATE UNIQUE INDEX "Mailbox_connected_account_id_key" ON "Mailbox"("connected_account_id");

-- CreateIndex
CREATE INDEX "Mailbox_connected_account_id_idx" ON "Mailbox"("connected_account_id");

-- AddForeignKey
ALTER TABLE "CampaignLeadImport" ADD CONSTRAINT "CampaignLeadImport_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignLeadImport" ADD CONSTRAINT "CampaignLeadImport_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookEndpoint" ADD CONSTRAINT "WebhookEndpoint_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_endpoint_id_fkey" FOREIGN KEY ("endpoint_id") REFERENCES "WebhookEndpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessProfile" ADD CONSTRAINT "BusinessProfile_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Mailbox" ADD CONSTRAINT "Mailbox_connected_account_id_fkey" FOREIGN KEY ("connected_account_id") REFERENCES "ConnectedAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConnectedAccount" ADD CONSTRAINT "ConnectedAccount_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignAccount" ADD CONSTRAINT "CampaignAccount_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignAccount" ADD CONSTRAINT "CampaignAccount_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "ConnectedAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SequenceStep" ADD CONSTRAINT "SequenceStep_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StepVariant" ADD CONSTRAINT "StepVariant_step_id_fkey" FOREIGN KEY ("step_id") REFERENCES "SequenceStep"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignLead" ADD CONSTRAINT "CampaignLead_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignLead" ADD CONSTRAINT "CampaignLead_import_id_fkey" FOREIGN KEY ("import_id") REFERENCES "CampaignLeadImport"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailTemplate" ADD CONSTRAINT "EmailTemplate_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailSignature" ADD CONSTRAINT "EmailSignature_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SequencerSettings" ADD CONSTRAINT "SequencerSettings_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailThread" ADD CONSTRAINT "EmailThread_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailThread" ADD CONSTRAINT "EmailThread_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "ConnectedAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailMessage" ADD CONSTRAINT "EmailMessage_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "EmailThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

