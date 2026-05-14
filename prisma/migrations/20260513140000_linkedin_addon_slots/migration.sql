-- LinkedIn account-slot add-ons.
--
-- Effective LinkedIn account cap for an org =
--   base_limit_for_tier(subscription_tier) + linkedin_account_addon_count
--
-- Base limits (see services/linkedin/accountLimitService.ts):
--   pro    → 1
--   growth → 2
--   scale  → 3
--   trial / starter → 1 (parity with pro for the trial experience)
--   enterprise → 5
--
-- Each add-on slot costs $15/mo and adds +1 to the cap.

ALTER TABLE "Organization"
    ADD COLUMN "linkedin_account_addon_count" INTEGER NOT NULL DEFAULT 0;

-- Per-purchase audit so billing reconciliation has a paper trail.
CREATE TABLE "LinkedInAccountAddonPurchase" (
    "id"                  TEXT NOT NULL,
    "organization_id"     TEXT NOT NULL,
    "user_id"             TEXT NOT NULL,
    "quantity"            INTEGER NOT NULL DEFAULT 1,
    "unit_price_usd"      DECIMAL(10,2) NOT NULL DEFAULT 15.00,
    -- status values: 'pending' | 'completed' | 'refunded' | 'failed'
    "status"              TEXT NOT NULL DEFAULT 'completed',
    "polar_checkout_id"   TEXT,
    "polar_subscription_id" TEXT,
    "purchased_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "refunded_at"         TIMESTAMP(3),

    CONSTRAINT "LinkedInAccountAddonPurchase_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "LinkedInAccountAddonPurchase_organization_id_purchased_at_idx"
    ON "LinkedInAccountAddonPurchase"("organization_id", "purchased_at");

ALTER TABLE "LinkedInAccountAddonPurchase"
    ADD CONSTRAINT "LinkedInAccountAddonPurchase_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "Organization"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
