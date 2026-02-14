-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "assessment_completed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "transition_acknowledged" BOOLEAN NOT NULL DEFAULT false;
