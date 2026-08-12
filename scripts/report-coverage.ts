import { db } from "@/lib/db";
import { getCoverage } from "@/lib/report-coverage";
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
    if (!connection) {
      console.log(JSON.stringify({ client: client.name, status: "no_instagram" }));
      continue;
    }
    const coverage = await getCoverage(connection.id, periodStart, periodEnd);
    console.log(JSON.stringify({
      client: client.name,
      status: coverage.status,
      mediaComplete: coverage.mediaCoverage.complete,
      postInsightsAvailable: coverage.postInsightCoverage.availableMetrics,
      postInsightsMissing: coverage.postInsightCoverage.missingMetrics,
      reachStatus: coverage.reachStatus,
      reachComplete: coverage.reachCoverage.complete,
      followerStatus: coverage.followerStatus,
      followerCountComplete: coverage.followerCountCoverage.complete,
      historicalBackfill: coverage.historicalBackfillStatus,
      collaborativeBackfill: coverage.collaborativeBackfillStatus,
      warnings: coverage.warnings,
    }, null, 2));
  }

  await db.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
