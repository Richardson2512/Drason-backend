-- 15-minute Auto-Tag delay (HeyReach spec conformance).
--
-- When a reply arrives, the classifier is NOT invoked immediately.
-- Instead the webhook handler writes the pending data on the profile +
-- a due-at timestamp 15 minutes out. A worker scans for due rows and
-- runs the classifier then. Mirrors HeyReach's stated 15-min delay
-- between reply receipt and Auto-Tag generation.
--
-- One pending classification per profile (latest wins) — if a second
-- reply lands in the window, we overwrite the pending text and reset
-- the due-at timer. This keeps the classifier latency-aware while
-- only ever running it once per profile per quiet-window.

ALTER TABLE "LinkedInProfile" ADD COLUMN "auto_tag_pending"    JSONB;
ALTER TABLE "LinkedInProfile" ADD COLUMN "auto_tag_pending_at" TIMESTAMP(3);

CREATE INDEX "LinkedInProfile_auto_tag_pending_at_idx"
    ON "LinkedInProfile"("auto_tag_pending_at")
    WHERE "auto_tag_pending_at" IS NOT NULL;
