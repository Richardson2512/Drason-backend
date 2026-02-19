-- AlterTable: Add Google OAuth fields to User model
-- Make password_hash optional for OAuth-only users
ALTER TABLE "User" ALTER COLUMN "password_hash" DROP NOT NULL;

-- Add Google OAuth fields
ALTER TABLE "User" ADD COLUMN "google_id" TEXT;
ALTER TABLE "User" ADD COLUMN "google_access_token" TEXT;
ALTER TABLE "User" ADD COLUMN "google_refresh_token" TEXT;
ALTER TABLE "User" ADD COLUMN "google_token_expires_at" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "avatar_url" TEXT;

-- Create unique constraint on google_id
CREATE UNIQUE INDEX "User_google_id_key" ON "User"("google_id");

-- Create index on google_id for faster lookups
CREATE INDEX "User_google_id_idx" ON "User"("google_id");
