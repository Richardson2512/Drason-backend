-- Billing audit B1: track when each org's subscription state was last
-- reconciled against Polar so the periodic reconciler doesn't re-hit
-- Polar's API for already-current rows. Additive, non-destructive.
ALTER TABLE "Organization" ADD COLUMN "polar_reconciled_at" TIMESTAMP(3);
