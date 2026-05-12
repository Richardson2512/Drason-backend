-- Super Sender — DedicatedIp model. See schema.prisma for the state-machine
-- docstring. Account-level pool, workspace-allocated, Polar-billed.

CREATE TABLE "DedicatedIp" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "organization_id" TEXT,
    "polar_subscription_id" TEXT,
    "polar_checkout_id" TEXT,
    "ses_pool_name" TEXT,
    "ses_ip_address" TEXT,
    "state" TEXT NOT NULL DEFAULT 'pending_payment',
    "warmup_day" INTEGER NOT NULL DEFAULT 0,
    "daily_cap" INTEGER NOT NULL DEFAULT 50,
    "activated_at" TIMESTAMP(3),
    "warmup_completed_at" TIMESTAMP(3),
    "canceled_at" TIMESTAMP(3),
    "last_reassigned_at" TIMESTAMP(3),
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DedicatedIp_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DedicatedIp_polar_checkout_id_key" ON "DedicatedIp"("polar_checkout_id");
CREATE UNIQUE INDEX "DedicatedIp_ses_pool_name_key" ON "DedicatedIp"("ses_pool_name");

CREATE INDEX "DedicatedIp_account_id_idx" ON "DedicatedIp"("account_id");
CREATE INDEX "DedicatedIp_organization_id_idx" ON "DedicatedIp"("organization_id");
CREATE INDEX "DedicatedIp_state_idx" ON "DedicatedIp"("state");
CREATE INDEX "DedicatedIp_polar_subscription_id_idx" ON "DedicatedIp"("polar_subscription_id");

ALTER TABLE "DedicatedIp"
    ADD CONSTRAINT "DedicatedIp_account_id_fkey"
    FOREIGN KEY ("account_id") REFERENCES "Account"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "DedicatedIp"
    ADD CONSTRAINT "DedicatedIp_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "Organization"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
