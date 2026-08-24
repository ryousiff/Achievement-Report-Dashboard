-- CreateEnum
CREATE TYPE "Platform" AS ENUM ('INSTAGRAM', 'FACEBOOK', 'TIKTOK', 'LINKEDIN', 'YOUTUBE', 'X');

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'EDITOR', 'VIEWER');

-- CreateEnum
CREATE TYPE "ReportStatus" AS ENUM ('DRAFT', 'NEEDS_REVIEW', 'APPROVED', 'EXPORTED');

-- CreateEnum
CREATE TYPE "BlockType" AS ENUM ('TEXT', 'KPI', 'CHART', 'PLATFORM_ANALYTICS', 'MEDIA', 'NOTES', 'RECOMMENDATIONS');

-- CreateEnum
CREATE TYPE "SyncJobStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "SyncRunStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "SyncJobType" AS ENUM ('INCREMENTAL_MEDIA_SYNC', 'HISTORICAL_MEDIA_BACKFILL', 'HISTORICAL_COLLABORATIVE_BACKFILL', 'RECENT_POST_INSIGHT_REFRESH', 'DAILY_ACCOUNT_INSIGHT_SYNC', 'STORY_SYNC', 'THUMBNAIL_BACKFILL', 'MONTH_END_CLOSEOUT');

-- CreateEnum
CREATE TYPE "BackfillStatus" AS ENUM ('NOT_STARTED', 'RUNNING', 'PARTIAL', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "MediaSource" AS ENUM ('OWNED', 'COLLABORATIVE');

-- CreateEnum
CREATE TYPE "InsightPeriodType" AS ENUM ('DAY', 'WEEK', 'DAYS_28', 'TOTAL_VALUE');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "passwordHash" TEXT,
    "role" "Role" NOT NULL DEFAULT 'EDITOR',
    "googleRefreshToken" TEXT,
    "googleTokenExpiresAt" TIMESTAMP(3),
    "googleSubject" TEXT,
    "googleEmail" TEXT,
    "googleWorkspaceDomain" TEXT,
    "googleIdentityLinkedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Client" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "logoUrl" TEXT,
    "driveFolderId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Client_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MetaProfile" (
    "id" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "tokenExpiresAt" TIMESTAMP(3),
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MetaProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MetaAccount" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "externalAccountId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "encryptedToken" TEXT NOT NULL,
    "tokenExpiresAt" TIMESTAMP(3),
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MetaAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SocialConnection" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "sourceAccountId" TEXT,
    "platform" "Platform" NOT NULL,
    "externalAccountId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "encryptedToken" TEXT NOT NULL,
    "tokenExpiresAt" TIMESTAMP(3),
    "lastSyncedAt" TIMESTAMP(3),
    "lastSuccessfulSyncAt" TIMESTAMP(3),
    "lastFailedSyncAt" TIMESTAMP(3),
    "lastFailureReason" TEXT,
    "syncLockedUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "historicalBackfillStatus" "BackfillStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "historicalBackfillStart" TIMESTAMP(3),
    "historicalBackfillCursor" TEXT,
    "historicalBackfillPageIndex" INTEGER,
    "historicalBackfillStartedAt" TIMESTAMP(3),
    "historicalBackfillCompletedAt" TIMESTAMP(3),
    "historicalBackfillLastError" TEXT,
    "historicalBackfillRetryCount" INTEGER NOT NULL DEFAULT 0,
    "historicalBackfillProcessedPosts" INTEGER NOT NULL DEFAULT 0,
    "collaborativeBackfillStatus" "BackfillStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "collaborativeBackfillStart" TIMESTAMP(3),
    "collaborativeBackfillCursor" TEXT,
    "collaborativeBackfillPageIndex" INTEGER NOT NULL DEFAULT 0,
    "collaborativeBackfillStartedAt" TIMESTAMP(3),
    "collaborativeBackfillCompletedAt" TIMESTAMP(3),
    "collaborativeBackfillLastError" TEXT,
    "collaborativeBackfillRetryCount" INTEGER NOT NULL DEFAULT 0,
    "collaborativeBackfillProcessedPosts" INTEGER NOT NULL DEFAULT 0,
    "lastIncrementalSyncAt" TIMESTAMP(3),
    "lastIncrementalSyncError" TEXT,
    "reachCoverageStart" TIMESTAMP(3),
    "reachWeekCoverageStart" TIMESTAMP(3),
    "reachDays28CoverageStart" TIMESTAMP(3),
    "followerCountCoverageStart" TIMESTAMP(3),
    "accountInsightsLastSyncedAt" TIMESTAMP(3),
    "accountInsightsBackfillCompletedAt" TIMESTAMP(3),
    "accountInsightsLastError" TEXT,
    "storyCoverageStart" TIMESTAMP(3),

    CONSTRAINT "SocialConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SocialPost" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "externalPostId" TEXT NOT NULL,
    "caption" TEXT,
    "mediaType" TEXT NOT NULL,
    "mediaUrl" TEXT,
    "thumbnailUrl" TEXT,
    "thumbnailStorageKey" TEXT,
    "permalink" TEXT,
    "publishedAt" TIMESTAMP(3) NOT NULL,
    "mediaSource" "MediaSource" NOT NULL DEFAULT 'OWNED',
    "mediaMetadata" JSONB,
    "metrics" JSONB NOT NULL,
    "metricAvailability" JSONB,
    "metricAvailabilityState" JSONB,
    "lastInsightRefreshAt" TIMESTAMP(3),
    "syncedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SocialPost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SocialPostMetricSnapshot" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "views" INTEGER NOT NULL DEFAULT 0,
    "totalViews" INTEGER,
    "totalInteractions" INTEGER NOT NULL DEFAULT 0,
    "likes" INTEGER NOT NULL DEFAULT 0,
    "comments" INTEGER NOT NULL DEFAULT 0,
    "saved" INTEGER NOT NULL DEFAULT 0,
    "shares" INTEGER NOT NULL DEFAULT 0,
    "follows" INTEGER NOT NULL DEFAULT 0,
    "finalizedAt" TIMESTAMP(3),
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SocialPostMetricSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SponsoredAd" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "socialPostId" TEXT,
    "title" TEXT,
    "postUrl" TEXT,
    "actualSpend" DECIMAL(12,3) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'BHD',
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "budgetYear" INTEGER NOT NULL,
    "budgetMonth" INTEGER NOT NULL,
    "metaAdAccountId" TEXT,
    "metaAdId" TEXT,
    "paidReach" INTEGER,
    "impressions" INTEGER,
    "clicks" INTEGER,
    "ctr" DOUBLE PRECISION,
    "cpc" DOUBLE PRECISION,
    "cpm" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SponsoredAd_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClientAdBudget" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "plannedBudget" DECIMAL(12,3) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'BHD',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClientAdBudget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SocialInsightSnapshot" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "periodType" "InsightPeriodType" NOT NULL DEFAULT 'DAY',
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SocialInsightSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncJob" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "type" "SyncJobType" NOT NULL DEFAULT 'INCREMENTAL_MEDIA_SYNC',
    "status" "SyncJobStatus" NOT NULL DEFAULT 'QUEUED',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "runAfter" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SyncJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncRun" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "status" "SyncRunStatus" NOT NULL DEFAULT 'RUNNING',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "postsSynced" INTEGER NOT NULL DEFAULT 0,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SyncRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Report" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "status" "ReportStatus" NOT NULL DEFAULT 'DRAFT',
    "isBlank" BOOLEAN NOT NULL DEFAULT false,
    "orientation" TEXT NOT NULL DEFAULT 'landscape',
    "approvalOverrideReason" TEXT,
    "dataRefreshedAt" TIMESTAMP(3),
    "coverageStatus" TEXT,
    "coverageWarnings" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Report_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReportVersion" (
    "id" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReportVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReportExport" (
    "id" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "orientation" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'EXPORTED',
    "fileUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReportExport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReportBlock" (
    "id" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "type" "BlockType" NOT NULL,
    "position" INTEGER NOT NULL,
    "content" JSONB NOT NULL,

    CONSTRAINT "ReportBlock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Setting" (
    "id" TEXT NOT NULL,
    "moduleId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Setting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "resourceId" TEXT,
    "details" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_googleSubject_key" ON "User"("googleSubject");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_expiresAt_idx" ON "Session"("userId", "expiresAt");

-- CreateIndex
CREATE INDEX "MetaProfile_createdById_idx" ON "MetaProfile"("createdById");

-- CreateIndex
CREATE INDEX "MetaAccount_platform_externalAccountId_idx" ON "MetaAccount"("platform", "externalAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "MetaAccount_profileId_platform_externalAccountId_key" ON "MetaAccount"("profileId", "platform", "externalAccountId");

-- CreateIndex
CREATE INDEX "SocialConnection_sourceAccountId_idx" ON "SocialConnection"("sourceAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "SocialConnection_clientId_platform_externalAccountId_key" ON "SocialConnection"("clientId", "platform", "externalAccountId");

-- CreateIndex
CREATE INDEX "SocialPost_connectionId_publishedAt_idx" ON "SocialPost"("connectionId", "publishedAt");

-- CreateIndex
CREATE UNIQUE INDEX "SocialPost_connectionId_externalPostId_key" ON "SocialPost"("connectionId", "externalPostId");

-- CreateIndex
CREATE INDEX "SocialPostMetricSnapshot_periodStart_periodEnd_idx" ON "SocialPostMetricSnapshot"("periodStart", "periodEnd");

-- CreateIndex
CREATE UNIQUE INDEX "SocialPostMetricSnapshot_postId_periodStart_periodEnd_key" ON "SocialPostMetricSnapshot"("postId", "periodStart", "periodEnd");

-- CreateIndex
CREATE INDEX "SponsoredAd_clientId_startDate_idx" ON "SponsoredAd"("clientId", "startDate");

-- CreateIndex
CREATE INDEX "SponsoredAd_clientId_budgetYear_budgetMonth_idx" ON "SponsoredAd"("clientId", "budgetYear", "budgetMonth");

-- CreateIndex
CREATE INDEX "SponsoredAd_socialPostId_idx" ON "SponsoredAd"("socialPostId");

-- CreateIndex
CREATE UNIQUE INDEX "ClientAdBudget_clientId_year_month_key" ON "ClientAdBudget"("clientId", "year", "month");

-- CreateIndex
CREATE INDEX "SocialInsightSnapshot_connectionId_periodType_periodStart_p_idx" ON "SocialInsightSnapshot"("connectionId", "periodType", "periodStart", "periodEnd");

-- CreateIndex
CREATE UNIQUE INDEX "SocialInsightSnapshot_connectionId_metric_periodType_period_key" ON "SocialInsightSnapshot"("connectionId", "metric", "periodType", "periodStart", "periodEnd");

-- CreateIndex
CREATE INDEX "SyncJob_status_priority_runAfter_idx" ON "SyncJob"("status", "priority", "runAfter");

-- CreateIndex
CREATE INDEX "SyncJob_connectionId_type_status_idx" ON "SyncJob"("connectionId", "type", "status");

-- CreateIndex
CREATE INDEX "SyncRun_connectionId_createdAt_idx" ON "SyncRun"("connectionId", "createdAt");

-- CreateIndex
CREATE INDEX "SyncRun_jobId_idx" ON "SyncRun"("jobId");

-- CreateIndex
CREATE INDEX "ReportVersion_reportId_createdAt_idx" ON "ReportVersion"("reportId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ReportVersion_reportId_number_key" ON "ReportVersion"("reportId", "number");

-- CreateIndex
CREATE INDEX "ReportExport_reportId_createdAt_idx" ON "ReportExport"("reportId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ReportBlock_reportId_position_key" ON "ReportBlock"("reportId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "Setting_moduleId_key_key" ON "Setting"("moduleId", "key");

-- CreateIndex
CREATE INDEX "AuditLog_resource_resourceId_idx" ON "AuditLog"("resource", "resourceId");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MetaAccount" ADD CONSTRAINT "MetaAccount_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "MetaProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialConnection" ADD CONSTRAINT "SocialConnection_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialConnection" ADD CONSTRAINT "SocialConnection_sourceAccountId_fkey" FOREIGN KEY ("sourceAccountId") REFERENCES "MetaAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialPost" ADD CONSTRAINT "SocialPost_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "SocialConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialPostMetricSnapshot" ADD CONSTRAINT "SocialPostMetricSnapshot_postId_fkey" FOREIGN KEY ("postId") REFERENCES "SocialPost"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SponsoredAd" ADD CONSTRAINT "SponsoredAd_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SponsoredAd" ADD CONSTRAINT "SponsoredAd_socialPostId_fkey" FOREIGN KEY ("socialPostId") REFERENCES "SocialPost"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientAdBudget" ADD CONSTRAINT "ClientAdBudget_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialInsightSnapshot" ADD CONSTRAINT "SocialInsightSnapshot_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "SocialConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SyncJob" ADD CONSTRAINT "SyncJob_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "SocialConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SyncRun" ADD CONSTRAINT "SyncRun_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "SyncJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SyncRun" ADD CONSTRAINT "SyncRun_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "SocialConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Report" ADD CONSTRAINT "Report_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Report" ADD CONSTRAINT "Report_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReportVersion" ADD CONSTRAINT "ReportVersion_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "Report"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReportExport" ADD CONSTRAINT "ReportExport_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "Report"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReportBlock" ADD CONSTRAINT "ReportBlock_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "Report"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

