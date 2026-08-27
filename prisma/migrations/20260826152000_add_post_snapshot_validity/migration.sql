ALTER TABLE "SocialPostMetricSnapshot"
ADD COLUMN "metricAvailability" JSONB,
ADD COLUMN "validityState" TEXT NOT NULL DEFAULT 'LEGACY_UNVERIFIED',
ADD COLUMN "repairReason" TEXT;
