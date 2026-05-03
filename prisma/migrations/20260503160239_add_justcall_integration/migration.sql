-- CreateTable
CREATE TABLE "JustCallConnection" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "api_key" TEXT NOT NULL,
    "api_secret" TEXT NOT NULL,
    "justcall_user_id" TEXT,
    "justcall_user_email" TEXT,
    "justcall_account_name" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "last_validated_at" TIMESTAMP(3),
    "last_used_at" TIMESTAMP(3),
    "last_error" TEXT,
    "connected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "connected_by_user_id" TEXT,
    "disconnected_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JustCallConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JustCallExportJob" (
    "id" TEXT NOT NULL,
    "justcall_connection_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "source_kind" TEXT NOT NULL,
    "source_label" TEXT,
    "prospect_ids" TEXT[],
    "campaign_id" TEXT NOT NULL,
    "campaign_name" TEXT,
    "created_campaign" BOOLEAN NOT NULL DEFAULT false,
    "total" INTEGER NOT NULL DEFAULT 0,
    "total_processed" INTEGER NOT NULL DEFAULT 0,
    "total_added" INTEGER NOT NULL DEFAULT 0,
    "total_skipped" INTEGER NOT NULL DEFAULT 0,
    "total_failed" INTEGER NOT NULL DEFAULT 0,
    "cursor" INTEGER NOT NULL DEFAULT 0,
    "state" TEXT NOT NULL DEFAULT 'pending',
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "error_message" TEXT,
    "error_count" INTEGER NOT NULL DEFAULT 0,
    "triggered_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JustCallExportJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "JustCallConnection_status_idx" ON "JustCallConnection"("status");

-- CreateIndex
CREATE UNIQUE INDEX "JustCallConnection_organization_id_key" ON "JustCallConnection"("organization_id");

-- CreateIndex
CREATE INDEX "JustCallExportJob_justcall_connection_id_idx" ON "JustCallExportJob"("justcall_connection_id");

-- CreateIndex
CREATE INDEX "JustCallExportJob_organization_id_idx" ON "JustCallExportJob"("organization_id");

-- CreateIndex
CREATE INDEX "JustCallExportJob_state_idx" ON "JustCallExportJob"("state");

-- CreateIndex
CREATE INDEX "JustCallExportJob_created_at_idx" ON "JustCallExportJob"("created_at");

-- AddForeignKey
ALTER TABLE "JustCallConnection" ADD CONSTRAINT "JustCallConnection_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JustCallExportJob" ADD CONSTRAINT "JustCallExportJob_justcall_connection_id_fkey" FOREIGN KEY ("justcall_connection_id") REFERENCES "JustCallConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

