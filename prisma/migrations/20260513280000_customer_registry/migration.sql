-- Customer registry — org-scoped list of customer COMPANIES (B2B).
-- A customer is an account/company, not an individual person. The
-- engager-relationship resolver matches the engager's current company
-- name (or company LinkedIn slug) against this table.

CREATE TABLE "Customer" (
    "id"                                  TEXT NOT NULL,
    "organization_id"                     TEXT NOT NULL,
    "company_name"                        TEXT NOT NULL,
    "company_linkedin_public_identifier"  TEXT,
    "domain"                              TEXT,
    "source"                              TEXT NOT NULL,
    "external_id"                         TEXT,
    "lifecycle_stage"                     TEXT,
    "imported_at"                         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"                          TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Customer_organization_id_company_name_idx"
    ON "Customer" ("organization_id", "company_name");

CREATE INDEX "Customer_organization_id_company_linkedin_public_identifie_idx"
    ON "Customer" ("organization_id", "company_linkedin_public_identifier");

CREATE UNIQUE INDEX "Customer_organization_id_source_external_id_key"
    ON "Customer" ("organization_id", "source", "external_id");

ALTER TABLE "Customer"
    ADD CONSTRAINT "Customer_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "Organization"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
