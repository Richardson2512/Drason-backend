-- Reusable multi-step email sequences saved on the templates page.
-- See schema.prisma for the design rationale (clone-not-reference at
-- campaign load time, no variants in v1).

CREATE TABLE "Sequence" (
    "id"                     TEXT NOT NULL,
    "organization_id"        TEXT NOT NULL,
    "name"                   TEXT NOT NULL,
    "description"            TEXT,
    "category"               TEXT NOT NULL DEFAULT 'general',
    "ai_source_urls"         TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "ai_custom_instructions" TEXT,
    "ai_model_used"          TEXT,
    "created_at"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"             TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Sequence_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Sequence_organization_id_idx" ON "Sequence"("organization_id");
CREATE INDEX "Sequence_organization_id_category_idx" ON "Sequence"("organization_id", "category");

ALTER TABLE "Sequence"
    ADD CONSTRAINT "Sequence_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "Organization"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "SequenceTemplateStep" (
    "id"                    TEXT NOT NULL,
    "sequence_id"           TEXT NOT NULL,
    "step_number"           INTEGER NOT NULL,
    "delay_days"            INTEGER NOT NULL DEFAULT 1,
    "delay_hours"           INTEGER NOT NULL DEFAULT 0,
    "subject"               TEXT NOT NULL DEFAULT '',
    "preheader"             TEXT NOT NULL DEFAULT '',
    "body_html"             TEXT NOT NULL DEFAULT '',
    "body_text"             TEXT,
    "condition"             TEXT,
    "branch_to_step_number" INTEGER,

    CONSTRAINT "SequenceTemplateStep_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SequenceTemplateStep_sequence_id_step_number_key"
    ON "SequenceTemplateStep"("sequence_id", "step_number");
CREATE INDEX "SequenceTemplateStep_sequence_id_idx" ON "SequenceTemplateStep"("sequence_id");

ALTER TABLE "SequenceTemplateStep"
    ADD CONSTRAINT "SequenceTemplateStep_sequence_id_fkey"
    FOREIGN KEY ("sequence_id") REFERENCES "Sequence"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
