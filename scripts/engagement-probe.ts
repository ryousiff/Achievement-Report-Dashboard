/** Diagnostic: asks Meta for account-level organic engagement for a client's IG account over a
 * date range and prints both the total_value window result and the daily-series sum.
 * Usage: docker compose exec web npx tsx scripts/engagement-probe.ts <clientId> [since] [until] */
import { db } from "@/lib/db";
import { decryptToken } from "@/lib/token-encryption";

const clientId = process.argv[2];
const since = process.argv[3] ?? "2026-09-01";
const until = process.argv[4] ?? "2026-09-30";
const METRICS = "total_interactions,likes,comments,shares,saves";

async function call(igId: string, token: string, params: Record<string, string>) {
  const url = new URL(`https://graph.facebook.com/v23.0/${igId}/insights`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("access_token", token);
  const response = await fetch(url);
  return { status: response.status, body: await response.json() };
}

async function main() {
  const connection = await db.socialConnection.findFirst({
    where: { clientId, platform: "INSTAGRAM" },
    select: { externalAccountId: true, encryptedToken: true, client: { select: { name: true } } },
  });
  console.log("client:", connection?.client.name, "| ig:", connection?.externalAccountId);
  if (!connection) return;
  const token = decryptToken(connection.encryptedToken);
  const ig = connection.externalAccountId;
  const sinceTs = String(Math.floor(Date.parse(`${since}T00:00:00Z`) / 1000));
  const untilTs = String(Math.floor(Date.parse(`${until}T00:00:00Z`) / 1000 + 86400));

  console.log("\n=== 1) metric_type=total_value (single window) ===");
  const total = await call(ig, token, { metric: METRICS, period: "day", metric_type: "total_value", since: sinceTs, until: untilTs });
  console.log("status:", total.status);
  console.log(JSON.stringify(total.body, null, 2));

  console.log("\n=== 2) daily series summed (period=day, no metric_type) ===");
  const daily = await call(ig, token, { metric: METRICS, period: "day", since: sinceTs, until: untilTs });
  console.log("status:", daily.status);
  const rows = (daily.body as { data?: Array<{ name?: string; values?: Array<{ value?: number }> }> }).data ?? [];
  for (const row of rows) {
    const sum = (row.values ?? []).reduce((a, v) => a + (v.value ?? 0), 0);
    const days = (row.values ?? []).filter((v) => (v.value ?? 0) > 0).length;
    console.log(`${row.name}: sum=${sum} across ${days} non-zero days`);
  }
}

main().catch((e) => console.error(e)).finally(() => db.$disconnect());
