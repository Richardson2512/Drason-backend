-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "postmaster_access_token" TEXT,
ADD COLUMN     "postmaster_connected_at" TIMESTAMP(3),
ADD COLUMN     "postmaster_last_error" TEXT,
ADD COLUMN     "postmaster_last_fetch_at" TIMESTAMP(3),
ADD COLUMN     "postmaster_refresh_token" TEXT,
ADD COLUMN     "postmaster_token_expires_at" TIMESTAMP(3);
-- CreateTable
CREATE TABLE "DomainReputation" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "domain_id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "fetched_at" TIMESTAMP(3) NOT NULL,
    "date" DATE NOT NULL,
    "reputation" TEXT,
    "spam_rate" DOUBLE PRECISION,
    "ip_reputation" TEXT,
    "authentication_dkim_pass_rate" DOUBLE PRECISION,
    "authentication_spf_pass_rate" DOUBLE PRECISION,
    "authentication_dmarc_pass_rate" DOUBLE PRECISION,
    "encryption_outbound_rate" DOUBLE PRECISION,
    "delivery_errors_jsonb" JSONB,
    "raw_payload" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DomainReputation_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE INDEX "DomainReputation_organization_id_date_idx" ON "DomainReputation"("organization_id", "date");
-- CreateIndex
CREATE INDEX "DomainReputation_domain_id_date_idx" ON "DomainReputation"("domain_id", "date");
-- CreateIndex
CREATE UNIQUE INDEX "DomainReputation_domain_id_source_date_key" ON "DomainReputation"("domain_id", "source", "date");
-- AddForeignKey
ALTER TABLE "DomainReputation" ADD CONSTRAINT "DomainReputation_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "DomainReputation" ADD CONSTRAINT "DomainReputation_domain_id_fkey" FOREIGN KEY ("domain_id") REFERENCES "Domain"("id") ON DELETE CASCADE ON UPDATE CASCADE;
