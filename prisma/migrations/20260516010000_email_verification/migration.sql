-- Email verification on signup. Same SHA-256(token) pattern as password
-- reset (reset_token_hash). email_verified_at NULL = unverified.

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "email_verification_expires_at" TIMESTAMP(3),
ADD COLUMN     "email_verification_token_hash" TEXT,
ADD COLUMN     "email_verified_at" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_verification_token_hash_key" ON "User"("email_verification_token_hash");

-- Backfill (one-time): every row that exists when this migration runs
-- predates the feature and is a real (sometimes paying) account. Grandfather
-- them as verified so the new gate can NEVER lock out an existing user. Only
-- signups created AFTER this migration keep email_verified_at = NULL (the
-- ADD COLUMN default) and therefore must verify.
UPDATE "User" SET "email_verified_at" = "created_at" WHERE "email_verified_at" IS NULL;
