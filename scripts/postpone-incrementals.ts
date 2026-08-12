import { holdIncrementalMediaSyncJobs } from "@/lib/sync-queue";

async function main() {
  // Set hold to the epoch to effectively clear it; nextInstagramJobRunAfter ignores past holds.
  await holdIncrementalMediaSyncJobs(new Date(0));
  console.log("Cleared incremental hold.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
