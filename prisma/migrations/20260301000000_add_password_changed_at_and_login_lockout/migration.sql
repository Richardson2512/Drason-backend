-- AlterTable
ALTER TABLE "User" ADD COLUMN "password_changed_at" TIMESTAMP(3),
ADD COLUMN "failed_login_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "locked_until" TIMESTAMP(3);
