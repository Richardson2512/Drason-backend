-- Migration strategy + recent-contact toggle for ImportJob.
-- conservative (default) preserves prior behaviour: only never-contacted leads.
-- aggressive lets the customer fully decommission Smartlead by restarting
-- in-flight leads at step 1 in Superkabe.
ALTER TABLE "ImportJob"
    ADD COLUMN "mode"                    TEXT    NOT NULL DEFAULT 'conservative',
    ADD COLUMN "include_recent_contacts" BOOLEAN NOT NULL DEFAULT false;
