-- API/MCP audit G4: link each OAuthAccessToken back to the auth code it
-- was minted from so that detected auth-code reuse can revoke the
-- in-flight token (RFC 6749 §10.5). Legacy rows keep NULL; the revoke-
-- on-reuse step is a no-op for them.
ALTER TABLE "OAuthAccessToken" ADD COLUMN "source_auth_code_hash" TEXT;

CREATE INDEX "OAuthAccessToken_source_auth_code_hash_idx" ON "OAuthAccessToken"("source_auth_code_hash");
