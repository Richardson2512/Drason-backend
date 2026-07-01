-- Door B infrastructure-readiness gate.
-- Separates infrastructure-blocking problems (blacklist listings) from the healing pipeline
-- (status/recovery_phase). 'action_required' = mailbox/domain is NOT sendable because of a
-- blocking blacklist listing; it is cleared back to 'ready' by an on-demand or periodic
-- re-check. This state is NEVER entered from send/bounce behaviour - that remains the job of
-- recovery_phase (Door A) - which is why never-sent imported mailboxes no longer get trapped
-- in the healing graduation pipeline.

ALTER TABLE "Mailbox" ADD COLUMN "infra_status" TEXT NOT NULL DEFAULT 'ready';
ALTER TABLE "Mailbox" ADD COLUMN "infra_reason" TEXT;
ALTER TABLE "Domain" ADD COLUMN "infra_status" TEXT NOT NULL DEFAULT 'ready';
ALTER TABLE "Domain" ADD COLUMN "infra_reason" TEXT;

CREATE INDEX "Mailbox_organization_id_infra_status_idx" ON "Mailbox"("organization_id", "infra_status");
CREATE INDEX "Domain_organization_id_infra_status_idx" ON "Domain"("organization_id", "infra_status");
