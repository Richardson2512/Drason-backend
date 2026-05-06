-- Partial-unique refactor for workspace-scoped emails and one-seed-per-account.
--
-- Before: User.email had a global UNIQUE constraint, blocking the same client
-- email from being invited to multiple workspaces (Option B). The completeInvite
-- code worked around this by appending a +scoped-<id> suffix on collision.
--
-- After: emails are unique per scope.
--   * Agency-side users (scoped_organization_id IS NULL): email globally unique.
--   * Client users (scoped_organization_id IS NOT NULL): email unique within
--     the workspace they are scoped to.
-- This lets bob@client.com exist in workspace A and workspace B independently.
--
-- Also: enforces at most one is_seed=true Organization per Account at the DB
-- level (was previously only enforced in code).

-- Drop the legacy global unique on User.email.
DROP INDEX IF EXISTS "User_email_key";

-- Agency-side users: email must be globally unique among non-scoped users.
CREATE UNIQUE INDEX "User_email_agency_unique"
    ON "User" (email)
    WHERE scoped_organization_id IS NULL;

-- Client users: email must be unique within the workspace they are scoped to.
CREATE UNIQUE INDEX "User_email_workspace_unique"
    ON "User" (scoped_organization_id, email)
    WHERE scoped_organization_id IS NOT NULL;

-- Each Account gets at most one seed Organization.
CREATE UNIQUE INDEX "Organization_one_seed_per_account"
    ON "Organization" (account_id)
    WHERE is_seed = true;
