-- Drop the per-tier capacity counters from Organization. Pricing now meters
-- only monthly send volume + validation credits; protection coverage is
-- unmetered so every connected lead/domain/mailbox gets the full state-machine
-- + DNSBL + healing pipeline regardless of subscription tier.
ALTER TABLE "Organization"
    DROP COLUMN "current_lead_count",
    DROP COLUMN "current_domain_count",
    DROP COLUMN "current_mailbox_count";
