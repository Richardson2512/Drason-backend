-- Bring EnrichmentProvider in line with every other integration's
-- at-rest credential pattern. Was the only one storing per-provider API
-- keys (Apollo / Clay / Surfe / Lusha / Hunter / ZoomInfo) in plaintext
-- inside a Json `config` column - the documented "follow-up" that the
-- waterfallService.ts header literally calls out.
--
-- This migration is additive (one nullable column) and non-destructive.
-- The waterfall reader prefers the encrypted column when present and
-- falls back to the legacy `config.credentials` shape, so existing rows
-- (if any) keep working until an offline backfill moves them.

-- AlterTable
ALTER TABLE "EnrichmentProvider" ADD COLUMN     "credentials_encrypted" TEXT;
