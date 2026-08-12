import { db } from "@/lib/db";
import { reportPosts, periodAccountReachForRange, periodAccountViewsForRange, periodAccountFollowersForRange } from "@/lib/report-data";
import { getCoverage } from "@/lib/report-coverage";
import { parsePeriodArgs, clientMatchesFilter } from "./lib/period-args";

function fmt(n: number | null) {
  if (n === null || n === undefined) return "—";
  return n.toLocaleString("en-US");
}

function status(n: number | null) {
  return n === null || n === undefined ? "UNAVAILABLE" : n.toLocaleString("en-US");
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const { periodStart, periodEnd, label, clients: clientFilter } = parsePeriodArgs();

  const clients = await db.client.findMany({
    where: { active: true },
    include: { connections: { where: { platform: "INSTAGRAM" } } },
  });

  const rows = [];
  for (const client of clients) {
    if (!clientMatchesFilter(client.name, clientFilter)) continue;
    const connection = client.connections[0];
    if (!connection) {
      rows.push({ client: client.name, overall: "UNAVAILABLE", note: "No Instagram connection" });
      continue;
    }

    const coverage = await getCoverage(connection.id, periodStart, periodEnd);
    const posts = await reportPosts(client.id, periodStart, periodEnd);
    const ownedPosts = posts.filter((p) => p.mediaSource === "OWNED");
    const collabPosts = posts.filter((p) => p.mediaSource === "COLLABORATIVE");
    const sumMetric = (metric: string, subset = posts) => subset.reduce((acc, p) => acc + (p.metrics[metric] ?? 0), 0);

    const oldReachAgg = await db.socialInsightSnapshot.aggregate({
      where: { connectionId: connection.id, metric: "reach", periodEnd: { gte: periodStart, lte: periodEnd } },
      _sum: { value: true },
    });
    const oldReach = oldReachAgg._sum.value ?? 0;
    const oldTotalViews = sumMetric("views");

    const [reach, totalViews, followers] = await Promise.all([
      periodAccountReachForRange(client.id, periodStart, periodEnd),
      periodAccountViewsForRange(client.id, periodStart, periodEnd),
      periodAccountFollowersForRange(client.id, periodStart, periodEnd),
    ]);

    rows.push({
      client: client.name,
      period: label,
      overall: coverage.status,
      historical: coverage.historicalBackfillStatus,
      collab: coverage.collaborativeBackfillStatus,
      ownedPosts: ownedPosts.length,
      collabPosts: collabPosts.length,
      totalMedia: posts.length,
      oldReach,
      reach: reach.value,
      reachMethod: reach.method,
      reachAccuracy: reach.accuracy,
      oldTotalViews,
      totalViews: totalViews.value,
      totalViewsMethod: totalViews.method,
      totalViewsAccuracy: totalViews.accuracy,
      organicViews: sumMetric("views", ownedPosts),
      followersGained: followers.gained,
      followersLost: followers.lost,
      followersNet: followers.net,
      followerMethod: followers.method,
      followerAccuracy: followers.accuracy,
      storyCoverage: coverage.storyCoverage.status,
      likes: sumMetric("likes"),
      comments: sumMetric("comments"),
      shares: sumMetric("shares"),
      saves: sumMetric("saved"),
      mediaFollows: sumMetric("follows"),
      interactions: sumMetric("total_interactions"),
      warnings: coverage.warnings,
    });

    await sleep(1500);
  }

  console.log(`Validation report for ${label} (${periodStart.toISOString()} .. ${periodEnd.toISOString()})`);
  console.log();
  console.log("| Client | Overall | Hist. | Collab. | Owned | Collab | Media | Old Reach | Reach | Reach Method | Old Total Views | Total Views | Views Method | Organic Views | Gained | Lost | Net | Story | Likes | Comments | Shares | Saves | Follows | Interactions |");
  console.log("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const row of rows) {
    if ("note" in row) {
      console.log(`| ${row.client} | UNAVAILABLE | - | - | - | - | - | - | - | - | - | - | - | - | - | - | - | - | - | - | - | - | - | - |`);
      continue;
    }
    const r = row as Record<string, unknown>;
    console.log(`| ${r.client} | ${r.overall} | ${r.historical} | ${r.collab} | ${r.ownedPosts} | ${r.collabPosts} | ${r.totalMedia} | ${fmt(r.oldReach as number)} | ${status(r.reach as number | null)} | ${r.reachMethod} (${r.reachAccuracy}) | ${fmt(r.oldTotalViews as number)} | ${status(r.totalViews as number | null)} | ${r.totalViewsMethod} (${r.totalViewsAccuracy}) | ${fmt(r.organicViews as number)} | ${status(r.followersGained as number | null)} | ${status(r.followersLost as number | null)} | ${status(r.followersNet as number | null)} | ${r.storyCoverage} | ${fmt(r.likes as number)} | ${fmt(r.comments as number)} | ${fmt(r.shares as number)} | ${fmt(r.saves as number)} | ${fmt(r.mediaFollows as number)} | ${fmt(r.interactions as number)} |`);
  }

  console.log();
  console.log("--- JSON rows ---");
  console.log(JSON.stringify(rows, null, 2));

  await db.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
