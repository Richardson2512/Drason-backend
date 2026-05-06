-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "account_id" TEXT,
ADD COLUMN     "client_company_name" TEXT,
ADD COLUMN     "is_seed" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "account_id" TEXT,
ADD COLUMN     "is_agency_owner" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "scoped_organization_id" TEXT;

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "legal_name" TEXT,
    "agency_mode_enabled" BOOLEAN NOT NULL DEFAULT false,
    "agency_display_name" TEXT,
    "owner_user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkspaceMembership" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "capabilities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3),

    CONSTRAINT "WorkspaceMembership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkspaceInvite" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "display_name" TEXT,
    "capabilities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_by_user_id" TEXT NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkspaceInvite_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Account_owner_user_id_key" ON "Account"("owner_user_id");

-- CreateIndex
CREATE INDEX "WorkspaceMembership_user_id_idx" ON "WorkspaceMembership"("user_id");

-- CreateIndex
CREATE INDEX "WorkspaceMembership_organization_id_status_idx" ON "WorkspaceMembership"("organization_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceMembership_organization_id_user_id_key" ON "WorkspaceMembership"("organization_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceInvite_token_hash_key" ON "WorkspaceInvite"("token_hash");

-- CreateIndex
CREATE INDEX "WorkspaceInvite_organization_id_idx" ON "WorkspaceInvite"("organization_id");

-- CreateIndex
CREATE INDEX "WorkspaceInvite_token_hash_idx" ON "WorkspaceInvite"("token_hash");

-- CreateIndex
CREATE INDEX "WorkspaceInvite_expires_at_idx" ON "WorkspaceInvite"("expires_at");

-- CreateIndex
CREATE INDEX "Organization_account_id_idx" ON "Organization"("account_id");

-- CreateIndex
CREATE INDEX "User_account_id_idx" ON "User"("account_id");

-- CreateIndex
CREATE INDEX "User_scoped_organization_id_idx" ON "User"("scoped_organization_id");

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceMembership" ADD CONSTRAINT "WorkspaceMembership_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceMembership" ADD CONSTRAINT "WorkspaceMembership_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceInvite" ADD CONSTRAINT "WorkspaceInvite_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceInvite" ADD CONSTRAINT "WorkspaceInvite_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Organization" ADD CONSTRAINT "Organization_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_scoped_organization_id_fkey" FOREIGN KEY ("scoped_organization_id") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

