-- Reply intelligence: AI re-classification, OOO date extraction,
-- per-class auto-actions, and an org-level reply suppression list.
-- See schema.prisma for the kind/action enum semantics.

ALTER TABLE "EmailMessage"
    ADD COLUMN "ai_class"         TEXT,
    ADD COLUMN "ai_confidence"    TEXT,
    ADD COLUMN "ai_reasoning"     TEXT,
    ADD COLUMN "ai_classified_at" TIMESTAMP(3),
    ADD COLUMN "ooo_return_date"  TIMESTAMP(3);

CREATE INDEX "EmailMessage_direction_ai_class_idx" ON "EmailMessage"("direction", "ai_class");

ALTER TABLE "CampaignLead" ADD COLUMN "ooo_until" TIMESTAMP(3);

CREATE TABLE "ReplyActionConfig" (
    "id"              TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "reply_class"     TEXT NOT NULL,
    "action_kind"     TEXT NOT NULL,
    "enabled"         BOOLEAN NOT NULL DEFAULT true,
    "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"      TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReplyActionConfig_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ReplyActionConfig_organization_id_reply_class_action_kind_key"
    ON "ReplyActionConfig"("organization_id", "reply_class", "action_kind");
CREATE INDEX "ReplyActionConfig_organization_id_idx" ON "ReplyActionConfig"("organization_id");

ALTER TABLE "ReplyActionConfig"
    ADD CONSTRAINT "ReplyActionConfig_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "Organization"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "OrgReplySuppression" (
    "id"               TEXT NOT NULL,
    "organization_id"  TEXT NOT NULL,
    "email"            TEXT NOT NULL,
    "reason"           TEXT,
    "source_thread_id" TEXT,
    "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrgReplySuppression_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OrgReplySuppression_organization_id_email_key"
    ON "OrgReplySuppression"("organization_id", "email");
CREATE INDEX "OrgReplySuppression_organization_id_idx" ON "OrgReplySuppression"("organization_id");

ALTER TABLE "OrgReplySuppression"
    ADD CONSTRAINT "OrgReplySuppression_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "Organization"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
