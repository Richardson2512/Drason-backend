-- Cold Call List phone enrichment (opt-in, default OFF). A capped
-- background worker fills Lead.phone for prospects that landed on a
-- generated cold-call list, using the org's BYOK enrichment waterfall.
-- OFF by default so no customer is billed by their enrichment vendor
-- without explicitly choosing it; the daily cap bounds that spend.
-- Additive, non-destructive: existing rows take the column DEFAULTs.

-- AlterTable
ALTER TABLE "ColdCallListSettings" ADD COLUMN     "phone_enrichment_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "phone_enrichment_daily_cap" INTEGER NOT NULL DEFAULT 50;
