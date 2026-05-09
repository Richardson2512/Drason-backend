-- AlterTable
ALTER TABLE "Lead" ADD COLUMN     "company_linkedin_url" TEXT;

-- CreateTable
CREATE TABLE "LeadProfile" (
    "id" TEXT NOT NULL,
    "lead_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "source_url" TEXT NOT NULL,
    "source_kind" TEXT NOT NULL,
    "profile_json" JSONB,
    "scraped_chars" INTEGER NOT NULL DEFAULT 0,
    "model_used" TEXT,
    "prompt_tokens" INTEGER NOT NULL DEFAULT 0,
    "completion_tokens" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "last_error" TEXT,
    "extracted_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeadProfile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LeadProfile_lead_id_key" ON "LeadProfile"("lead_id");

-- CreateIndex
CREATE INDEX "LeadProfile_organization_id_idx" ON "LeadProfile"("organization_id");

-- CreateIndex
CREATE INDEX "LeadProfile_status_idx" ON "LeadProfile"("status");

-- AddForeignKey
ALTER TABLE "LeadProfile" ADD CONSTRAINT "LeadProfile_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

