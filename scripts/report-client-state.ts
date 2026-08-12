import { db } from "@/lib/db";
import { parsePeriodArgs, clientMatchesFilter } from "./lib/period-args";

async function main() {
  const { periodStart, periodEnd, label, clients: clientFilter } = parsePeriodArgs();

  const clients = await db.client.findMany({
    where: { active: true },
    select: { id: true, name: true, connections: true },
  });

  const matched = clients.filter((c) => clientMatchesFilter(c.name, clientFilter));

  for (const client of matched) {
    const igConnection = client.connections.find((c) => c.platform === "INSTAGRAM");
    const fbConnection = client.connections.find((c) => c.platform === "FACEBOOK");
    const periodPosts = await db.socialPost.count({
      where: { connection: { clientId: client.id }, publishedAt: { gte: periodStart, lte: periodEnd } },
    });
    console.log(JSON.stringify({
      clientId: client.id,
      name: client.name,
      period: label,
      periodPosts,
      instagram: igConnection ? {
        connectionId: igConnection.id,
        externalAccountId: igConnection.externalAccountId,
        displayName: igConnection.displayName,
        lastSuccessfulSyncAt: igConnection.lastSuccessfulSyncAt,
        lastIncrementalSyncAt: igConnection.lastIncrementalSyncAt,
        historicalBackfillStatus: igConnection.historicalBackfillStatus,
        collaborativeBackfillStatus: igConnection.collaborativeBackfillStatus,
      } : null,
      facebook: fbConnection ? {
        connectionId: fbConnection.id,
        externalAccountId: fbConnection.externalAccountId,
        displayName: fbConnection.displayName,
      } : null,
    }, null, 2));
  }

  await db.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
