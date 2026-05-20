-- API/MCP audit G6: durable audit trail for OAuth / MCP / public-API
-- security events. Writes are best-effort from the writer service; the
-- table itself is the durable record SOC 2 / GDPR expects and that
-- operational `logger.info` calls cannot provide.
CREATE TABLE "SecurityAuditLog" (
    "id"              TEXT NOT NULL,
    "organization_id" TEXT,
    "actor_kind"      TEXT NOT NULL,
    "actor_id"        TEXT,
    "event_type"      TEXT NOT NULL,
    "target"          TEXT,
    "metadata"        JSONB,
    "ip"              TEXT,
    "user_agent"      TEXT,
    "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SecurityAuditLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SecurityAuditLog_organization_id_created_at_idx" ON "SecurityAuditLog"("organization_id", "created_at");
CREATE INDEX "SecurityAuditLog_event_type_created_at_idx" ON "SecurityAuditLog"("event_type", "created_at");
CREATE INDEX "SecurityAuditLog_actor_kind_actor_id_created_at_idx" ON "SecurityAuditLog"("actor_kind", "actor_id", "created_at");
