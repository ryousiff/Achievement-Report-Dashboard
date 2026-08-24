-- AlterEnum
ALTER TYPE "SyncJobType" ADD VALUE 'REPORT_PERIOD_CLOSEOUT';

-- AlterTable
ALTER TABLE "SyncJob" ADD COLUMN     "payload" JSONB;
