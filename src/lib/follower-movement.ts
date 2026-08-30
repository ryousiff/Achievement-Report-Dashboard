import { InsightPeriodType } from "@prisma/client";
import { db } from "@/lib/db";
import { graph } from "@/lib/meta-sync";

export type ParsedFollowerBreakdown = {
  gained: number;
  lost: number;
  raw: Array<{ dimension: string; value: number }>;
};

/**
 * Safely parse Meta's `follows_and_unfollows` breakdown response.
 *
 * Meta occasionally returns a breakdown object without a `results` array. That is
 * "not returned", not a reason to crash the worker. An explicitly empty results
 * array is different: it means the day had zero follower movement and is safe to
 * persist as 0 gained / 0 lost.
 */
export function parseFollowerBreakdown(insight: unknown): ParsedFollowerBreakdown | null {
  const totalValue = (insight as { total_value?: unknown } | null | undefined)?.total_value;
  if (!totalValue || typeof totalValue !== "object") return null;

  const breakdowns = (totalValue as { breakdowns?: unknown }).breakdowns;
  if (!Array.isArray(breakdowns) || breakdowns.length === 0) return null;

  const firstBreakdown = breakdowns[0];
  if (!firstBreakdown || typeof firstBreakdown !== "object") return null;

  const results = (firstBreakdown as { results?: unknown }).results;
  if (!Array.isArray(results)) return null;
  if (results.length === 0) return { gained: 0, lost: 0, raw: [] };

  const raw: Array<{ dimension: string; value: number }> = [];
  let gained = 0;
  let lost = 0;
  let numericRows = 0;

  for (const row of results) {
    if (!row || typeof row !== "object") continue;
    const value = (row as { value?: unknown }).value;
    if (typeof value !== "number" || !Number.isFinite(value)) continue;

    const dimensionValues = (row as { dimension_values?: unknown }).dimension_values;
    const dimension = Array.isArray(dimensionValues) && typeof dimensionValues[0] === "string"
      ? dimensionValues[0]
      : "UNKNOWN";

    raw.push({ dimension, value });
    numericRows += 1;
    if (dimension === "FOLLOWER") gained = value;
    if (dimension === "NON_FOLLOWER") lost = value;
  }

  // A non-empty results array containing no usable numeric rows is malformed; do
  // not invent zeros for it. Leave the day incomplete so the caller can retry.
  if (numericRows === 0) return null;

  return { gained, lost, raw };
}

/**
 * Fetch and persist one day's follower movement for month/report closeout.
 * Meta/network errors intentionally bubble to the queue's existing retry/cooldown
 * handling. A malformed-but-200 response returns null instead of throwing a JS
 * TypeError.
 */
export async function fetchAndStoreDailyFollowerMovementSafe(
  connectionId: string,
  externalAccountId: string,
  token: string,
  day: Date,
): Promise<{ gained: number; lost: number } | null> {
  const since = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()));
  const until = new Date(since);
  until.setUTCDate(until.getUTCDate() + 1);

  const response = await graph<{ data?: Array<unknown> }>(
    `${externalAccountId}/insights`,
    token,
    {
      metric: "follows_and_unfollows",
      period: "day",
      metric_type: "total_value",
      breakdown: "follow_type",
      since: String(Math.floor(since.valueOf() / 1000)),
      until: String(Math.floor(until.valueOf() / 1000)),
    },
  );

  const parsed = parseFollowerBreakdown(response.data?.[0]);
  if (!parsed) return null;

  const periodEnd = new Date(since);
  periodEnd.setUTCDate(periodEnd.getUTCDate() + 1);
  periodEnd.setUTCHours(7);
  const periodStart = new Date(periodEnd);
  periodStart.setUTCDate(periodStart.getUTCDate() - 1);

  await Promise.all([
    db.socialInsightSnapshot.upsert({
      where: {
        connectionId_metric_periodType_periodStart_periodEnd: {
          connectionId,
          metric: "followers_gained",
          periodType: InsightPeriodType.DAY,
          periodStart,
          periodEnd,
        },
      },
      create: {
        connectionId,
        metric: "followers_gained",
        periodType: InsightPeriodType.DAY,
        periodStart,
        periodEnd,
        value: parsed.gained,
      },
      update: { value: parsed.gained },
    }),
    db.socialInsightSnapshot.upsert({
      where: {
        connectionId_metric_periodType_periodStart_periodEnd: {
          connectionId,
          metric: "followers_lost",
          periodType: InsightPeriodType.DAY,
          periodStart,
          periodEnd,
        },
      },
      create: {
        connectionId,
        metric: "followers_lost",
        periodType: InsightPeriodType.DAY,
        periodStart,
        periodEnd,
        value: parsed.lost,
      },
      update: { value: parsed.lost },
    }),
  ]);

  return { gained: parsed.gained, lost: parsed.lost };
}
