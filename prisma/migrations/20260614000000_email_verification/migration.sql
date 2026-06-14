-- Email verification for new email/password signups.
--
-- New agency signups now start unverified and must click an emailed link
-- before they can log into the dashboard. We mirror the password-reset token
-- design: store SHA-256(token) plus an expiry, never the raw token.
--
-- Backfill: every user that already exists predates this feature and has a
-- working account, so they are grandfathered to verified. New rows default to
-- false; the register controller sets false explicitly and the Google/Workspace
-- path sets true (Google attests the email).

ALTER TABLE "User"
    ADD COLUMN "email_verified" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "verification_token_hash" TEXT,
    ADD COLUMN "verification_token_expires_at" TIMESTAMP(3);

-- Grandfather all pre-existing users so the new login gate never locks them out.
UPDATE "User" SET "email_verified" = true;

-- Single outstanding verification token per user (same constraint shape as
-- reset_token_hash).
CREATE UNIQUE INDEX "User_verification_token_hash_key" ON "User"("verification_token_hash");
