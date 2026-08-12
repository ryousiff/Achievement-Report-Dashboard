import { db } from "@/lib/db";
import { processNextSyncJob, setMetaAppCooldownUntil } from "@/lib/sync-queue";

async function main() {
  const beforeJobs = await db.syncJob.findMany({
    where: { status: "QUEUED", connection: { platform: "INSTAGRAM" } },
    orderBy: { createdAt: "asc" },
    take: 5,
    select: { id: true, type: true, runAfter: true, connection: { select: { client: { select: { name: true } } } } },
  });
  console.log("Before:", JSON.stringify({ now: new Date().toISOString(), cooldown: (await db.setting.findUnique({ where: { moduleId_key: { moduleId: "meta_cooldown", key: "cooldown_until" } } }))?.value, jobs: beforeJobs }, null, 2));

  const until = await setMetaAppCooldownUntil(5 * 60 * 1000);
  console.log("Set cooldown until", until.toISOString());

  const result = await processNextSyncJob();
  console.log("processNextSyncJob result:", JSON.stringify(result, null, 2));

  const afterJobs = await db.syncJob.findMany({
    where: { status: "QUEUED", connection: { platform: "INSTAGRAM" } },
    orderBy: { createdAt: "asc" },
    take: 5,
    select: { id: true, type: true, runAfter: true, connection: { select: { client: { select: { name: true } } } } },
  });
  console.log("After:", JSON.stringify({ jobs: afterJobs }, null, 2));

  await db.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
