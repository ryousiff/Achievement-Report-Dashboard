import { InsightPeriodType, MediaSource, Platform } from "@prisma/client";
import { db } from "@/lib/db";
import { decryptToken } from "@/lib/token-encryption";
import { getHistoricalBackfillConfig } from "@/lib/env";
import { calculateBackfillStart } from "@/lib/backfill-window";
import { monthPeriodUTC, isMonthFinalized } from "@/lib/post-metric-snapshots";
import { postInsights, upsertPost, type MetaMedia } from "@/lib/meta-sync";
import {
  fetchAndStoreAccountInsight,
  fetchCompletedMonthTotals,
  storeCompletedMonthTotals,
  completedMonthsWithinLookback,
  type CompletedMonthPeriod,
} from "@/lib/meta-sync-insights";
import { logEvent, logError } from "@/lib/observability";
import { fetchAndStoreDailyFollowerMovement } from "@/lib/report-data";

const CLOSEOUT_POST_REFRESH_BATCH_SIZE = 15;
const CLOSEOUT_MAX_DAILY_SNAPSHOT_FETCHES = 31;

function startOfDayUTC(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function endOfDayUTC(date: Date) {
  const end = startOfDayUTC(date);
  end.setUTCDate(end.getUTCDate() + 1);
  end.setUTCMilliseconds(end.getUTCMilliseconds() - 1);
  return end;
}

function daysBetweenInclusive(from: Date, to: Date) {
  return Math.max(1, Math.floor((startOfDayUTC(to).valueOf() - startOfDayUTC(from).valueOf()) / (24 * 60 * 60 * 1000)) + 1);
}

export function isLastDaysOfMonth(now: Date, days: number): boolean {
  const periodEnd = monthPeriodUTC(now).periodEnd;
  return periodEnd.valueOf() - now.valueOf() < days * 24 * 60 * 60 * 1000;
}

async function requireInstagramConnection(connectionId: string) {
  const connection = await db.socialConnection.findUnique({
    where: { id: connectionId },
    select: {
      id: true,
      platform: true,
      externalAccountId: true,
      encryptedToken: true,
    },
  });
  if (!connection || connection.platform !== Platform.INSTAGRAM) throw new Error("Instagram connection not found.");
  return connection;
}

async function findFirstIncompleteCompletedMonthInRange(
  connectionId: string,
  now: Date,
  options?: { minStart?: Date; maxEnd?: Date },
): Promise<{ period: CompletedMonthPeriod; readiness: Awaited<ReturnType<typeof monthReadinessMetrics>> } | null> {
  const config = getHistoricalBackfillConfig();
  const overallStart = calculateBackfillStart(new Date(), config.months);
  const lookbackFloor = new Date(Date.now() - config.accountInsightMaxLookbackDays * 24 * 60 * 60 * 1000);
  const baseFrom = overallStart > lookbackFloor ? overallStart : lookbackFloor;
  const candidates = completedMonthsWithinLookback(now, baseFrom).filter((period) => {
    if (options?.minStart && period.end < options.minStart) return false;
    if (options?.maxEnd && period.start > options.maxEnd) return false;
    return true;
  });
  for (const period of candidates) {
    if (!isMonthFinalized(period.end, now)) continue;
    const readiness = await monthReadinessMetrics(connectionId, period);
    if (!readiness.ready) return { period, readiness };
  }
  return null;
}

export async function isMonthEndCloseoutDue(connectionId: string, now: Date = new Date()) {
  return (await findFirstIncompleteCompletedMonthInRange(connectionId, now)) !== null;
}

export async function isReportPeriodCloseoutDue(connectionId: string, periodStart: Date, periodEnd: Date, now: Date = new Date()) {
  return (await findFirstIncompleteCompletedMonthInRange(connectionId, now, { minStart: periodStart, maxEnd: periodEnd })) !== null;
}

async function monthReadinessMetrics(connectionId: string, period: CompletedMonthPeriod) {
  const periodStart = startOfDayUTC(period.start);
  const periodEnd = endOfDayUTC(period.end);

  const totals = await db.socialInsightSnapshot.findMany({
    where: {
      connectionId,
      periodType: InsightPeriodType.TOTAL_VALUE,
      metric: { in: ["reach", "views", "followers_gained", "followers_lost"] },
      periodStart,
      periodEnd,
    },
    select: { metric: true },
  });
  const totalMetricsReady = totals.length === 4;

  const expectedDays = daysBetweenInclusive(periodStart, periodEnd);
  const [dailyReachDays, dailyFollowerRows, postsMissingFinalizedSnapshots] = await Promise.all([
    db.socialInsightSnapshot.count({
      where: {
        connectionId,
        metric: "reach",
        periodType: InsightPeriodType.DAY,
        periodEnd: { gte: periodStart, lte: periodEnd },
      },
    }),
    db.socialInsightSnapshot.findMany({
      where: {
        connectionId,
        metric: { in: ["followers_gained", "followers_lost"] },
        periodType: InsightPeriodType.DAY,
        periodStart: { gte: periodStart, lte: periodEnd },
      },
      select: { metric: true, periodStart: true },
    }),
    db.socialPost.count({
      where: {
        connectionId,
        publishedAt: { gte: periodStart, lte: periodEnd },
        metricSnapshots: {
          none: { periodStart, periodEnd, finalizedAt: { not: null }, validityState: { not: "REPAIR_NEEDED" } },
        },
      },
    }),
  ]);

  const followerMetricsByDay = new Map<string, Set<string>>();
  for (const row of dailyFollowerRows) {
    const key = startOfDayUTC(row.periodStart).toISOString().slice(0, 10);
    const metrics = followerMetricsByDay.get(key) ?? new Set<string>();
    metrics.add(row.metric);
    followerMetricsByDay.set(key, metrics);
  }
  const dailyFollowerDays = [...followerMetricsByDay.values()].filter(
    (metrics) => metrics.has("followers_gained") && metrics.has("followers_lost"),
  ).length;

  return {
    ready: totalMetricsReady && dailyReachDays >= expectedDays && dailyFollowerDays >= expectedDays && postsMissingFinalizedSnapshots === 0,
    totalMetricsReady,
    dailyReachReady: dailyReachDays >= expectedDays,
    dailyFollowersReady: dailyFollowerDays >= expectedDays,
    postsReady: postsMissingFinalizedSnapshots === 0,
  };
}

async function fetchMissingAccountTotals(
  connectionId: string,
  accountId: string,
  token: string,
  period: CompletedMonthPeriod,
) {
  const totals = await fetchCompletedMonthTotals(accountId, token, period);
  if (!totals) return false;
  await storeCompletedMonthTotals(connectionId, period, totals);
  return true;
}

async function fetchMissingDailySnapshots(
  connectionId: string,
  accountId: string,
  token: string,
  period: CompletedMonthPeriod,
  now: Date,
) {
  const periodStart = startOfDayUTC(period.start);
  const periodEnd = endOfDayUTC(period.end);

  const [reachRows, followerRows] = await Promise.all([
    db.socialInsightSnapshot.findMany({
      where: {
        connectionId,
        metric: "reach",
        periodType: InsightPeriodType.DAY,
        periodEnd: { gte: periodStart, lte: periodEnd },
      },
      select: { periodEnd: true },
    }),
    db.socialInsightSnapshot.findMany({
      where: {
        connectionId,
        metric: { in: ["followers_gained", "followers_lost"] },
        periodType: InsightPeriodType.DAY,
        periodStart: { gte: periodStart, lte: periodEnd },
      },
      select: { metric: true, periodStart: true },
    }),
  ]);

  const toDayKey = (date: Date) => startOfDayUTC(date).toISOString().slice(0, 10);
  const reachDays = new Set(reachRows.map((row) => toDayKey(row.periodEnd)));
  const followerMetricsByDay = new Map<string, Set<string>>();
  for (const row of followerRows) {
    const key = toDayKey(row.periodStart);
    const metrics = followerMetricsByDay.get(key) ?? new Set<string>();
    metrics.add(row.metric);
    followerMetricsByDay.set(key, metrics);
  }

  const rangeEnd = periodEnd < now ? periodEnd : now;
  const expectedDays = daysBetweenInclusive(periodStart, periodEnd);
  const missingReachDays: Date[] = [];
  const missingFollowerDays: Date[] = [];
  const current = startOfDayUTC(periodStart);
  const end = startOfDayUTC(rangeEnd);
  while (current <= end) {
    const day = new Date(current);
    if (!reachDays.has(toDayKey(day))) missingReachDays.push(day);
    const followerMetrics = followerMetricsByDay.get(toDayKey(day));
    if (!followerMetrics?.has("followers_gained") || !followerMetrics.has("followers_lost")) missingFollowerDays.push(day);
    current.setUTCDate(current.getUTCDate() + 1);
  }

  // If we already have enough daily snapshots for the whole period, nothing to do.
  if (missingReachDays.length === 0 && missingFollowerDays.length === 0) return { fetchedAny: false };

  const config = getHistoricalBackfillConfig();
  const lookbackStart = new Date(Date.now() - config.accountInsightMaxLookbackDays * 24 * 60 * 60 * 1000);
  let fetchedAny = false;
  let fetches = 0;

  for (const day of missingReachDays.slice(0, CLOSEOUT_MAX_DAILY_SNAPSHOT_FETCHES)) {
    const since = day;
    const until = new Date(since.valueOf() + 24 * 60 * 60 * 1000);
    await fetchAndStoreAccountInsight(connectionId, accountId, token, "reach", InsightPeriodType.DAY, since, until, lookbackStart);
    fetchedAny = true;
    fetches += 1;
  }

  for (const day of missingFollowerDays.slice(0, Math.max(0, CLOSEOUT_MAX_DAILY_SNAPSHOT_FETCHES - fetches))) {
    const fetched = await fetchAndStoreDailyFollowerMovement(connectionId, accountId, token, day, false);
    if (fetched) fetchedAny = true;
    fetches += 1;
  }

  return { fetchedAny };
}

async function refreshPostsInMonth(
  connectionId: string,
  accountId: string,
  token: string,
  period: CompletedMonthPeriod,
) {
  const periodStart = startOfDayUTC(period.start);
  const periodEnd = endOfDayUTC(period.end);

  const posts = await db.socialPost.findMany({
    where: {
      connectionId,
      publishedAt: { gte: periodStart, lte: periodEnd },
      metricSnapshots: {
        none: { periodStart, periodEnd, finalizedAt: { not: null }, validityState: { not: "REPAIR_NEEDED" } },
      },
    },
    orderBy: { publishedAt: "desc" },
    take: CLOSEOUT_POST_REFRESH_BATCH_SIZE,
    select: {
      id: true,
      externalPostId: true,
      publishedAt: true,
      caption: true,
      mediaType: true,
      mediaUrl: true,
      thumbnailUrl: true,
      permalink: true,
      mediaSource: true,
      mediaMetadata: true,
      metrics: true,
      metricAvailabilityState: true,
    },
  });

  if (posts.length === 0) return { refreshed: 0, hasMore: false };

  for (const post of posts) {
    try {
      const insights = await postInsights(post.externalPostId, token);
      const metrics = (post.metrics ?? {}) as Record<string, unknown>;
      const item: MetaMedia = {
        id: post.externalPostId,
        caption: post.caption ?? undefined,
        media_type: post.mediaType,
        media_url: post.mediaUrl ?? undefined,
        thumbnail_url: post.thumbnailUrl ?? undefined,
        permalink: post.permalink ?? undefined,
        timestamp: post.publishedAt.toISOString(),
        like_count: typeof metrics.likes === "number" ? metrics.likes : undefined,
        comments_count: typeof metrics.comments === "number" ? metrics.comments : undefined,
      };
      await upsertPost(connectionId, item, insights, post.mediaSource as MediaSource, (post.mediaMetadata as Record<string, unknown> | null) ?? null);
    } catch (error) {
      // Do not abort the whole closeout because one post failed; the job will be re-enqueued and retried.
      logError("month_end_closeout.post_refresh_failed", error, { connectionId, accountId, externalPostId: post.externalPostId });
    }
  }

  return { refreshed: posts.length, hasMore: posts.length >= CLOSEOUT_POST_REFRESH_BATCH_SIZE };
}

async function runCloseoutForPeriod(
  connection: Awaited<ReturnType<typeof requireInstagramConnection>>,
  target: CompletedMonthPeriod,
  now: Date,
  context: { logLabel: string; periodTag?: string } = { logLabel: "month_end_closeout" },
  initialReadiness?: Awaited<ReturnType<typeof monthReadinessMetrics>>,
) {
  const token = decryptToken(connection.encryptedToken);
  const targetMonthKey = `${target.start.getUTCFullYear()}-${String(target.start.getUTCMonth() + 1).padStart(2, "0")}`;
  logEvent(`${context.logLabel}.started`, { connectionId: connection.id, targetMonth: targetMonthKey, periodTag: context.periodTag });

  const readiness = initialReadiness ?? (await monthReadinessMetrics(connection.id, target));
  let workDone = false;

  if (!readiness.totalMetricsReady) {
    const ok = await fetchMissingAccountTotals(connection.id, connection.externalAccountId, token, target);
    if (ok) workDone = true;
  }

  if (!readiness.dailyReachReady || !readiness.dailyFollowersReady) {
    const { fetchedAny } = await fetchMissingDailySnapshots(connection.id, connection.externalAccountId, token, target, now);
    if (fetchedAny) workDone = true;
  }

  const postRefresh = await refreshPostsInMonth(connection.id, connection.externalAccountId, token, target);
  if (postRefresh.refreshed > 0) workDone = true;

  const finalReadiness = await monthReadinessMetrics(connection.id, target);
  const completed = finalReadiness.ready && !postRefresh.hasMore;

  logEvent(`${context.logLabel}.finished`, {
    connectionId: connection.id,
    targetMonth: targetMonthKey,
    periodTag: context.periodTag,
    completed,
    workDone,
    postsRefreshed: postRefresh.refreshed,
  });

  return { posts: postRefresh.refreshed, completed };
}

/** One bounded, targeted closeout run for the most recent finalized calendar month that still lacks
 * required report data. Fetches only missing account totals, missing daily reach/follower snapshots,
 * and refreshes a small batch of stale posts. Returns `completed: true` only when no more work is
 * detected for that month; otherwise the scheduler will re-enqueue another chunk. */
export async function runMonthEndCloseout(connectionId: string, now: Date = new Date()) {
  const connection = await requireInstagramConnection(connectionId);
  const targetInfo = await findFirstIncompleteCompletedMonthInRange(connectionId, now);
  if (!targetInfo) {
    logEvent("month_end_closeout.nothing_to_close", { connectionId });
    return { posts: 0, completed: true };
  }
  return runCloseoutForPeriod(connection, targetInfo.period, now, { logLabel: "month_end_closeout" }, targetInfo.readiness);
}

/** Targeted closeout for an explicitly requested report period (e.g., an older month opened by an
 * employee). Processes one incomplete finalized calendar month within the period per run and returns
 * `completed: true` only once every month in the range is ready. */
export async function runReportPeriodCloseout(connectionId: string, periodStart: Date, periodEnd: Date, now: Date = new Date()) {
  const connection = await requireInstagramConnection(connectionId);
  const targetInfo = await findFirstIncompleteCompletedMonthInRange(connectionId, now, { minStart: periodStart, maxEnd: periodEnd });
  if (!targetInfo) {
    logEvent("report_period_closeout.nothing_to_close", { connectionId, periodStart: periodStart.toISOString(), periodEnd: periodEnd.toISOString() });
    return { posts: 0, completed: true };
  }
  return runCloseoutForPeriod(connection, targetInfo.period, now, {
    logLabel: "report_period_closeout",
    periodTag: `${periodStart.toISOString()}_${periodEnd.toISOString()}`,
  }, targetInfo.readiness);
}
