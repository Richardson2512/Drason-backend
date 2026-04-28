-- AlterTable
ALTER TABLE "Mailbox" ADD COLUMN     "consecutive_pauses_decayed_at" TIMESTAMP(3),
ADD COLUMN     "manual_intervention_reason" TEXT,
ADD COLUMN     "manual_intervention_required" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "manual_intervention_set_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Domain" ADD COLUMN     "consecutive_pauses_decayed_at" TIMESTAMP(3),
ADD COLUMN     "dns_check_failure_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "last_dns_check_attempt_at" TIMESTAMP(3),
ADD COLUMN     "manual_intervention_reason" TEXT,
ADD COLUMN     "manual_intervention_required" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "manual_intervention_set_at" TIMESTAMP(3);

