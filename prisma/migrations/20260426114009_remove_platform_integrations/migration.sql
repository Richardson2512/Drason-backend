-- DropIndex
DROP INDEX "Campaign_organization_id_source_platform_external_id_key";

-- DropIndex
DROP INDEX "Campaign_organization_id_source_platform_idx";

-- DropIndex
DROP INDEX "Domain_organization_id_source_platform_idx";

-- DropIndex
DROP INDEX "Lead_organization_id_source_platform_idx";

-- DropIndex
DROP INDEX "Mailbox_organization_id_source_platform_idx";

-- AlterTable
ALTER TABLE "Campaign" DROP COLUMN "external_id",
DROP COLUMN "last_synced_at",
DROP COLUMN "source_platform";

-- AlterTable
ALTER TABLE "Domain" DROP COLUMN "source_platform";

-- AlterTable
ALTER TABLE "Lead" DROP COLUMN "source_platform";

-- AlterTable
ALTER TABLE "Mailbox" DROP COLUMN "external_email_account_id",
DROP COLUMN "smartlead_email_account_id",
DROP COLUMN "source_platform";

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "zapmail_api_key" TEXT,
ADD COLUMN     "zapmail_connected_at" TIMESTAMP(3);

-- DropEnum
DROP TYPE "SourcePlatform";

