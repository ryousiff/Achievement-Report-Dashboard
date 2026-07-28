import { processNextSyncJob } from "./lib/sync-queue";

const pollMs = Number(process.env.SYNC_WORKER_POLL_MS ?? 5000);

async function poll() {
  try {
    while (await processNextSyncJob()) {}
  } catch (error) {
    console.error("Sync worker error:", error instanceof Error ? error.message : error);
  }
}

void poll();
setInterval(() => { void poll(); }, pollMs);
