import { processNextSyncJob, recoverStalledHistoricalBackfills, runDueDailyClientSync, runDueMonthlyReportPreparation, runDueThumbnailBackfill } from "./lib/sync-queue";
import { getSchedulerConfig, getThumbnailBackfillConfig } from "./lib/env";

const pollMs = Number(process.env.SYNC_WORKER_POLL_MS ?? 5000);
const { dailyClientSyncCheckIntervalMs, monthlyReportPrepIntervalMs } = getSchedulerConfig();
const { checkIntervalMs: thumbnailBackfillCheckIntervalMs } = getThumbnailBackfillConfig();
const stalledHistoricalBackfillRecoveryIntervalMs = 5 * 60 * 1000; // 5 minutes

let isDraining = false;

async function poll() {
  if (isDraining) return;
  isDraining = true;
  try {
    while (await processNextSyncJob()) {}
  } catch (error) {
    console.error("Sync worker error:", error instanceof Error ? error.message : error);
  } finally {
    isDraining = false;
  }
}

async function startPolling() {
  while (true) {
    await poll();
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

// Periodically checks whether the daily automatic incremental sync is due (see runDueDailyClientSync);
// this only ever queues normal INCREMENTAL_MEDIA_SYNC/DAILY_ACCOUNT_INSIGHT_SYNC jobs, never the deep
// historical backfill, which stays a separate, explicit, admin-only action.
async function maybeRunDailyClientSync() {
  try {
    await runDueDailyClientSync();
  } catch (error) {
    console.error("Daily client sync error:", error instanceof Error ? error.message : error);
  }
}

// Periodically checks for posts still missing a permanently-stored thumbnail (see
// src/lib/media-backfill.ts) and enqueues low-priority THUMBNAIL_BACKFILL jobs to catch them up; this
// never runs a manual per-client script, and each job only processes a small, resumable batch.
async function maybeRunThumbnailBackfill() {
  try {
    await runDueThumbnailBackfill();
  } catch (error) {
    console.error("Thumbnail backfill check error:", error instanceof Error ? error.message : error);
  }
}

void startPolling();

void maybeRunDailyClientSync();
setInterval(() => { void maybeRunDailyClientSync(); }, dailyClientSyncCheckIntervalMs);

// Periodically detect Instagram connections whose historical or collaborative backfill is stuck
// in PARTIAL/RUNNING without a corresponding active SyncJob, and enqueue exactly one resumption
// job per gap. This is the worker/scheduler's responsibility — never the employee's "refresh status"
// button.
async function maybeRecoverStalledHistoricalBackfills() {
  try {
    await recoverStalledHistoricalBackfills();
  } catch (error) {
    console.error("Stalled historical backfill recovery error:", error instanceof Error ? error.message : error);
  }
}

void maybeRunThumbnailBackfill();
setInterval(() => { void maybeRunThumbnailBackfill(); }, thumbnailBackfillCheckIntervalMs);

void maybeRecoverStalledHistoricalBackfills();
setInterval(() => { void maybeRecoverStalledHistoricalBackfills(); }, stalledHistoricalBackfillRecoveryIntervalMs);

// Continuously prepare the current calendar month and, once the month ends, prioritize closing it out
// so employees can approve/export reports without waiting for a manual historical sync.
async function maybeRunMonthlyReportPreparation() {
  try {
    await runDueMonthlyReportPreparation();
  } catch (error) {
    console.error("Monthly report preparation error:", error instanceof Error ? error.message : error);
  }
}

void maybeRunMonthlyReportPreparation();
setInterval(() => { void maybeRunMonthlyReportPreparation(); }, monthlyReportPrepIntervalMs);
