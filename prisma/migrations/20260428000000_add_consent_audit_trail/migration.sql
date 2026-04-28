-- Append-only consent audit trail required for GDPR Art. 7(1), DPDP § 6, and
-- PDPA Consent Obligation. Every row is forensically self-contained via the
-- snapshot fields so even after a User row is erased the consent record
-- remains intelligible.
CREATE TABLE "Consent" (
    "id"                  TEXT         NOT NULL,
    "organization_id"     TEXT,
    "user_id"             TEXT,
    "user_email_snapshot" TEXT,
    "user_name_snapshot"  TEXT,
    "consent_type"        TEXT         NOT NULL,
    "document_version"    TEXT         NOT NULL,
    "document_hash"       TEXT,
    "accepted_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "channel"             TEXT         NOT NULL,
    "ip_address"          TEXT,
    "user_agent"          TEXT,
    "withdrawn_at"        TIMESTAMP(3),
    "withdrawn_reason"    TEXT,
    "metadata"            JSONB,
    "created_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Consent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Consent_user_id_consent_type_idx"         ON "Consent" ("user_id", "consent_type");
CREATE INDEX "Consent_organization_id_consent_type_idx" ON "Consent" ("organization_id", "consent_type");
CREATE INDEX "Consent_consent_type_accepted_at_idx"     ON "Consent" ("consent_type", "accepted_at");
CREATE INDEX "Consent_accepted_at_idx"                  ON "Consent" ("accepted_at");

ALTER TABLE "Consent"
    ADD CONSTRAINT "Consent_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "Organization"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Consent"
    ADD CONSTRAINT "Consent_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
