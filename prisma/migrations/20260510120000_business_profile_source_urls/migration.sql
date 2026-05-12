-- Multi-source BusinessProfile: track every URL the operator pasted, not
-- just the first. Older rows are backfilled with [source_url] so reads
-- never hit a NULL/empty array.

ALTER TABLE "BusinessProfile" ADD COLUMN "source_urls" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

UPDATE "BusinessProfile"
   SET "source_urls" = ARRAY["source_url"]
 WHERE COALESCE(array_length("source_urls", 1), 0) = 0;
