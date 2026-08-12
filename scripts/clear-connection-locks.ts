import { db } from "@/lib/db";

async function main() {
  const updated = await db.socialConnection.updateMany({
    where: { platform: "INSTAGRAM", syncLockedUntil: { not: null } },
    data: { syncLockedUntil: null },
  });
  console.log(`Cleared syncLockedUntil for ${updated.count} Instagram connection(s).`);
  await db.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
