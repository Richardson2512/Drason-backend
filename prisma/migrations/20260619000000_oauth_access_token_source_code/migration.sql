-- API/MCP audit G4: link each OAuthAccessToken back to the auth code it was
-- minted from so detected auth-code reuse can revoke the in-flight token
-- (RFC 6749 section 10.5). Legacy rows keep NULL; revoke-on-reuse is a no-op
-- for them. Non-destructive: nullable column + index only.
ALTER TABLE "OAuthAccessToken" ADD COLUMN "source_auth_code_hash" TEXT;

CREATE INDEX "OAuthAccessToken_source_auth_code_hash_idx" ON "OAuthAccessToken"("source_auth_code_hash");
