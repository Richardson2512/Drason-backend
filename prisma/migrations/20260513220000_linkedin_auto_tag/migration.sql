-- Phase 6 — Auto-tag persistence on LinkedInProfile.
--
-- HeyReach behavior we mirror: workspace-wide, one tag per lead, latest
-- classification wins. Storing here (instead of recomputing from AgentRun
-- rows on every Unibox render) avoids the join hot-path.

ALTER TABLE "LinkedInProfile" ADD COLUMN "linkedin_auto_tag"      TEXT;
ALTER TABLE "LinkedInProfile" ADD COLUMN "linkedin_auto_tagged_at" TIMESTAMP(3);

CREATE INDEX "LinkedInProfile_organization_id_linkedin_auto_tag_idx"
    ON "LinkedInProfile"("organization_id", "linkedin_auto_tag");
