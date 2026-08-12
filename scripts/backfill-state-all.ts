import { db } from "@/lib/db";

async function main() {
  const clients = await db.client.findMany({
    include: { connections: { where: { platform: "INSTAGRAM" } } },
    orderBy: { name: "asc" },
  });
  for (const client of clients) {
    const conn = client.connections[0];
    if (!conn) continue;
    console.log(JSON.stringify({
      client: client.name,
      historical: conn.historicalBackfillStatus,
      historicalProcessed: conn.historicalBackfillProcessedPosts,
      collab: conn.collaborativeBackfillStatus,
      collabProcessed: conn.collaborativeBackfillProcessedPosts,
      lastSuccessful: conn.lastSuccessfulSyncAt,
    }));
  }
  await db.$disconnect();
}

main().catch(console.error);
