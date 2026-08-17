import { InsightPeriodType } from "@prisma/client";
import { db } from "@/lib/db";

async function main() {
  const snapshots = await db.socialInsightSnapshot.findMany({
    where: { periodType: InsightPeriodType.TOTAL_VALUE },
    select: {
      metric: true,
      value: true,
      periodStart: true,
      periodEnd: true,
      capturedAt: true,
      connection: { select: { client: { select: { name: true } } } },
    },
    orderBy: [{ periodStart: "desc" }, { metric: "asc" }],
    take: 200,
  });

  const grouped = new Map<string, Record<string, number | string>>();
  for (const snapshot of snapshots) {
    const month = snapshot.periodStart.toISOString().slice(0, 7);
    const client = snapshot.connection.client.name;
    const key = `${client}__${month}`;
    const row = grouped.get(key) ?? { client, month };
    row[snapshot.metric] = snapshot.value;
    grouped.set(key, row);
  }

  console.table([...grouped.values()]);
  await db.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await db.$disconnect();
  process.exit(1);
});
