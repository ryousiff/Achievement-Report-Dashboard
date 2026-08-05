import { processNextSyncJob, runDueDailyClientSync } from "./lib/sync-queue";
import { getSchedulerConfig } from "./lib/env";

const pollMs = Number(process.env.SYNC_WORKER_POLL_MS ?? 5000);
const { dailyClientSyncCheckIntervalMs } = getSchedulerConfig();

async function poll() {
  try {
    while (await processNextSyncJob()) {}
  } catch (error) {
    console.error("Sync worker error:", error instanceof Error ? error.message : error);
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

void poll();
setInterval(() => { void poll(); }, pollMs);

void maybeRunDailyClientSync();
setInterval(() => { void maybeRunDailyClientSync(); }, dailyClientSyncCheckIntervalMs);
