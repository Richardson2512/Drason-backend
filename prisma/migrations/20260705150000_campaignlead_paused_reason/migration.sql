-- Why a CampaignLead pause needs a machine-readable reason:
-- (a) 'mailbox_lost' - the lead's sticky mailbox was permanently disconnected.
--     The dispatcher no longer silently rebinds the lead to a different sender
--     (identity decision, operator must choose restart/continue/stop via
--     POST /api/sequencer/campaigns/:id/resolve-lost-mailbox).
-- (b) 'blank_content' - personalization rendered an empty subject (step 1) or
--     empty body; the blank-email guard pauses instead of sending.
ALTER TABLE "CampaignLead" ADD COLUMN "paused_reason" TEXT;
