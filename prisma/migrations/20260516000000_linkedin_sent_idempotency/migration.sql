-- LinkedIn step at-most-once. The data-layer guarantee that a given
-- LinkedIn sequence step is DELIVERED to a given lead at most once -
-- the LinkedIn analogue of SendEvent's per-(campaign_lead_id,
-- step_number) uniqueness for email.
--
-- PARTIAL on status = 'SENT' on purpose. SequenceStepExecution is
-- multi-row-per-step by design: a step may produce repeated SKIPPED
-- rows (no sender capacity / outside working hours -> retried next
-- cycle), a BRANCHED row, and SCHEDULED/FAILED attempt rows. Only the
-- successful delivery (status='SENT') must be unique. A naive unique on
-- (campaign_lead_id, step_number) would wrongly reject the legitimate
-- skip-then-send retry pattern.
--
-- Enforcement point: markSent() flips a SCHEDULED row to SENT; if a
-- sibling SENT row already exists for the same (lead, step) - a stalled
-- job re-run or two concurrent ticks that both cleared the pre-dispatch
-- guard - that UPDATE raises 23505 (Prisma P2002), which the audit
-- writer treats as "already delivered" (no double count, no markFailed).
--
-- IF NOT EXISTS so re-application (local vs deploy ordering) is safe.
CREATE UNIQUE INDEX IF NOT EXISTS "SequenceStepExecution_lead_step_sent_key"
  ON "SequenceStepExecution" ("campaign_lead_id", "step_number")
  WHERE status = 'SENT';
