-- Billing audit B1: the Polar reconciler pulls subscription state on a cadence
-- to correct drift when a webhook is lost/delayed. This column records the last
-- reconcile time so the worker skips orgs already checked within the window.
-- Non-destructive: one nullable column.
ALTER TABLE "Organization" ADD COLUMN "polar_reconciled_at" TIMESTAMP(3);
