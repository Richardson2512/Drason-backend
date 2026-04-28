-- Compliance-driven schema additions:
--   Lead.unsubscribed_at + reason   — org-wide suppression (CAN-SPAM, CASL, GDPR Art. 21)
--   Lead.bounced_at                 — hard-bounce auto-suppression timestamp
--   Organization.mailing_address    — CAN-SPAM § 5(a)(5) postal address
--   Campaign.eu_compliance_mode     — ePrivacy-friendly tracking disclosure

ALTER TABLE "Lead"
    ADD COLUMN "unsubscribed_at"     TIMESTAMP(3),
    ADD COLUMN "unsubscribed_reason" TEXT,
    ADD COLUMN "bounced_at"          TIMESTAMP(3);

ALTER TABLE "Organization"
    ADD COLUMN "mailing_address"            TEXT,
    ADD COLUMN "mailing_address_updated_at" TIMESTAMP(3);

ALTER TABLE "Campaign"
    ADD COLUMN "eu_compliance_mode" BOOLEAN DEFAULT false;
