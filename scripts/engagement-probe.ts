/** Diagnostic: asks Meta for account-level organic engagement total_value for a client's IG account
 * over a date range and prints the raw response. Usage:
 *   docker compose exec web npx tsx scripts/engagement-probe.ts <clientId> [since] [until] */
import { db } from "@/lib/db";
import { decryptToken } from "@/lib/token-encryption";

const clientId = process.argv[2];
const since = process.argv[3] ?? "2026-09-01";
const until = process.argv[4] ?? "2026-09-30";

async function main() {
  const connection = await db.socialConnection.findFirst({
    where: { clientId, platform: "INSTAGRAM" },
    select: { externalAccountId: true, encryptedToken: true, client: { select: { name: true } } },
  });
  console.log("client:", connection?.client.name, "| ig:", connection?.externalAccountId);
  if (!connection) return;
  const token = decryptToken(connection.encryptedToken);

  const url = new URL(`https://graph.facebook.com/v23.0/${connection.externalAccountId}/insights`);
  url.searchParams.set("metric", "total_interactions,likes,comments,shares,saved");
  url.searchParams.set("period", "day");
  url.searchParams.set("metric_type", "total_value");
  url.searchParams.set("since", String(Math.floor(Date.parse(`${since}T00:00:00Z`) / 1000)));
  url.searchParams.set("until", String(Math.floor(Date.parse(`${until}T00:00:00Z`) / 1000 + 86400)));
  url.searchParams.set("access_token", token);
  const response = await fetch(url);
  const body = await response.json();
  console.log("status:", response.status);
  console.log(JSON.stringify(body, null, 2));
}

main().catch((e) => console.error(e)).finally(() => db.$disconnect());
