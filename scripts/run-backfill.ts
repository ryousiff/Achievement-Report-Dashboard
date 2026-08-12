import { db } from "@/lib/db";
import { BackfillStatus } from "@prisma/client";
import { runHistoricalBackfillChunk, runHistoricalCollaborativeBackfillChunk } from "@/lib/meta-sync";

const clientNames = ["مبرة الكوهجي", "مستشفى الدكتورة هيفاء"];

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function backfillConnection(connectionId: string, source: "owned" | "collaborative") {
  const start = Date.now();
  const maxMs = 120_000; // 2 minutes per source per connection
  let completed = false;
  let chunks = 0;
  let posts = 0;
  while (!completed && Date.now() - start < maxMs) {
    try {
      const result = source === "owned"
        ? await runHistoricalBackfillChunk(connectionId)
        : await runHistoricalCollaborativeBackfillChunk(connectionId);
      chunks += 1;
      posts += result.posts;
      completed = result.completed;
      if (!completed) await sleep(500);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Backfill ${source} chunk failed for ${connectionId}: ${message}`);
      break;
    }
  }
  return { source, chunks, posts, completed, timedOut: !completed };
}

async function main() {
  const clients = await db.client.findMany({
    where: { name: { in: clientNames } },
    include: { connections: { where: { platform: "INSTAGRAM" } } },
  });

  for (const client of clients) {
    const connection = client.connections[0];
    if (!connection) continue;
    console.log(`\n=== ${client.name} (${connection.id}) ===`);
    const owned = connection.historicalBackfillStatus !== BackfillStatus.COMPLETED
      ? await backfillConnection(connection.id, "owned")
      : { source: "owned", completed: true, skipped: true };
    const collab = connection.collaborativeBackfillStatus !== BackfillStatus.COMPLETED
      ? await backfillConnection(connection.id, "collaborative")
      : { source: "collaborative", completed: true, skipped: true };
    console.log(JSON.stringify({ client: client.name, owned, collab }, null, 2));
  }

  await db.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
