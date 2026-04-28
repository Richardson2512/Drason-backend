-- Add one-time-import key storage to Organization
ALTER TABLE "Organization"
    ADD COLUMN "import_source_platform"      TEXT,
    ADD COLUMN "import_source_key_encrypted" TEXT,
    ADD COLUMN "import_key_expires_at"       TIMESTAMP(3);

-- ImportJob table — one row per import attempt
CREATE TABLE "ImportJob" (
    "id"              TEXT         NOT NULL,
    "organization_id" TEXT         NOT NULL,
    "platform"        TEXT         NOT NULL,
    "status"          TEXT         NOT NULL DEFAULT 'pending',
    "started_at"      TIMESTAMP(3),
    "completed_at"    TIMESTAMP(3),
    "stats"           JSONB        NOT NULL DEFAULT '{}',
    "error"           TEXT,
    "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"      TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ImportJob_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ImportJob_organization_id_status_idx"     ON "ImportJob" ("organization_id", "status");
CREATE INDEX "ImportJob_organization_id_created_at_idx" ON "ImportJob" ("organization_id", "created_at");

ALTER TABLE "ImportJob"
    ADD CONSTRAINT "ImportJob_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "Organization"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
