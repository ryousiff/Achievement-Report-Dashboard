import { db } from "@/lib/db";
import { processNextSyncJob } from "@/lib/sync-queue";

async function main() {
  const now = new Date();
  const updated = await db.syncJob.updateMany({
    where: { status: "QUEUED", type: "HISTORICAL_MEDIA_BACKFILL" },
    data: { runAfter: now },
  });
  console.log(`Made ${updated.count} backfill jobs due at ${now.toISOString()}`);

  const result = await processNextSyncJob();
  console.log("processNextSyncJob result:", JSON.stringify(result, null, 2));

  const job = await db.syncJob.findFirst({
    where: { type: "HISTORICAL_MEDIA_BACKFILL" },
    orderBy: { createdAt: "desc" },
    select: { id: true, status: true, attempts: true, runAfter: true, lastError: true },
  });
  const setting = await db.setting.findUnique({ where: { moduleId_key: { moduleId: "meta_cooldown", key: "cooldown_until" } } });
  const attempts = await db.setting.findUnique({ where: { moduleId_key: { moduleId: "meta_cooldown", key: "consecutive_rate_limits" } } });
  console.log("After job:", JSON.stringify({ job, cooldown: setting?.value, consecutive: attempts?.value }, null, 2));

  await db.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
