-- CreateEnum
CREATE TYPE "SubmissionTrigger" AS ENUM ('MANUAL', 'AUTO_DEADLINE');

-- AlterTable
-- Additive with a default, so every existing row keeps the only meaning it
-- could have had: nothing but a candidate pressing Submit could produce one.
ALTER TABLE "submissions" ADD COLUMN "trigger" "SubmissionTrigger" NOT NULL DEFAULT 'MANUAL';
