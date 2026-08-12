import { db } from "@/lib/db";
import { enqueueHistoricalBackfill } from "@/lib/sync-queue";

async function main() {
  const connections = await db.socialConnection.findMany({
    where: { platform: "INSTAGRAM" },
    include: { client: { select: { name: true } } },
  });

  for (const connection of connections) {
    const ownedIncomplete = connection.historicalBackfillStatus !== "COMPLETED";
    const collabIncomplete = connection.collaborativeBackfillStatus !== "COMPLETED";
    if (!ownedIncomplete && !collabIncomplete) {
      console.log(`Skipping ${connection.client.name} (complete).`);
      continue;
    }
    console.log(`Resuming ${connection.client.name}: historical=${connection.historicalBackfillStatus}, collab=${connection.collaborativeBackfillStatus}`);
    try {
      await enqueueHistoricalBackfill(connection.id);
      console.log(`  enqueued.`);
    } catch (error) {
      console.log(`  skipped: ${error instanceof Error ? error.message : error}`);
    }
  }

  await db.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
