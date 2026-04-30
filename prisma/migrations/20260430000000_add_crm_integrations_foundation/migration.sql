-- CreateTable: CrmConnection (one per (org, provider))
CREATE TABLE "CrmConnection" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "access_token" TEXT NOT NULL,
    "refresh_token" TEXT,
    "token_expires_at" TIMESTAMP(3),
    "scopes" TEXT,
    "external_account_id" TEXT,
    "external_account_name" TEXT,
    "instance_url" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "last_error" TEXT,
    "connected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "connected_by_user_id" TEXT,
    "last_sync_at" TIMESTAMP(3),
    "disconnected_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable: CrmFieldMapping
CREATE TABLE "CrmFieldMapping" (
    "id" TEXT NOT NULL,
    "crm_connection_id" TEXT NOT NULL,
    "superkabe_field" TEXT NOT NULL,
    "crm_field" TEXT NOT NULL,
    "direction" TEXT NOT NULL DEFAULT 'import',
    "transform" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmFieldMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable: CrmSyncJob (batch operations)
CREATE TABLE "CrmSyncJob" (
    "id" TEXT NOT NULL,
    "crm_connection_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'pending',
    "source_filter" JSONB,
    "total_records" INTEGER NOT NULL DEFAULT 0,
    "records_processed" INTEGER NOT NULL DEFAULT 0,
    "records_created" INTEGER NOT NULL DEFAULT 0,
    "records_updated" INTEGER NOT NULL DEFAULT 0,
    "records_skipped" INTEGER NOT NULL DEFAULT 0,
    "records_failed" INTEGER NOT NULL DEFAULT 0,
    "cursor" TEXT,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "error_message" TEXT,
    "error_count" INTEGER NOT NULL DEFAULT 0,
    "triggered_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmSyncJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable: CrmContactLink (Superkabe Lead ↔ CRM contact ID)
CREATE TABLE "CrmContactLink" (
    "id" TEXT NOT NULL,
    "crm_connection_id" TEXT NOT NULL,
    "superkabe_lead_id" TEXT NOT NULL,
    "crm_contact_id" TEXT NOT NULL,
    "last_pulled_at" TIMESTAMP(3),
    "last_pushed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmContactLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable: CrmActivityPushItem (per-event push queue)
CREATE TABLE "CrmActivityPushItem" (
    "id" TEXT NOT NULL,
    "crm_connection_id" TEXT NOT NULL,
    "superkabe_lead_id" TEXT NOT NULL,
    "crm_contact_id" TEXT,
    "event_type" TEXT NOT NULL,
    "event_payload" JSONB NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "pushed_at" TIMESTAMP(3),
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmActivityPushItem_pkey" PRIMARY KEY ("id")
);

-- Indexes: CrmConnection
CREATE UNIQUE INDEX "CrmConnection_organization_id_provider_key" ON "CrmConnection"("organization_id", "provider");
CREATE INDEX "CrmConnection_organization_id_idx" ON "CrmConnection"("organization_id");
CREATE INDEX "CrmConnection_provider_idx" ON "CrmConnection"("provider");
CREATE INDEX "CrmConnection_status_idx" ON "CrmConnection"("status");

-- Indexes: CrmFieldMapping
CREATE UNIQUE INDEX "CrmFieldMapping_crm_connection_id_superkabe_field_crm_field_key"
    ON "CrmFieldMapping"("crm_connection_id", "superkabe_field", "crm_field", "direction");
CREATE INDEX "CrmFieldMapping_crm_connection_id_idx" ON "CrmFieldMapping"("crm_connection_id");

-- Indexes: CrmSyncJob
CREATE INDEX "CrmSyncJob_crm_connection_id_idx" ON "CrmSyncJob"("crm_connection_id");
CREATE INDEX "CrmSyncJob_state_idx" ON "CrmSyncJob"("state");
CREATE INDEX "CrmSyncJob_created_at_idx" ON "CrmSyncJob"("created_at");

-- Indexes: CrmContactLink
CREATE UNIQUE INDEX "CrmContactLink_crm_connection_id_crm_contact_id_key"
    ON "CrmContactLink"("crm_connection_id", "crm_contact_id");
CREATE UNIQUE INDEX "CrmContactLink_crm_connection_id_superkabe_lead_id_key"
    ON "CrmContactLink"("crm_connection_id", "superkabe_lead_id");
CREATE INDEX "CrmContactLink_crm_connection_id_idx" ON "CrmContactLink"("crm_connection_id");
CREATE INDEX "CrmContactLink_superkabe_lead_id_idx" ON "CrmContactLink"("superkabe_lead_id");

-- Indexes: CrmActivityPushItem
CREATE UNIQUE INDEX "CrmActivityPushItem_unique_key"
    ON "CrmActivityPushItem"("crm_connection_id", "superkabe_lead_id", "event_type", "occurred_at");
CREATE INDEX "CrmActivityPushItem_crm_connection_id_state_idx" ON "CrmActivityPushItem"("crm_connection_id", "state");
CREATE INDEX "CrmActivityPushItem_state_next_attempt_at_idx" ON "CrmActivityPushItem"("state", "next_attempt_at");
CREATE INDEX "CrmActivityPushItem_superkabe_lead_id_idx" ON "CrmActivityPushItem"("superkabe_lead_id");

-- Foreign keys
ALTER TABLE "CrmConnection" ADD CONSTRAINT "CrmConnection_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CrmFieldMapping" ADD CONSTRAINT "CrmFieldMapping_crm_connection_id_fkey"
    FOREIGN KEY ("crm_connection_id") REFERENCES "CrmConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CrmSyncJob" ADD CONSTRAINT "CrmSyncJob_crm_connection_id_fkey"
    FOREIGN KEY ("crm_connection_id") REFERENCES "CrmConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CrmContactLink" ADD CONSTRAINT "CrmContactLink_crm_connection_id_fkey"
    FOREIGN KEY ("crm_connection_id") REFERENCES "CrmConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CrmActivityPushItem" ADD CONSTRAINT "CrmActivityPushItem_crm_connection_id_fkey"
    FOREIGN KEY ("crm_connection_id") REFERENCES "CrmConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
