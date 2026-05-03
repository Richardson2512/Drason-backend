-- AlterTable
ALTER TABLE "ConnectedAccount" ADD COLUMN     "source" TEXT;

-- AlterTable
ALTER TABLE "EmailTemplate" ADD COLUMN     "folder_id" TEXT;

-- AlterTable
ALTER TABLE "Lead" ADD COLUMN     "notes" TEXT;

-- AlterTable
ALTER TABLE "SubscriptionEvent" ADD COLUMN     "amount_cents" INTEGER,
ADD COLUMN     "currency" TEXT DEFAULT 'USD',
ADD COLUMN     "polar_invoice_number" TEXT,
ADD COLUMN     "polar_invoice_url" TEXT;

-- CreateTable
CREATE TABLE "Tag" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Tag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeadTag" (
    "lead_id" TEXT NOT NULL,
    "tag_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeadTag_pkey" PRIMARY KEY ("lead_id","tag_id")
);

-- CreateTable
CREATE TABLE "CampaignTag" (
    "campaign_id" TEXT NOT NULL,
    "tag_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CampaignTag_pkey" PRIMARY KEY ("campaign_id","tag_id")
);

-- CreateTable
CREATE TABLE "OAuthState" (
    "id" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "organization_id" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OAuthState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TemplateFolder" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TemplateFolder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeadSourceConnection" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "api_key_encrypted" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "external_account_name" TEXT,
    "external_account_id" TEXT,
    "last_validated_at" TIMESTAMP(3),
    "last_used_at" TIMESTAMP(3),
    "last_error" TEXT,
    "connected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "connected_by_user_id" TEXT,
    "disconnected_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeadSourceConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeadSourceImportJob" (
    "id" TEXT NOT NULL,
    "lead_source_connection_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "source_url" TEXT,
    "parsed_filters" JSONB,
    "source_kind" TEXT,
    "source_external_id" TEXT,
    "target_campaign_id" TEXT,
    "reveal_personal_emails" BOOLEAN NOT NULL DEFAULT true,
    "cap" INTEGER,
    "total_estimated" INTEGER NOT NULL DEFAULT 0,
    "state" TEXT NOT NULL DEFAULT 'pending',
    "total_processed" INTEGER NOT NULL DEFAULT 0,
    "total_created" INTEGER NOT NULL DEFAULT 0,
    "total_updated" INTEGER NOT NULL DEFAULT 0,
    "total_skipped" INTEGER NOT NULL DEFAULT 0,
    "total_failed" INTEGER NOT NULL DEFAULT 0,
    "credits_consumed" INTEGER NOT NULL DEFAULT 0,
    "cursor" TEXT,
    "page" INTEGER NOT NULL DEFAULT 1,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "error_message" TEXT,
    "error_count" INTEGER NOT NULL DEFAULT 0,
    "triggered_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeadSourceImportJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutreachConnection" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "access_token" TEXT NOT NULL,
    "refresh_token" TEXT NOT NULL,
    "token_expires_at" TIMESTAMP(3) NOT NULL,
    "scopes" TEXT,
    "outreach_user_id" TEXT,
    "outreach_user_email" TEXT,
    "outreach_org_name" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "last_validated_at" TIMESTAMP(3),
    "last_used_at" TIMESTAMP(3),
    "last_error" TEXT,
    "connected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "connected_by_user_id" TEXT,
    "disconnected_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OutreachConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutreachExportJob" (
    "id" TEXT NOT NULL,
    "outreach_connection_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "source_kind" TEXT NOT NULL,
    "source_label" TEXT,
    "prospect_ids" TEXT[],
    "sequence_id" TEXT NOT NULL,
    "sequence_name" TEXT,
    "created_sequence" BOOLEAN NOT NULL DEFAULT false,
    "add_to_mailbox_id" TEXT,
    "total" INTEGER NOT NULL DEFAULT 0,
    "total_processed" INTEGER NOT NULL DEFAULT 0,
    "total_prospects_created" INTEGER NOT NULL DEFAULT 0,
    "total_prospects_updated" INTEGER NOT NULL DEFAULT 0,
    "total_added_to_sequence" INTEGER NOT NULL DEFAULT 0,
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

    CONSTRAINT "OutreachExportJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Tag_organization_id_idx" ON "Tag"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "Tag_organization_id_name_key" ON "Tag"("organization_id", "name");

-- CreateIndex
CREATE INDEX "LeadTag_tag_id_idx" ON "LeadTag"("tag_id");

-- CreateIndex
CREATE INDEX "LeadTag_lead_id_idx" ON "LeadTag"("lead_id");

-- CreateIndex
CREATE INDEX "CampaignTag_tag_id_idx" ON "CampaignTag"("tag_id");

-- CreateIndex
CREATE INDEX "CampaignTag_campaign_id_idx" ON "CampaignTag"("campaign_id");

-- CreateIndex
CREATE UNIQUE INDEX "OAuthState_state_key" ON "OAuthState"("state");

-- CreateIndex
CREATE INDEX "OAuthState_expires_at_idx" ON "OAuthState"("expires_at");

-- CreateIndex
CREATE INDEX "OAuthState_organization_id_idx" ON "OAuthState"("organization_id");

-- CreateIndex
CREATE INDEX "TemplateFolder_organization_id_idx" ON "TemplateFolder"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "TemplateFolder_organization_id_name_key" ON "TemplateFolder"("organization_id", "name");

-- CreateIndex
CREATE INDEX "LeadSourceConnection_organization_id_idx" ON "LeadSourceConnection"("organization_id");

-- CreateIndex
CREATE INDEX "LeadSourceConnection_provider_idx" ON "LeadSourceConnection"("provider");

-- CreateIndex
CREATE INDEX "LeadSourceConnection_status_idx" ON "LeadSourceConnection"("status");

-- CreateIndex
CREATE UNIQUE INDEX "LeadSourceConnection_organization_id_provider_key" ON "LeadSourceConnection"("organization_id", "provider");

-- CreateIndex
CREATE INDEX "LeadSourceImportJob_lead_source_connection_id_idx" ON "LeadSourceImportJob"("lead_source_connection_id");

-- CreateIndex
CREATE INDEX "LeadSourceImportJob_organization_id_idx" ON "LeadSourceImportJob"("organization_id");

-- CreateIndex
CREATE INDEX "LeadSourceImportJob_state_idx" ON "LeadSourceImportJob"("state");

-- CreateIndex
CREATE INDEX "LeadSourceImportJob_created_at_idx" ON "LeadSourceImportJob"("created_at");

-- CreateIndex
CREATE INDEX "OutreachConnection_status_idx" ON "OutreachConnection"("status");

-- CreateIndex
CREATE UNIQUE INDEX "OutreachConnection_organization_id_key" ON "OutreachConnection"("organization_id");

-- CreateIndex
CREATE INDEX "OutreachExportJob_outreach_connection_id_idx" ON "OutreachExportJob"("outreach_connection_id");

-- CreateIndex
CREATE INDEX "OutreachExportJob_organization_id_idx" ON "OutreachExportJob"("organization_id");

-- CreateIndex
CREATE INDEX "OutreachExportJob_state_idx" ON "OutreachExportJob"("state");

-- CreateIndex
CREATE INDEX "OutreachExportJob_created_at_idx" ON "OutreachExportJob"("created_at");

-- CreateIndex
CREATE INDEX "EmailTemplate_organization_id_folder_id_idx" ON "EmailTemplate"("organization_id", "folder_id");

-- AddForeignKey
ALTER TABLE "Tag" ADD CONSTRAINT "Tag_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadTag" ADD CONSTRAINT "LeadTag_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadTag" ADD CONSTRAINT "LeadTag_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "Tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignTag" ADD CONSTRAINT "CampaignTag_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignTag" ADD CONSTRAINT "CampaignTag_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "Tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailTemplate" ADD CONSTRAINT "EmailTemplate_folder_id_fkey" FOREIGN KEY ("folder_id") REFERENCES "TemplateFolder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TemplateFolder" ADD CONSTRAINT "TemplateFolder_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadSourceConnection" ADD CONSTRAINT "LeadSourceConnection_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadSourceImportJob" ADD CONSTRAINT "LeadSourceImportJob_lead_source_connection_id_fkey" FOREIGN KEY ("lead_source_connection_id") REFERENCES "LeadSourceConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutreachConnection" ADD CONSTRAINT "OutreachConnection_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutreachExportJob" ADD CONSTRAINT "OutreachExportJob_outreach_connection_id_fkey" FOREIGN KEY ("outreach_connection_id") REFERENCES "OutreachConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "CrmActivityPushItem_unique_key" RENAME TO "CrmActivityPushItem_crm_connection_id_superkabe_lead_id_eve_key";

