import { db } from "@/lib/db";
import { enqueueHistoricalBackfill } from "@/lib/sync-queue";

async function main() {
  const clients = ["سكن", "جمعية الإصلاح", "جمعية السنابل"];
  for (const name of clients) {
    const client = await db.client.findFirst({
      where: { name: { contains: name } },
      include: { connections: { where: { platform: "INSTAGRAM" } } },
    });
    if (!client || client.connections.length === 0) {
      console.log(`No Instagram connection for ${name}`);
      continue;
    }
    const connection = client.connections[0];
    if (connection.collaborativeBackfillStatus !== "COMPLETED" && connection.historicalBackfillStatus === "COMPLETED") {
      try {
        await enqueueHistoricalBackfill(connection.id);
        console.log(`Re-enqueued backfill for ${client.name} (${connection.id})`);
      } catch (error) {
        console.log(`Skipped ${client.name}: ${error instanceof Error ? error.message : error}`);
      }
    } else {
      console.log(`${client.name} backfill status: historical=${connection.historicalBackfillStatus}, collab=${connection.collaborativeBackfillStatus}`);
    }
  }
  await db.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
