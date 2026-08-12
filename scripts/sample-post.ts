import { db } from "@/lib/db";

async function main() {
  const client = await db.client.findFirst({ where: { name: { contains: "صمونة" } }, include: { connections: { where: { platform: "INSTAGRAM" } } } });
  if (!client) return;
  const post = await db.socialPost.findFirst({
    where: { connectionId: client.connections[0].id },
    select: { publishedAt: true, metrics: true, metricAvailability: true, mediaSource: true, mediaType: true },
  });
  console.log(JSON.stringify(post, null, 2));
  await db.$disconnect();
}

main().catch(console.error);
