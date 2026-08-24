import { db } from "@/lib/db";
import { InsightPeriodType, Platform } from "@prisma/client";
import { decryptToken } from "@/lib/token-encryption";
import { calculateBackfillStart } from "@/lib/backfill-window";
import { getHistoricalBackfillConfig } from "@/lib/env";
import { graph, MetaSyncError } from "@/lib/meta-sync";

type MetaInsight = { name?: string; period?: string; values?: Array<{ value?: number; end_time?: string }> };
type MetaTotalValueInsight = {
  total_value?: {
    value?: number;
    breakdowns?: Array<{
      dimension_keys?: string[];
      results?: Array<{ dimension_values?: string[]; value?: number }>;
    }>;
  };
};

export type CompletedMonthPeriod = { start: Date; end: Date };
type MonthlyAccountTotals = { reach: number; views: number; gained: number; lost: number };

const periodTypeToMetaPeriod: Record<InsightPeriodType, string> = {
  [InsightPeriodType.DAY]: "day",
  [InsightPeriodType.WEEK]: "week",
  [InsightPeriodType.DAYS_28]: "days_28",
  [InsightPeriodType.TOTAL_VALUE]: "day",
};

const authoritativePeriodMetrics = ["reach", "views", "followers_gained", "followers_lost"] as const;

function startOfDayUTC(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function endOfDayUTC(date: Date) {
  const end = startOfDayUTC(date);
  end.setUTCDate(end.getUTCDate() + 1);
  end.setUTCMilliseconds(end.getUTCMilliseconds() - 1);
  return end;
}

function addDaysUTC(date: Date, days: number) {
  const result = startOfDayUTC(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function daysBetweenInclusive(from: Date, to: Date) {
  return Math.max(1, Math.floor((startOfDayUTC(to).valueOf() - startOfDayUTC(from).valueOf()) / (24 * 60 * 60 * 1000)) + 1);
}

/** Return completed calendar months whose full date range is still inside the configured account-insight
 * lookback window. Newest months come first so the most relevant report data is captured before older data. */
export function completedMonthsWithinLookback(now: Date, lookbackStart: Date): CompletedMonthPeriod[] {
  const currentMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const periods: CompletedMonthPeriod[] = [];
  let monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));

  while (monthStart >= startOfDayUTC(lookbackStart) && monthStart < currentMonthStart) {
    const monthEnd = new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 0, 23, 59, 59, 999));
    periods.push({ start: new Date(monthStart), end: monthEnd });
    monthStart = new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() - 1, 1));
  }
  return periods;
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

export async function fetchAndStoreAccountInsight(
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

async function fetchTotalValueNumber(accountId: string, token: string, metric: "reach" | "views", since: Date, untilExclusive: Date) {
  const response = await graph<{ data?: MetaTotalValueInsight[] }>(`${accountId}/insights`, token, {
    metric,
    period: "day",
    metric_type: "total_value",
    since: String(Math.floor(startOfDayUTC(since).valueOf() / 1000)),
    until: String(Math.floor(startOfDayUTC(untilExclusive).valueOf() / 1000)),
  });
  const value = response.data?.[0]?.total_value?.value;
  return typeof value === "number" ? value : null;
}

async function fetchFollowerMovementTotal(accountId: string, token: string, since: Date, untilExclusive: Date) {
  const response = await graph<{ data?: MetaTotalValueInsight[] }>(`${accountId}/insights`, token, {
    metric: "follows_and_unfollows",
    period: "day",
    metric_type: "total_value",
    breakdown: "follow_type",
    since: String(Math.floor(startOfDayUTC(since).valueOf() / 1000)),
    until: String(Math.floor(startOfDayUTC(untilExclusive).valueOf() / 1000)),
  });
  const results = response.data?.[0]?.total_value?.breakdowns?.[0]?.results ?? [];
  if (results.length === 0) return null;
  const gained = results.find((result) => result.dimension_values?.[0] === "FOLLOWER")?.value;
  const lost = results.find((result) => result.dimension_values?.[0] === "NON_FOLLOWER")?.value;
  if (typeof gained !== "number" || typeof lost !== "number") return null;
  return { gained, lost };
}

async function fetchWindowTotals(accountId: string, token: string, since: Date, untilExclusive: Date): Promise<MonthlyAccountTotals | null> {
  const [reach, views, followers] = await Promise.all([
    fetchTotalValueNumber(accountId, token, "reach", since, untilExclusive),
    fetchTotalValueNumber(accountId, token, "views", since, untilExclusive),
    fetchFollowerMovementTotal(accountId, token, since, untilExclusive),
  ]);
  if (reach === null || views === null || !followers) return null;
  return { reach, views, gained: followers.gained, lost: followers.lost };
}

/** Fetch the validated account totals for one completed calendar month. 28/29/30-day months use one
 * Meta total_value window. A 31-day month uses the same A+B-C composition already validated by reports. */
export async function fetchCompletedMonthTotals(accountId: string, token: string, period: CompletedMonthPeriod): Promise<MonthlyAccountTotals | null> {
  const days = daysBetweenInclusive(period.start, period.end);
  if (days <= 30) return fetchWindowTotals(accountId, token, period.start, addDaysUTC(period.end, 1));
  if (days !== 31) return null;

  // A = D1..D30, B = D2..D31, C = D2..D30. Fetch sequentially to avoid a 9-request burst.
  const A = await fetchWindowTotals(accountId, token, period.start, addDaysUTC(period.start, 30));
  if (!A) return null;
  const B = await fetchWindowTotals(accountId, token, addDaysUTC(period.start, 1), addDaysUTC(period.end, 1));
  if (!B) return null;
  const C = await fetchWindowTotals(accountId, token, addDaysUTC(period.start, 1), addDaysUTC(period.start, 30));
  if (!C) return null;

  return {
    reach: A.reach + B.reach - C.reach,
    views: A.views + B.views - C.views,
    gained: A.gained + B.gained - C.gained,
    lost: A.lost + B.lost - C.lost,
  };
}

export async function storeCompletedMonthTotals(connectionId: string, period: CompletedMonthPeriod, totals: MonthlyAccountTotals) {
  const periodStart = startOfDayUTC(period.start);
  const periodEnd = endOfDayUTC(period.end);
  const values: Record<(typeof authoritativePeriodMetrics)[number], number> = {
    reach: totals.reach,
    views: totals.views,
    followers_gained: totals.gained,
    followers_lost: totals.lost,
  };
  await Promise.all(authoritativePeriodMetrics.map((metric) => db.socialInsightSnapshot.upsert({
    where: {
      connectionId_metric_periodType_periodStart_periodEnd: {
        connectionId,
        metric,
        periodType: InsightPeriodType.TOTAL_VALUE,
        periodStart,
        periodEnd,
      },
    },
    create: { connectionId, metric, periodType: InsightPeriodType.TOTAL_VALUE, periodStart, periodEnd, value: values[metric] },
    update: { value: values[metric], capturedAt: new Date() },
  })));
}

/** Store at most one missing completed month per worker run. This keeps Meta request volume bounded while
 * continuously building permanent monthly history before the upstream account-insight retention window expires. */
async function syncOneMissingCompletedMonth(
  connectionId: string,
  accountId: string,
  token: string,
  now: Date,
  lookbackStart: Date,
): Promise<{ complete: boolean; stored: CompletedMonthPeriod | null }> {
  const candidates = completedMonthsWithinLookback(now, lookbackStart);
  for (let index = 0; index < candidates.length; index += 1) {
    const period = candidates[index];
    const existing = await db.socialInsightSnapshot.findMany({
      where: {
        connectionId,
        periodType: InsightPeriodType.TOTAL_VALUE,
        metric: { in: [...authoritativePeriodMetrics] },
        periodStart: startOfDayUTC(period.start),
        periodEnd: endOfDayUTC(period.end),
      },
      select: { metric: true },
    });
    const present = new Set(existing.map((row) => row.metric));
    if (authoritativePeriodMetrics.every((metric) => present.has(metric))) continue;

    const totals = await fetchCompletedMonthTotals(accountId, token, period);
    if (!totals) return { complete: false, stored: null };
    await storeCompletedMonthTotals(connectionId, period, totals);
    // There may still be older missing months. The next worker run will continue from the next gap.
    return { complete: index === candidates.length - 1, stored: period };
  }
  return { complete: true, stored: null };
}

type Workload = {
  metric: string;
  periodType: InsightPeriodType;
  coverageStart: Date | null;
  coverageField: "reachCoverageStart" | "reachWeekCoverageStart" | "reachDays28CoverageStart" | "followerCountCoverageStart";
};

/** One bounded unit of daily reach/follows sync: chunks the configured lookback into <=`chunkDays` windows
 * and works backward from the most recent window, recording the earliest period-end we have *actually*
 * successfully returned for each period type. Reach is stored both as daily (for charts) and as days_28.
 * The same job also captures one missing completed calendar month of authoritative account totals. */
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
        // else (e.g. Meta no longer has data this far back) just stops walking further back for this metric.
        if (error instanceof MetaSyncError && error.code === "rate_limited") throw error;
        lastError = error instanceof Error ? error.message : "Daily insight request failed.";
        reachedFloor = false;
        break;
      }
    }
    if (!reachedFloor) allMetricsReachedFloor = false;
  }

  try {
    const monthly = await syncOneMissingCompletedMonth(connectionId, connection.externalAccountId, token, now, lookbackFloor);
    if (!monthly.complete) allMetricsReachedFloor = false;
  } catch (error) {
    // Network/rate-limit errors are retryable at the job level; permanent/unavailable historical data is
    // recorded honestly without discarding the daily snapshots already collected in this run.
    if (error instanceof MetaSyncError && (error.code === "rate_limited" || error.code === "request_failed")) throw error;
    lastError = error instanceof Error ? error.message : "Completed-month account totals could not be synchronized.";
    allMetricsReachedFloor = false;
  }

  await db.socialConnection.update({
    where: { id: connectionId },
    data: { accountInsightsLastError: lastError, ...(allMetricsReachedFloor ? { accountInsightsBackfillCompletedAt: new Date() } : {}) },
  });
  return { posts: 0 };
}
