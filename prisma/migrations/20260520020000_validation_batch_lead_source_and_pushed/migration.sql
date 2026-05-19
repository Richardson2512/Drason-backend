-- ValidationBatchLead carries the validation SOURCE captured at engine
-- time so routeLeads / push-to-contacts can attribute the result
-- truthfully (was hardcoded 'internal' in routeLeads, even for results
-- the MillionVerifier API actually produced - F3 root). Also tracks when
-- a lead has been "pushed to Contacts" (new action, no campaign needed -
-- Process B).
--
-- Additive, non-destructive: two nullable columns. Existing rows take NULL.

-- AlterTable
ALTER TABLE "ValidationBatchLead" ADD COLUMN     "validation_source" TEXT,
ADD COLUMN     "pushed_to_contacts_at" TIMESTAMP(3);
