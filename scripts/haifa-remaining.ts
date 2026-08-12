import { db } from "@/lib/db";

async function main() {
  const client = await db.client.findFirst({
    where: { name: { contains: "مستشفى" } },
    include: { connections: { where: { platform: "INSTAGRAM" } } },
  });
  if (!client) return;
  const conn = client.connections[0];
  const total = await db.socialPost.count({ where: { connectionId: conn.id } });
  const july = await db.socialPost.count({
    where: {
      connectionId: conn.id,
      publishedAt: { gte: new Date(Date.UTC(2026, 6, 1)), lte: new Date(Date.UTC(2026, 6, 31, 23, 59, 59)) },
    },
  });
  const owned = await db.socialPost.count({ where: { connectionId: conn.id, mediaSource: "OWNED" } });
  const collab = await db.socialPost.count({ where: { connectionId: conn.id, mediaSource: "COLLABORATIVE" } });
  console.log(JSON.stringify({ client: client.name, totalPosts: total, julyPosts: july, owned, collab, historicalProcessed: conn.historicalBackfillProcessedPosts, collabProcessed: conn.collaborativeBackfillProcessedPosts }, null, 2));
  await db.$disconnect();
}

main().catch(console.error);
