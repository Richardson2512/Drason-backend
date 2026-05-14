-- Super LinkedIn module — foundation tables.
-- See docs/heyreach-reference.md for the behavior spec these model.
-- See schema.prisma "Super LinkedIn module" section for Prisma definitions.

-- CreateTable
CREATE TABLE "LinkedInAccount" (
    "id"                        TEXT NOT NULL,
    "organization_id"           TEXT NOT NULL,
    "unipile_account_id"        TEXT NOT NULL,
    "display_name"              TEXT NOT NULL,
    "account_type"              TEXT NOT NULL DEFAULT 'CLASSIC',
    "status"                    TEXT NOT NULL DEFAULT 'CONNECTING',
    "status_detail"             TEXT,
    "inbox_sync_mode"           TEXT NOT NULL DEFAULT 'all',
    "invites_today"             INTEGER NOT NULL DEFAULT 0,
    "invites_this_week"         INTEGER NOT NULL DEFAULT 0,
    "messages_today"            INTEGER NOT NULL DEFAULT 0,
    "inmails_today"             INTEGER NOT NULL DEFAULT 0,
    "profile_views_today"       INTEGER NOT NULL DEFAULT 0,
    "daily_reset_at"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "weekly_reset_at"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "max_invites_per_day"       INTEGER NOT NULL DEFAULT 25,
    "max_invites_per_week"      INTEGER NOT NULL DEFAULT 200,
    "max_messages_per_day"      INTEGER NOT NULL DEFAULT 100,
    "max_inmails_per_day"       INTEGER NOT NULL DEFAULT 50,
    "max_profile_views_per_day" INTEGER NOT NULL DEFAULT 100,
    "connected_at"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_status_at"            TIMESTAMP(3),
    "created_at"                TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"                TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LinkedInAccount_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "LinkedInAccount_unipile_account_id_key" ON "LinkedInAccount"("unipile_account_id");
CREATE INDEX "LinkedInAccount_organization_id_idx" ON "LinkedInAccount"("organization_id");
CREATE INDEX "LinkedInAccount_status_idx" ON "LinkedInAccount"("status");

ALTER TABLE "LinkedInAccount"
    ADD CONSTRAINT "LinkedInAccount_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "Organization"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "LinkedInProfile" (
    "id"                  TEXT NOT NULL,
    "organization_id"     TEXT NOT NULL,
    "public_identifier"   TEXT NOT NULL,
    "member_urn"          TEXT,
    "name"                TEXT NOT NULL,
    "headline"            TEXT,
    "company"             TEXT,
    "position"            TEXT,
    "location"            TEXT,
    "industry"            TEXT,
    "profile_picture_url" TEXT,
    "icp_matched_at"      TIMESTAMP(3),
    "icp_match_score"     DOUBLE PRECISION,
    "lead_id"             TEXT,
    "last_profile_fetch"  TIMESTAMP(3),
    "created_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"          TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LinkedInProfile_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "LinkedInProfile_organization_id_public_identifier_key"
    ON "LinkedInProfile"("organization_id", "public_identifier");
CREATE INDEX "LinkedInProfile_organization_id_member_urn_idx"
    ON "LinkedInProfile"("organization_id", "member_urn");
CREATE INDEX "LinkedInProfile_lead_id_idx" ON "LinkedInProfile"("lead_id");

ALTER TABLE "LinkedInProfile"
    ADD CONSTRAINT "LinkedInProfile_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "Organization"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "LinkedInConnectionEdge" (
    "linkedin_account_id" TEXT NOT NULL,
    "linkedin_profile_id" TEXT NOT NULL,
    "status"              TEXT NOT NULL DEFAULT 'NOT_DETERMINED',
    "invite_has_note"     BOOLEAN NOT NULL DEFAULT false,
    "invited_at"          TIMESTAMP(3),
    "accepted_at"         TIMESTAMP(3),
    "withdrawn_at"        TIMESTAMP(3),
    "last_polled_at"      TIMESTAMP(3),
    "created_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"          TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LinkedInConnectionEdge_pkey" PRIMARY KEY ("linkedin_account_id","linkedin_profile_id")
);

CREATE INDEX "LinkedInConnectionEdge_linkedin_account_id_status_idx"
    ON "LinkedInConnectionEdge"("linkedin_account_id", "status");

ALTER TABLE "LinkedInConnectionEdge"
    ADD CONSTRAINT "LinkedInConnectionEdge_linkedin_account_id_fkey"
    FOREIGN KEY ("linkedin_account_id") REFERENCES "LinkedInAccount"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LinkedInConnectionEdge"
    ADD CONSTRAINT "LinkedInConnectionEdge_linkedin_profile_id_fkey"
    FOREIGN KEY ("linkedin_profile_id") REFERENCES "LinkedInProfile"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "LinkedInPost" (
    "id"                  TEXT NOT NULL,
    "linkedin_account_id" TEXT NOT NULL,
    "unipile_post_id"     TEXT NOT NULL,
    "posted_at"           TIMESTAMP(3) NOT NULL,
    "last_polled_at"      TIMESTAMP(3),
    "last_reaction_count" INTEGER NOT NULL DEFAULT 0,
    "last_comment_count"  INTEGER NOT NULL DEFAULT 0,
    "last_share_count"    INTEGER NOT NULL DEFAULT 0,
    "archived"            BOOLEAN NOT NULL DEFAULT false,
    "created_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"          TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LinkedInPost_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "LinkedInPost_unipile_post_id_key" ON "LinkedInPost"("unipile_post_id");
CREATE INDEX "LinkedInPost_linkedin_account_id_archived_idx"
    ON "LinkedInPost"("linkedin_account_id", "archived");
CREATE INDEX "LinkedInPost_posted_at_idx" ON "LinkedInPost"("posted_at");

ALTER TABLE "LinkedInPost"
    ADD CONSTRAINT "LinkedInPost_linkedin_account_id_fkey"
    FOREIGN KEY ("linkedin_account_id") REFERENCES "LinkedInAccount"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "EngagementEvent" (
    "id"               TEXT NOT NULL,
    "organization_id"  TEXT NOT NULL,
    "linkedin_post_id" TEXT NOT NULL,
    "actor_profile_id" TEXT NOT NULL,
    "event_type"       TEXT NOT NULL,
    "reaction_type"    TEXT,
    "occurred_at"      TIMESTAMP(3) NOT NULL,
    "ingested_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at"     TIMESTAMP(3),
    "agent_run_id"     TEXT,

    CONSTRAINT "EngagementEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EngagementEvent_post_actor_event_reaction_key"
    ON "EngagementEvent"("linkedin_post_id", "actor_profile_id", "event_type", "reaction_type");
CREATE INDEX "EngagementEvent_organization_id_processed_at_idx"
    ON "EngagementEvent"("organization_id", "processed_at");
CREATE INDEX "EngagementEvent_occurred_at_idx" ON "EngagementEvent"("occurred_at");

ALTER TABLE "EngagementEvent"
    ADD CONSTRAINT "EngagementEvent_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "Organization"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EngagementEvent"
    ADD CONSTRAINT "EngagementEvent_linkedin_post_id_fkey"
    FOREIGN KEY ("linkedin_post_id") REFERENCES "LinkedInPost"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EngagementEvent"
    ADD CONSTRAINT "EngagementEvent_actor_profile_id_fkey"
    FOREIGN KEY ("actor_profile_id") REFERENCES "LinkedInProfile"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "IcpProfile" (
    "id"              TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "name"            TEXT NOT NULL,
    "description"     TEXT,
    "titles"          TEXT[] DEFAULT ARRAY[]::TEXT[],
    "industries"      TEXT[] DEFAULT ARRAY[]::TEXT[],
    "company_sizes"   TEXT[] DEFAULT ARRAY[]::TEXT[],
    "geos"            TEXT[] DEFAULT ARRAY[]::TEXT[],
    "enabled"         BOOLEAN NOT NULL DEFAULT true,
    "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"      TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IcpProfile_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "IcpProfile_organization_id_enabled_idx"
    ON "IcpProfile"("organization_id", "enabled");

ALTER TABLE "IcpProfile"
    ADD CONSTRAINT "IcpProfile_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "Organization"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "SignalMonitoringRule" (
    "id"                       TEXT NOT NULL,
    "organization_id"          TEXT NOT NULL,
    "scope_level"              TEXT NOT NULL,
    "scope_targets"            TEXT[] DEFAULT ARRAY[]::TEXT[],
    "mode"                     TEXT NOT NULL DEFAULT 'OBSERVE',
    "icp_profile_ids"          TEXT[] DEFAULT ARRAY[]::TEXT[],
    "add_to_cold_call_list_id" TEXT,
    "add_to_campaign_id"       TEXT,
    "notify_user_ids"          TEXT[] DEFAULT ARRAY[]::TEXT[],
    "enabled"                  BOOLEAN NOT NULL DEFAULT true,
    "created_at"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"               TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SignalMonitoringRule_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SignalMonitoringRule_organization_id_scope_level_enabled_idx"
    ON "SignalMonitoringRule"("organization_id", "scope_level", "enabled");

ALTER TABLE "SignalMonitoringRule"
    ADD CONSTRAINT "SignalMonitoringRule_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "Organization"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "AgentRun" (
    "id"                TEXT NOT NULL,
    "organization_id"   TEXT NOT NULL,
    "trigger"           TEXT NOT NULL,
    "trigger_ref_id"    TEXT,
    "agent_name"        TEXT NOT NULL,
    "model"             TEXT NOT NULL,
    "prompt_tokens"     INTEGER,
    "completion_tokens" INTEGER,
    "latency_ms"        INTEGER NOT NULL,
    "decision"          JSONB,
    "cost_usd"          DECIMAL(10,6),
    "status"            TEXT NOT NULL DEFAULT 'SUCCESS',
    "error_message"     TEXT,
    "created_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AgentRun_organization_id_agent_name_created_at_idx"
    ON "AgentRun"("organization_id", "agent_name", "created_at");
CREATE INDEX "AgentRun_trigger_trigger_ref_id_idx"
    ON "AgentRun"("trigger", "trigger_ref_id");

ALTER TABLE "AgentRun"
    ADD CONSTRAINT "AgentRun_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "Organization"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "EnrichmentProvider" (
    "id"              TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "provider"        TEXT NOT NULL,
    "enabled"         BOOLEAN NOT NULL DEFAULT true,
    "order_index"     INTEGER NOT NULL DEFAULT 0,
    "credentials_ref" TEXT,
    "config"          JSONB NOT NULL DEFAULT '{}',
    "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"      TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EnrichmentProvider_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EnrichmentProvider_organization_id_provider_key"
    ON "EnrichmentProvider"("organization_id", "provider");
CREATE INDEX "EnrichmentProvider_organization_id_enabled_order_index_idx"
    ON "EnrichmentProvider"("organization_id", "enabled", "order_index");

ALTER TABLE "EnrichmentProvider"
    ADD CONSTRAINT "EnrichmentProvider_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "Organization"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "EnrichmentAttempt" (
    "id"              TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "lead_id"         TEXT NOT NULL,
    "provider"        TEXT NOT NULL,
    "result"          TEXT NOT NULL,
    "fields_filled"   TEXT[] DEFAULT ARRAY[]::TEXT[],
    "cost_usd"        DECIMAL(10,6),
    "error_message"   TEXT,
    "attempted_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EnrichmentAttempt_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "EnrichmentAttempt_organization_id_lead_id_attempted_at_idx"
    ON "EnrichmentAttempt"("organization_id", "lead_id", "attempted_at");

ALTER TABLE "EnrichmentAttempt"
    ADD CONSTRAINT "EnrichmentAttempt_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "Organization"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
