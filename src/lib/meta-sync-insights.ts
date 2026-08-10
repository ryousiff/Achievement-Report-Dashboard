import { db } from "@/lib/db";
import { InsightPeriodType, Platform } from "@prisma/client";
import { decryptToken } from "@/lib/token-encryption";
import { calculateBackfillStart } from "@/lib/backfill-window";
import { getHistoricalBackfillConfig } from "@/lib/env";
import { graph, MetaSyncError } from "@/lib/meta-sync";

type MetaInsight = { name?: string; period?: string; values?: Array<{ value?: number; end_time?: string }> };

const periodTypeToMetaPeriod: Record<InsightPeriodType, string> = {
  [InsightPeriodType.DAY]: "day",
  [InsightPeriodType.WEEK]: "week",
  [InsightPeriodType.DAYS_28]: "days_28",
  [InsightPeriodType.TOTAL_VALUE]: "day",
};

function startOfDayUTC(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/** Splits [from, to] into consecutive, non-overlapping, gap-free UTC-day windows of at most `chunkDays`
 * days each. Windows are built oldest-first so callers can stop cleanly at the first chunk that fails
 * (rather than an arbitrary one in the middle), and each window's `until` is exactly one day before the
 * next window's `since` — never duplicated, never skipped. */
export function buildDailyInsightChunks(from: Date, to: Date, chunkDays: number): Array<{ since: Date; until: Date }> {
  const chunks: Array<{ since: Date; until: Date }> = [];
  let cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  const end = new Date(to);
  while (cursor < end) {
    const until = new Date(cursor);
    // `until` is exclusive: a 30-day chunk wants values for 30 calendar days, so the boundary is
    // `since + chunkDays` at midnight. The previous off-by-one (`chunkDays - 1`) created 1-day gaps.
    until.setUTCDate(until.getUTCDate() + chunkDays);
    if (until > end) until.setTime(end.getTime());
    if (until.getTime() <= cursor.getTime()) break;
    chunks.push({ since: new Date(cursor), until: new Date(until) });
    // The final chunk always ends exactly at `to`; no need for a zero-length follow-up.
    if (until.getTime() === end.getTime()) break;
    cursor = new Date(Date.UTC(until.getUTCFullYear(), until.getUTCMonth(), until.getUTCDate()));
  }
  return chunks;
}

function windowStartFor(periodEnd: Date, periodType: InsightPeriodType): Date {
  const start = new Date(periodEnd);
  // Meta period conventions:
  // - day:    one 24h window ending at end_time -> start = end - 1 day
  // - week:   seven days ending at end_time    -> start = end - 6 days
  // - days_28: 28 days ending at end_time       -> start = end - 27 days
  const daysBack =
    periodType === InsightPeriodType.DAY || periodType === InsightPeriodType.TOTAL_VALUE ? 1 :
    periodType === InsightPeriodType.WEEK ? 6 :
    27;
  start.setUTCDate(start.getUTCDate() - daysBack);
  return start;
}

async function fetchAndStoreAccountInsight(
  connectionId: string,
  accountId: string,
  token: string,
  metric: string,
  periodType: InsightPeriodType,
  since: Date,
  until: Date,
  lookbackStart: Date,
) {
  const period = periodTypeToMetaPeriod[periodType];
  const insights = await graph<{ data?: MetaInsight[] }>(`${accountId}/insights`, token, {
    metric,
    period,
    since: String(Math.floor(since.valueOf() / 1000)),
    until: String(Math.floor(until.valueOf() / 1000)),
  });
  let earliestPeriodEnd: Date | null = null;
  for (const insight of insights.data ?? []) {
    for (const item of insight.values ?? []) {
      if (typeof item.value !== "number" || !item.end_time) continue; // never overwrite a stored value with a missing/null one
      const periodEnd = new Date(item.end_time);
      const periodStart = windowStartFor(periodEnd, periodType);
      // days_28 windows that start before our lookback floor are incomplete (their first 27 days predate
      // our data window). Skip those; keep everything else.
      if (periodType === InsightPeriodType.DAYS_28 && periodStart < lookbackStart) continue;
      await db.socialInsightSnapshot.upsert({
        where: {
          connectionId_metric_periodType_periodStart_periodEnd: {
            connectionId,
            metric,
            periodType,
            periodStart,
            periodEnd,
          },
        },
        create: { connectionId, metric, periodType, periodStart, periodEnd, value: item.value },
        update: { value: item.value },
      });
      if (!earliestPeriodEnd || periodEnd < earliestPeriodEnd) earliestPeriodEnd = periodEnd;
    }
  }
  return { earliestPeriodEnd };
}

type Workload = {
  metric: string;
  periodType: InsightPeriodType;
  coverageStart: Date | null;
  coverageField: "reachCoverageStart" | "reachWeekCoverageStart" | "reachDays28CoverageStart" | "followerCountCoverageStart";
};

/** One bounded unit of daily reach/follows sync: chunks the configured lookback into <=`chunkDays` windows
 * and works backward from the most recent window, recording the earliest period-end we have *actually*
 * successfully returned for each period type. Reach is stored both as daily (for charts) and as days_28
 * (the only period for which the API returns a deduplicated unique-accounts-reached value). */
export async function runDailyAccountInsightChunk(connectionId: string) {
  const connection = await db.socialConnection.findUnique({
    where: { id: connectionId },
    select: {
      id: true,
      platform: true,
      externalAccountId: true,
      encryptedToken: true,
      reachCoverageStart: true,
      reachWeekCoverageStart: true,
      reachDays28CoverageStart: true,
      followerCountCoverageStart: true,
    },
  });
  if (!connection || connection.platform !== Platform.INSTAGRAM) throw new Error("Instagram connection not found.");
  const token = decryptToken(connection.encryptedToken);
  const config = getHistoricalBackfillConfig();
  const overallStart = calculateBackfillStart(new Date(), config.months);
  const lookbackFloor = new Date(Date.now() - config.accountInsightMaxLookbackDays * 24 * 60 * 60 * 1000);
  const baseFrom = startOfDayUTC(overallStart > lookbackFloor ? overallStart : lookbackFloor);
  const now = new Date();

  const workloads: Workload[] = [
    { metric: "reach", periodType: InsightPeriodType.DAY, coverageStart: connection.reachCoverageStart, coverageField: "reachCoverageStart" },
    { metric: "reach", periodType: InsightPeriodType.WEEK, coverageStart: connection.reachWeekCoverageStart, coverageField: "reachWeekCoverageStart" },
    { metric: "reach", periodType: InsightPeriodType.DAYS_28, coverageStart: connection.reachDays28CoverageStart, coverageField: "reachDays28CoverageStart" },
    { metric: "follower_count", periodType: InsightPeriodType.DAY, coverageStart: connection.followerCountCoverageStart, coverageField: "followerCountCoverageStart" },
  ];

  let lastError: string | null = null;
  let allMetricsReachedFloor = true;
  for (const workload of workloads) {
    // Meta restricts follower_count to the last 30 days (excluding today). Respect that to avoid a hard error.
    const metricMaxLookbackDays = workload.metric === "follower_count" ? 30 : config.accountInsightMaxLookbackDays;
    const metricFloor = new Date(Date.now() - metricMaxLookbackDays * 24 * 60 * 60 * 1000);
    const from = baseFrom > metricFloor ? baseFrom : metricFloor;
    // Always refresh the most recent window; we rely on upsert and the 30-day limit for follower_count
    // to keep the API call count bounded. For reach/days_28 this re-fetches the configured historical window.
    const rangeEnd = now;
    if (rangeEnd < from) continue;
    const chunks = buildDailyInsightChunks(from, rangeEnd, config.accountInsightChunkDays).reverse(); // newest-first: stop at first failure
    let reachedFloor = true;
    for (const chunk of chunks) {
      try {
        const { earliestPeriodEnd } = await fetchAndStoreAccountInsight(
          connectionId,
          connection.externalAccountId,
          token,
          workload.metric,
          workload.periodType,
          chunk.since,
          chunk.until,
          from,
        );
        if (earliestPeriodEnd) {
          const current = await db.socialConnection.findUnique({
            where: { id: connectionId },
            select: { [workload.coverageField]: true },
          });
          const currentValue = (current as Record<string, Date | null> | null)?.[workload.coverageField] as Date | null;
          const newValue = !currentValue || earliestPeriodEnd < currentValue ? earliestPeriodEnd : currentValue;
          await db.socialConnection.update({
            where: { id: connectionId },
            data: { [workload.coverageField]: newValue, accountInsightsLastSyncedAt: new Date() },
          });
        }
      } catch (error) {
        // A rate limit should bubble up so the job-level retry/backoff in sync-queue.ts handles it; anything
        // else (e.g. Meta no longer has data this far back) just stops walking further back for this metric —
        // the coverage-start we've already recorded becomes the honest boundary rather than a hard failure.
        if (error instanceof MetaSyncError && error.code === "rate_limited") throw error;
        lastError = error instanceof Error ? error.message : "Daily insight request failed.";
        reachedFloor = false;
        break;
      }
    }
    if (!reachedFloor) allMetricsReachedFloor = false;
  }

  await db.socialConnection.update({
    where: { id: connectionId },
    data: { accountInsightsLastError: lastError, ...(allMetricsReachedFloor ? { accountInsightsBackfillCompletedAt: new Date() } : {}) },
  });
  return { posts: 0 };
}
