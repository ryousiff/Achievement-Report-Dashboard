import { db } from "@/lib/db";

async function main() {
  const running = await db.syncJob.findMany({
    where: { status: "RUNNING" },
    include: { connection: { include: { client: { select: { name: true } } } }, runs: { take: 1, orderBy: { createdAt: "desc" } } },
  });
  console.log(JSON.stringify(running.map((j) => ({
    id: j.id, type: j.type, client: j.connection?.client?.name, runAfter: j.runAfter, lockedAt: j.lockedAt, attempts: j.attempts, lastError: j.lastError,
    runs: j.runs.map((r) => ({ id: r.id, startedAt: r.startedAt, status: r.status })),
  })), null, 2));
  const cooldown = await db.setting.findUnique({ where: { moduleId_key: { moduleId: "meta_cooldown", key: "cooldown_until" } } });
  console.log("Cooldown:", cooldown?.value);
  await db.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
