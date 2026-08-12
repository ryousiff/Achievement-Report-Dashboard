import { db } from "@/lib/db";
import { parsePeriodArgs, clientMatchesFilter } from "./lib/period-args";

async function main() {
  const { periodStart, periodEnd, clients: clientFilter } = parsePeriodArgs();

  const clients = await db.client.findMany({
    where: { active: true },
    select: { id: true, name: true, connections: { where: { platform: "INSTAGRAM" }, select: { id: true } } },
  });

  for (const client of clients) {
    if (!clientMatchesFilter(client.name, clientFilter)) continue;
    const connection = client.connections[0];
    if (!connection) continue;

    const snapshots = await db.socialInsightSnapshot.groupBy({
      by: ["metric"],
      where: {
        connectionId: connection.id,
        periodEnd: { gte: periodStart, lte: periodEnd },
      },
      _sum: { value: true },
    });

    const posts = await db.socialPost.count({
      where: {
        connectionId: connection.id,
        publishedAt: { gte: periodStart, lte: periodEnd },
      },
    });

    console.log(JSON.stringify({
      client: client.name,
      posts,
      snapshots: Object.fromEntries(snapshots.map((s) => [s.metric, s._sum.value])),
    }, null, 2));
  }

  await db.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
