-- CreateTable
CREATE TABLE "OAuthClient" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "client_secret_hash" TEXT,
    "client_name" TEXT NOT NULL,
    "redirect_uris" JSONB NOT NULL,
    "grant_types" JSONB NOT NULL,
    "response_types" JSONB NOT NULL,
    "token_endpoint_auth_method" TEXT NOT NULL DEFAULT 'none',
    "scope" TEXT,
    "client_uri" TEXT,
    "logo_uri" TEXT,
    "software_id" TEXT,
    "software_version" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "client_id_issued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "client_secret_expires_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "OAuthClient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OAuthAuthorizationCode" (
    "id" TEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "redirect_uri" TEXT NOT NULL,
    "scope" TEXT,
    "code_challenge" TEXT NOT NULL,
    "code_challenge_method" TEXT NOT NULL DEFAULT 'S256',
    "resource" TEXT,
    "state" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OAuthAuthorizationCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OAuthAccessToken" (
    "id" TEXT NOT NULL,
    "access_token_hash" TEXT NOT NULL,
    "refresh_token_hash" TEXT,
    "client_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "resource" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "refresh_expires_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMP(3),

    CONSTRAINT "OAuthAccessToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OAuthClient_client_id_key" ON "OAuthClient"("client_id");

-- CreateIndex
CREATE INDEX "OAuthClient_client_id_idx" ON "OAuthClient"("client_id");

-- CreateIndex
CREATE UNIQUE INDEX "OAuthAuthorizationCode_code_hash_key" ON "OAuthAuthorizationCode"("code_hash");

-- CreateIndex
CREATE INDEX "OAuthAuthorizationCode_client_id_idx" ON "OAuthAuthorizationCode"("client_id");

-- CreateIndex
CREATE INDEX "OAuthAuthorizationCode_expires_at_idx" ON "OAuthAuthorizationCode"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "OAuthAccessToken_access_token_hash_key" ON "OAuthAccessToken"("access_token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "OAuthAccessToken_refresh_token_hash_key" ON "OAuthAccessToken"("refresh_token_hash");

-- CreateIndex
CREATE INDEX "OAuthAccessToken_client_id_idx" ON "OAuthAccessToken"("client_id");

-- CreateIndex
CREATE INDEX "OAuthAccessToken_organization_id_idx" ON "OAuthAccessToken"("organization_id");

-- CreateIndex
CREATE INDEX "OAuthAccessToken_expires_at_idx" ON "OAuthAccessToken"("expires_at");

-- AddForeignKey
ALTER TABLE "OAuthAuthorizationCode" ADD CONSTRAINT "OAuthAuthorizationCode_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "OAuthClient"("client_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OAuthAccessToken" ADD CONSTRAINT "OAuthAccessToken_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "OAuthClient"("client_id") ON DELETE CASCADE ON UPDATE CASCADE;
