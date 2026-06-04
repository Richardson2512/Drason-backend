-- Bridge migration: tables that were created via db push in staging
-- and never formalized into a migration file.
-- Must run before 20260418000000_add_lead_control_plane_esp_routing.

-- ─── ValidationAttempt ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "ValidationAttempt" (
    "id"              TEXT NOT NULL,
    "lead_id"         TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "source"          TEXT NOT NULL,
    "result_status"   TEXT NOT NULL,
    "result_score"    INTEGER NOT NULL,
    "result_details"  JSONB,
    "error_message"   TEXT,
    "duration_ms"     INTEGER,
    "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ValidationAttempt_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "ValidationAttempt_lead_id_idx" ON "ValidationAttempt"("lead_id");
CREATE INDEX IF NOT EXISTS "ValidationAttempt_organization_id_created_at_idx" ON "ValidationAttempt"("organization_id", "created_at");

-- ─── DomainInsight ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "DomainInsight" (
    "id"              TEXT NOT NULL,
    "domain"          TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "has_mx"          BOOLEAN NOT NULL DEFAULT false,
    "is_catch_all"    BOOLEAN NOT NULL DEFAULT false,
    "is_disposable"   BOOLEAN NOT NULL DEFAULT false,
    "esp_bucket"      TEXT,
    "mx_records"      JSONB,
    "checked_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"      TIMESTAMP(3) NOT NULL,
    CONSTRAINT "DomainInsight_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "DomainInsight_organization_id_domain_key" ON "DomainInsight"("organization_id", "domain");
CREATE INDEX IF NOT EXISTS "DomainInsight_domain_idx" ON "DomainInsight"("domain");
CREATE INDEX IF NOT EXISTS "DomainInsight_organization_id_idx" ON "DomainInsight"("organization_id");

-- ─── ApiCallLog ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "ApiCallLog" (
    "id"              TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "platform"        TEXT NOT NULL,
    "endpoint"        TEXT NOT NULL,
    "status_code"     INTEGER,
    "duration_ms"     INTEGER,
    "error"           TEXT,
    "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ApiCallLog_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "ApiCallLog_organization_id_platform_idx" ON "ApiCallLog"("organization_id", "platform");
CREATE INDEX IF NOT EXISTS "ApiCallLog_organization_id_created_at_idx" ON "ApiCallLog"("organization_id", "created_at");
CREATE INDEX IF NOT EXISTS "ApiCallLog_platform_created_at_idx" ON "ApiCallLog"("platform", "created_at");

-- ─── Notification ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "Notification" (
    "id"              TEXT NOT NULL,
    "type"            TEXT NOT NULL,
    "title"           TEXT NOT NULL,
    "message"         TEXT NOT NULL,
    "is_read"         BOOLEAN NOT NULL DEFAULT false,
    "user_id"         TEXT,
    "organization_id" TEXT NOT NULL,
    "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX IF NOT EXISTS "Notification_organization_id_created_at_idx" ON "Notification"("organization_id", "created_at");
CREATE INDEX IF NOT EXISTS "Notification_organization_id_is_read_idx" ON "Notification"("organization_id", "is_read");

-- ─── InfrastructureReport ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "InfrastructureReport" (
    "id"                 TEXT NOT NULL,
    "organization_id"    TEXT NOT NULL,
    "report_type"        TEXT NOT NULL,
    "assessment_version" TEXT NOT NULL DEFAULT '1.0',
    "overall_score"      DOUBLE PRECISION NOT NULL,
    "summary"            JSONB NOT NULL,
    "findings"           JSONB NOT NULL,
    "recommendations"    JSONB NOT NULL,
    "created_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "InfrastructureReport_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "InfrastructureReport" ADD CONSTRAINT "InfrastructureReport_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX IF NOT EXISTS "InfrastructureReport_organization_id_created_at_idx" ON "InfrastructureReport"("organization_id", "created_at");

-- ─── SlackIntegration ─────────────────────────────────────────────────────────
DO $$ BEGIN
    CREATE TYPE "SlackAlertsStatus" AS ENUM ('active', 'revoked', 'channel_not_found', 'auth_error');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "SlackIntegration" (
    "id"                         TEXT NOT NULL,
    "organization_id"            TEXT NOT NULL,
    "slack_team_id"              TEXT NOT NULL,
    "bot_token_encrypted"        TEXT NOT NULL,
    "installed_by_user_id"       TEXT NOT NULL,
    "alerts_channel_id"          TEXT,
    "alerts_status"              "SlackAlertsStatus" NOT NULL DEFAULT 'active',
    "alerts_last_error_at"       TIMESTAMP(3),
    "alerts_last_error_message"  TEXT,
    "created_at"                 TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"                 TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SlackIntegration_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "SlackIntegration" ADD CONSTRAINT "SlackIntegration_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SlackIntegration" ADD CONSTRAINT "SlackIntegration_installed_by_user_id_fkey"
    FOREIGN KEY ("installed_by_user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE UNIQUE INDEX IF NOT EXISTS "SlackIntegration_organization_id_key" ON "SlackIntegration"("organization_id");
CREATE UNIQUE INDEX IF NOT EXISTS "SlackIntegration_slack_team_id_key" ON "SlackIntegration"("slack_team_id");
CREATE INDEX IF NOT EXISTS "SlackIntegration_organization_id_idx" ON "SlackIntegration"("organization_id");
CREATE INDEX IF NOT EXISTS "SlackIntegration_slack_team_id_idx" ON "SlackIntegration"("slack_team_id");

-- ─── SlackAlertLog ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "SlackAlertLog" (
    "id"              TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "event_type"      TEXT NOT NULL,
    "event_hash"      TEXT NOT NULL,
    "sent_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "title"           TEXT,
    "message"         TEXT,
    "severity"        TEXT,
    "entity_id"       TEXT,
    "channel_id"      TEXT,
    "suppressed_by_pref" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "SlackAlertLog_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "SlackAlertLog_event_hash_key" ON "SlackAlertLog"("event_hash");
CREATE INDEX IF NOT EXISTS "SlackAlertLog_organization_id_event_hash_idx" ON "SlackAlertLog"("organization_id", "event_hash");
CREATE INDEX IF NOT EXISTS "SlackAlertLog_organization_id_sent_at_idx" ON "SlackAlertLog"("organization_id", "sent_at");

-- ─── SlackNotificationPreference ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "SlackNotificationPreference" (
    "id"                  TEXT NOT NULL,
    "organization_id"     TEXT NOT NULL,
    "event_type"          TEXT NOT NULL,
    "enabled"             BOOLEAN NOT NULL DEFAULT true,
    "channel_id_override" TEXT,
    "updated_at"          TIMESTAMP(3) NOT NULL,
    "created_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SlackNotificationPreference_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "SlackNotificationPreference" ADD CONSTRAINT "SlackNotificationPreference_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE UNIQUE INDEX IF NOT EXISTS "SlackNotificationPreference_organization_id_event_type_key" ON "SlackNotificationPreference"("organization_id", "event_type");
CREATE INDEX IF NOT EXISTS "SlackNotificationPreference_organization_id_idx" ON "SlackNotificationPreference"("organization_id");

-- ─── SupportTicket ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "SupportTicket" (
    "id"              TEXT NOT NULL,
    "ticket_id"       TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "user_id"         TEXT NOT NULL,
    "user_email"      TEXT NOT NULL,
    "subject"         TEXT NOT NULL,
    "description"     TEXT NOT NULL,
    "category"        TEXT NOT NULL DEFAULT 'general',
    "status"          TEXT NOT NULL DEFAULT 'open',
    "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"      TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SupportTicket_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "SupportTicket" ADD CONSTRAINT "SupportTicket_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE UNIQUE INDEX IF NOT EXISTS "SupportTicket_ticket_id_key" ON "SupportTicket"("ticket_id");
CREATE INDEX IF NOT EXISTS "SupportTicket_organization_id_created_at_idx" ON "SupportTicket"("organization_id", "created_at");
CREATE INDEX IF NOT EXISTS "SupportTicket_ticket_id_idx" ON "SupportTicket"("ticket_id");
CREATE INDEX IF NOT EXISTS "SupportTicket_status_idx" ON "SupportTicket"("status");

-- ─── PendingRegistration ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "PendingRegistration" (
    "id"                      TEXT NOT NULL,
    "token"                   TEXT NOT NULL,
    "google_id"               TEXT NOT NULL,
    "email"                   TEXT NOT NULL,
    "name"                    TEXT,
    "avatar_url"              TEXT,
    "google_access_token"     TEXT NOT NULL,
    "google_refresh_token"    TEXT,
    "google_token_expires_at" TIMESTAMP(3),
    "selected_plan"           TEXT,
    "expires_at"              TIMESTAMP(3) NOT NULL,
    "created_at"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PendingRegistration_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "PendingRegistration_token_key" ON "PendingRegistration"("token");
CREATE INDEX IF NOT EXISTS "PendingRegistration_token_idx" ON "PendingRegistration"("token");
CREATE INDEX IF NOT EXISTS "PendingRegistration_expires_at_idx" ON "PendingRegistration"("expires_at");

-- ─── DnsblList ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "DnsblList" (
    "id"              TEXT NOT NULL,
    "name"            TEXT NOT NULL,
    "zone"            TEXT NOT NULL,
    "tier"            TEXT NOT NULL,
    "category"        TEXT NOT NULL DEFAULT 'general',
    "weight"          INTEGER NOT NULL DEFAULT 1,
    "enabled"         BOOLEAN NOT NULL DEFAULT true,
    "requires_auth"   BOOLEAN NOT NULL DEFAULT false,
    "auth_config_key" TEXT,
    "rotation_group"  INTEGER NOT NULL DEFAULT 0,
    "delisting_url"   TEXT,
    "notes"           TEXT,
    "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"      TIMESTAMP(3) NOT NULL,
    CONSTRAINT "DnsblList_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "DnsblList_name_key" ON "DnsblList"("name");
CREATE INDEX IF NOT EXISTS "DnsblList_tier_idx" ON "DnsblList"("tier");
CREATE INDEX IF NOT EXISTS "DnsblList_enabled_idx" ON "DnsblList"("enabled");

-- ─── DnsblResult ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "DnsblResult" (
    "id"            TEXT NOT NULL,
    "domain_id"     TEXT NOT NULL,
    "dnsbl_list_id" TEXT NOT NULL,
    "status"        TEXT NOT NULL,
    "response_code" TEXT,
    "checked_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DnsblResult_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "DnsblResult" ADD CONSTRAINT "DnsblResult_domain_id_fkey"
    FOREIGN KEY ("domain_id") REFERENCES "Domain"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DnsblResult" ADD CONSTRAINT "DnsblResult_dnsbl_list_id_fkey"
    FOREIGN KEY ("dnsbl_list_id") REFERENCES "DnsblList"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE UNIQUE INDEX IF NOT EXISTS "DnsblResult_domain_id_dnsbl_list_id_key" ON "DnsblResult"("domain_id", "dnsbl_list_id");
CREATE INDEX IF NOT EXISTS "DnsblResult_domain_id_checked_at_idx" ON "DnsblResult"("domain_id", "checked_at");
CREATE INDEX IF NOT EXISTS "DnsblResult_dnsbl_list_id_idx" ON "DnsblResult"("dnsbl_list_id");

-- ─── LeadScoringConfig ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "LeadScoringConfig" (
    "id"              TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "builtin_weights" JSONB NOT NULL,
    "custom_events"   JSONB NOT NULL DEFAULT '[]',
    "updated_at"      TIMESTAMP(3) NOT NULL,
    "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LeadScoringConfig_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "LeadScoringConfig" ADD CONSTRAINT "LeadScoringConfig_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE UNIQUE INDEX IF NOT EXISTS "LeadScoringConfig_organization_id_key" ON "LeadScoringConfig"("organization_id");

-- ─── LeadScoreEvent ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "LeadScoreEvent" (
    "id"                 TEXT NOT NULL,
    "lead_id"            TEXT NOT NULL,
    "organization_id"    TEXT NOT NULL,
    "event_key"          TEXT NOT NULL,
    "label"              TEXT NOT NULL,
    "points"             INTEGER NOT NULL,
    "created_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_user_id" TEXT,
    "note"               TEXT,
    CONSTRAINT "LeadScoreEvent_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "LeadScoreEvent" ADD CONSTRAINT "LeadScoreEvent_lead_id_fkey"
    FOREIGN KEY ("lead_id") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LeadScoreEvent" ADD CONSTRAINT "LeadScoreEvent_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX IF NOT EXISTS "LeadScoreEvent_lead_id_created_at_idx" ON "LeadScoreEvent"("lead_id", "created_at");
CREATE INDEX IF NOT EXISTS "LeadScoreEvent_organization_id_idx" ON "LeadScoreEvent"("organization_id");
