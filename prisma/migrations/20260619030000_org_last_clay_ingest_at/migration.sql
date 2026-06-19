-- The dashboard showed Clay as "always connected" because there was no real
-- signal to check. Lead.source defaults to "clay", so a source-count would be
-- polluted by any lead created without an explicit source. This column is set
-- only by the Clay ingest endpoint, giving a reliable "Clay has delivered"
-- signal. Non-destructive: one nullable column.
ALTER TABLE "Organization" ADD COLUMN "last_clay_ingest_at" TIMESTAMP(3);
