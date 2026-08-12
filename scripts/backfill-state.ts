import { db } from "@/lib/db";

async function main() {
  const clientNames = ["مبرة الكوهجي", "مستشفى الدكتورة هيفاء"];
  const clients = await db.client.findMany({
    where: { name: { in: clientNames } },
    include: { connections: { where: { platform: "INSTAGRAM" } } },
  });
  for (const client of clients) {
    const connection = client.connections[0];
    if (!connection) continue;
    console.log(JSON.stringify({
      client: client.name,
      historicalBackfillStatus: connection.historicalBackfillStatus,
      historicalBackfillProcessedPosts: connection.historicalBackfillProcessedPosts,
      collaborativeBackfillStatus: connection.collaborativeBackfillStatus,
      collaborativeBackfillProcessedPosts: connection.collaborativeBackfillProcessedPosts,
    }, null, 2));
  }
  await db.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
