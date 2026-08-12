import { db } from "@/lib/db";

async function main() {
  const updated = await db.syncJob.updateMany({
    where: { status: "RUNNING" },
    data: { status: "QUEUED", lockedAt: null, runAfter: new Date() },
  });
  console.log(`Reset ${updated.count} RUNNING job(s) to QUEUED.`);
  await db.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
