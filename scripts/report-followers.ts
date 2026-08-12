import { db } from "@/lib/db";
import { periodAccountFollowers } from "@/lib/report-data";
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

    const followers = await periodAccountFollowers(client.id, periodStart, periodEnd);
    console.log(JSON.stringify({
      client: client.name,
      periodStart: periodStart.toISOString(),
      periodEnd: periodEnd.toISOString(),
      gained: followers.gained,
      lost: followers.lost,
      net: followers.net,
      accuracy: followers.accuracy,
      method: followers.method,
    }, null, 2));
  }

  await db.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
