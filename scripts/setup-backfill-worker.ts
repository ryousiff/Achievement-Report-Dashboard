import { db } from "@/lib/db";
import { holdIncrementalMediaSyncJobs, setMetaAppCooldownUntil, enqueueHistoricalBackfill } from "@/lib/sync-queue";

const clientNames = ["مبرة الكوهجي", "مستشفى الدكتورة هيفاء"];

async function main() {
  // 1. Hold all pending INCREMENTAL_MEDIA_SYNC jobs so they don't compete for the app budget.
  const holdUntil = await holdIncrementalMediaSyncJobs(new Date(Date.now() + 6 * 60 * 60 * 1000));
  console.log(`Held incremental media sync jobs until ${holdUntil.toISOString()}`);

  // 2. Set an initial Meta app-level cooldown (5 minutes) so the worker does not call Meta immediately.
  const cooldownUntil = await setMetaAppCooldownUntil(5 * 60 * 1000);
  console.log(`Initial Meta cooldown set until ${cooldownUntil.toISOString()}`);

  // 3. Enqueue historical backfills for the two target clients.
  const clients = await db.client.findMany({
    where: { name: { in: clientNames } },
    include: { connections: { where: { platform: "INSTAGRAM" } } },
  });
  for (const client of clients) {
    const connection = client.connections[0];
    if (!connection) continue;
    const jobs = await enqueueHistoricalBackfill(connection.id);
    console.log(`Enqueued ${jobs.length} backfill job(s) for ${client.name} (${connection.id}): ${jobs.map((j) => `${j.type}=${j.id}`).join(", ")}`);
  }

  await db.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
