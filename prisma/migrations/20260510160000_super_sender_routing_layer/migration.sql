-- Super Sender — routing-layer columns + SES event log.
-- Adds the daily-cap counter, AWS feedback aggregates, auto-pause fields,
-- and a forensics table for raw SNS events. See schema.prisma docstrings.

ALTER TABLE "DedicatedIp"
    ADD COLUMN "sends_today"          INTEGER       NOT NULL DEFAULT 0,
    ADD COLUMN "sends_reset_at"       TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ADD COLUMN "bounce_count_24h"     INTEGER       NOT NULL DEFAULT 0,
    ADD COLUMN "complaint_count_24h"  INTEGER       NOT NULL DEFAULT 0,
    ADD COLUMN "delivered_count_24h"  INTEGER       NOT NULL DEFAULT 0,
    ADD COLUMN "paused_reason"        TEXT,
    ADD COLUMN "paused_at"            TIMESTAMP(3);

CREATE TABLE "DedicatedIpEvent" (
    "id"              TEXT         NOT NULL,
    "dedicated_ip_id" TEXT         NOT NULL,
    "kind"            TEXT         NOT NULL,
    "recipient"       TEXT,
    "ses_message_id"  TEXT,
    "diagnostic"      TEXT,
    "payload"         JSONB,
    "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DedicatedIpEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "DedicatedIpEvent_dedicated_ip_id_created_at_idx"
    ON "DedicatedIpEvent"("dedicated_ip_id", "created_at");
CREATE INDEX "DedicatedIpEvent_kind_idx" ON "DedicatedIpEvent"("kind");
