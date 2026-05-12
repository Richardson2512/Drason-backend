-- Pre-header (inbox preview text) — see SequenceStep.preheader docstring in
-- schema.prisma. Added to step, variant, and template models so users can
-- author the snippet anywhere a subject + body live.

ALTER TABLE "SequenceStep" ADD COLUMN "preheader" TEXT NOT NULL DEFAULT '';
ALTER TABLE "StepVariant"   ADD COLUMN "preheader" TEXT NOT NULL DEFAULT '';
ALTER TABLE "EmailTemplate" ADD COLUMN "preheader" TEXT NOT NULL DEFAULT '';
