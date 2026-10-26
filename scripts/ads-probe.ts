/** One-off diagnostic: calls the ad-account insights endpoint directly with the stored system-user
 * token and prints the raw result or the real Meta error. Usage:
 *   docker compose exec web npx tsx scripts/ads-probe.ts <clientId> [since] [until] */
import { db } from "@/lib/db";
import { decryptToken } from "@/lib/token-encryption";

const clientId = process.argv[2];
const since = process.argv[3] ?? "2026-09-01";
const until = process.argv[4] ?? "2026-09-30";

async function main() {
  const client = await db.client.findUnique({ where: { id: clientId }, select: { name: true, metaAdAccountId: true } });
  console.log("client:", client?.name, "| ad account:", client?.metaAdAccountId ?? "(none)");
  if (!client?.metaAdAccountId) return;

  const profile = await db.metaProfile.findFirst({
    where: { displayName: "Meta Business · Kaan Creative (System user)", encryptedSystemToken: { not: null } },
    select: { encryptedSystemToken: true },
  });
  console.log("system token stored:", Boolean(profile?.encryptedSystemToken));
  if (!profile?.encryptedSystemToken) return;
  const token = decryptToken(profile.encryptedSystemToken);

  const url = new URL(`https://graph.facebook.com/v23.0/${client.metaAdAccountId}/insights`);
  url.searchParams.set("level", "account");
  url.searchParams.set("fields", "impressions,reach,clicks,spend,actions");
  url.searchParams.set("time_range", JSON.stringify({ since, until }));
  url.searchParams.set("access_token", token);
  const response = await fetch(url);
  const body = await response.json();
  console.log("status:", response.status);
  console.log(JSON.stringify(body, null, 2));
}

main().catch((e) => console.error(e)).finally(() => db.$disconnect());
