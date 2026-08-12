import { db } from "@/lib/db";

async function main() {
  const jobs = await db.syncJob.findMany({
    take: 30,
    orderBy: { createdAt: "desc" },
    include: { connection: { include: { client: { select: { name: true } } } } },
  });
  const settings = await db.setting.findMany({ where: { moduleId: { in: ["meta_cooldown", "meta_incremental_hold", "scheduler"] } } });
  console.log(JSON.stringify({
    jobs: jobs.map((j) => ({ id: j.id, type: j.type, status: j.status, runAfter: j.runAfter, connection: j.connection?.client?.name, attempts: j.attempts, lastError: j.lastError })),
    settings: settings.map((s) => ({ moduleId: s.moduleId, key: s.key, value: s.value })),
  }, null, 2));
  await db.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
