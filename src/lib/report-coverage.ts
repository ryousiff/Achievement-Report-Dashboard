import { BackfillStatus, InsightPeriodType, SyncJobStatus, SyncJobType } from "@prisma/client";
import { db } from "@/lib/db";
import { calculateBackfillStart } from "@/lib/backfill-window";
import { getHistoricalBackfillConfig } from "@/lib/env";
import { periodAccountFollowersForRange, periodAccountReachForRange } from "@/lib/report-data";
import { storedAccountFollowersForRange, storedAccountReachForRange } from "@/lib/stored-period-metrics";
import { isMonthFinalized, resolveReportPostMetrics } from "@/lib/post-metric-snapshots";
import { logEvent } from "@/lib/observability";

export const PREPARING_MONTH_MESSAGE = "جاري تجهيز بيانات الشهر";
export const CLOSING_MONTH_MESSAGE = "جاري إغلاق بيانات الشهر";
export const READY_FOR_APPROVAL_MESSAGE = "البيانات جاهزة للاعتماد";
export const STALLED_INCOMPLETE_MESSAGE = "بيانات الشهر غير مكتملة، ويجري تجهيز استكمالها تلقائياً.";
export const NO_CONNECTION_EMPLOYEE_MESSAGE = "لا يوجد ربط بإنستغرام لهذا العميل.";

export type CoverageStatus = "COMPLETE" | "PARTIAL" | "SYNCING" | "UNAVAILABLE" | "FAILED";

export type MetricCoverage = { from: Date | null; to: Date | null; complete: boolean };

export type PostInsightCoverage = { availableMetrics: string[]; unsupportedMetrics: string[]; missingMetrics: string[] };

export type ReachCoverageStatus = "DAILY_COMPLETE" | "DAILY_PARTIAL" | "PERIOD_AVAILABLE" | "PERIOD_ESTIMATED" | "DAYS_28_AVAILABLE" | "PERIOD_UNAVAILABLE";
export type FollowerCoverageStatus = "DAILY_COMPLETE" | "DAILY_PARTIAL" | "PERIOD_AVAILABLE" | "PERIOD_DERIVED" | "UNAVAILABLE";

export type ReportCoverage = {
  status: CoverageStatus;
  mediaCoverage: MetricCoverage;
  postInsightCoverage: PostInsightCoverage;
  reachCoverage: MetricCoverage;
  reach28DayCoverage: MetricCoverage;
  followerCountCoverage: MetricCoverage;
  followsCoverage: MetricCoverage;
  reachStatus: ReachCoverageStatus;
  followerStatus: FollowerCoverageStatus;
  followersGained: number | null;
  followersLost: number | null;
  netFollowerGrowth: number | null;
  storyCoverage: { status: "NOT_COLLECTED" };
  historicalBackfillStatus: BackfillStatus;
  collaborativeBackfillStatus: BackfillStatus;
  missingRanges: Array<{ start: string; end: string; reason: string }>;
  warnings: string[];
};

const trackedMetrics = ["reach", "views", "total_views", "total_interactions", "likes", "comments", "saved", "shares", "follows"] as const;

type TrackedMetric = (typeof trackedMetrics)[number];

function toISODate(date: Date) {
  return date.toISOString().slice(0, 10);
}

function startOfDayUTC(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function endOfDayUTC(date: Date) {
  const d = startOfDayUTC(date);
  d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCMilliseconds(d.getUTCMilliseconds() - 1);
  return d;
}

function daysBetweenInclusive(from: Date, to: Date) {
  const start = startOfDayUTC(from);
  const end = startOfDayUTC(to);
  return Math.max(1, Math.floor((end.valueOf() - start.valueOf()) / (24 * 60 * 60 * 1000)) + 1);
}

function metricCoverageState(
  post: { metrics: Record<string, unknown>; metricAvailabilityState: Record<string, string> | null },
  metric: TrackedMetric,
): "AVAILABLE" | "NOT_SUPPORTED" | "MISSING" {
  const state = post.metricAvailabilityState?.[metric];
  if (state === "AVAILABLE") return "AVAILABLE";
  if (state === "NOT_SUPPORTED") return "NOT_SUPPORTED";
  if (state === undefined || state === null) {
    return typeof post.metrics[metric] === "number" ? "AVAILABLE" : "MISSING";
  }
  return "MISSING";
}

function buildMissingRange(start: Date, end: Date, reason: string): { start: string; end: string; reason: string } {
  return { start: toISODate(start), end: toISODate(end), reason };
}

function reportPeriodCloseoutOverlaps(payload: unknown, periodStart: Date, periodEnd: Date): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const value = payload as Record<string, unknown>;
  if (typeof value.periodStart !== "string" || typeof value.periodEnd !== "string") return false;
  const jobStart = new Date(value.periodStart);
  const jobEnd = new Date(value.periodEnd);
  if (Number.isNaN(jobStart.valueOf()) || Number.isNaN(jobEnd.valueOf())) return false;
  return jobStart <= periodEnd && jobEnd >= periodStart;
}

export async function getCoverage(
  connectionId: string,
  periodStart: Date,
  periodEnd: Date,
  options: { storedOnly?: boolean } = {},
): Promise<ReportCoverage> {
  const connection = await db.socialConnection.findUnique({
    where: { id: connectionId },
    select: {
      id: true,
      clientId: true,
      historicalBackfillStatus: true,
      historicalBackfillStart: true,
      historicalBackfillLastError: true,
      collaborativeBackfillStatus: true,
      collaborativeBackfillStart: true,
      collaborativeBackfillLastError: true,
      reachCoverageStart: true,
      reachWeekCoverageStart: true,
      reachDays28CoverageStart: true,
      followerCountCoverageStart: true,
      accountInsightsLastSyncedAt: true,
      accountInsightsBackfillCompletedAt: true,
      accountInsightsLastError: true,
      lastSuccessfulSyncAt: true,
      historicalBackfillRetryCount: true,
      collaborativeBackfillRetryCount: true,
    },
  });

  const empty: ReportCoverage = {
    status: "UNAVAILABLE",
    mediaCoverage: { from: null, to: null, complete: false },
    postInsightCoverage: { availableMetrics: [], unsupportedMetrics: [], missingMetrics: [] },
    reachCoverage: { from: null, to: null, complete: false },
    reach28DayCoverage: { from: null, to: null, complete: false },
    followerCountCoverage: { from: null, to: null, complete: false },
    followsCoverage: { from: null, to: null, complete: false },
    reachStatus: "PERIOD_UNAVAILABLE",
    followerStatus: "UNAVAILABLE",
    followersGained: null,
    followersLost: null,
    netFollowerGrowth: null,
    storyCoverage: { status: "NOT_COLLECTED" },
    historicalBackfillStatus: BackfillStatus.NOT_STARTED,
    collaborativeBackfillStatus: BackfillStatus.NOT_STARTED,
    missingRanges: [],
    warnings: [NO_CONNECTION_EMPLOYEE_MESSAGE],
  };

  if (!connection) return empty;

  const activeJobs = await db.syncJob.findMany({
    where: { connectionId, status: { in: [SyncJobStatus.QUEUED, SyncJobStatus.RUNNING] } },
    select: { type: true, status: true, payload: true },
  });

  // Media (post) coverage
  const postsInPeriod = await db.socialPost.aggregate({
    where: { connectionId, publishedAt: { gte: periodStart, lte: periodEnd } },
    _min: { publishedAt: true },
    _max: { publishedAt: true },
    _count: true,
  });

  const allPostsRange = await db.socialPost.aggregate({
    where: { connectionId },
    _min: { publishedAt: true },
    _max: { publishedAt: true },
  });

  const ownedBackfillStart = connection.historicalBackfillStart ?? calculateBackfillStart(new Date(), getHistoricalBackfillConfig().months);
  const collabBackfillStart = connection.collaborativeBackfillStart ?? ownedBackfillStart;
  const backfillStart = ownedBackfillStart < collabBackfillStart ? ownedBackfillStart : collabBackfillStart;
  const mediaFrom = allPostsRange._min.publishedAt;
  const mediaTo = allPostsRange._max.publishedAt;
  const hasAnyPost = Boolean(mediaFrom) && Boolean(mediaTo);

  const backfillComplete =
    connection.historicalBackfillStatus === BackfillStatus.COMPLETED &&
    connection.collaborativeBackfillStatus === BackfillStatus.COMPLETED;

  let mediaComplete = false;
  if (backfillComplete && periodStart >= backfillStart) {
    mediaComplete = true;
  } else if (
    mediaFrom &&
    mediaFrom <= periodStart &&
    connection.lastSuccessfulSyncAt &&
    connection.lastSuccessfulSyncAt >= periodEnd &&
    connection.collaborativeBackfillStatus === BackfillStatus.COMPLETED
  ) {
    mediaComplete = true;
  }

  // Reach/follows daily snapshot coverage
  async function insightCoverage(metric: string, periodType: InsightPeriodType) {
    const snapshots = await db.socialInsightSnapshot.findMany({
      where: { connectionId, metric, periodType, periodEnd: { gte: startOfDayUTC(periodStart), lte: endOfDayUTC(periodEnd) } },
      select: { periodEnd: true },
    });
    const days = new Set(snapshots.map((snapshot) => toISODate(snapshot.periodEnd)));
    const expectedDays = daysBetweenInclusive(periodStart, periodEnd);
    const complete = days.size >= expectedDays;
    const from =
      metric === "reach" && periodType === InsightPeriodType.DAY
        ? connection!.reachCoverageStart
        : metric === "reach" && periodType === InsightPeriodType.WEEK
          ? connection!.reachWeekCoverageStart
          : metric === "reach" && periodType === InsightPeriodType.DAYS_28
            ? connection!.reachDays28CoverageStart
            : metric === "follower_count"
              ? connection!.followerCountCoverageStart
              : null;
    const maxPeriodEnd = snapshots.length ? new Date(Math.max(...snapshots.map((snapshot) => snapshot.periodEnd.valueOf()))) : null;
    return { from, to: maxPeriodEnd, complete, days: days.size, expectedDays };
  }

  const reachDaily = await insightCoverage("reach", InsightPeriodType.DAY);
  const reach28Day = await insightCoverage("reach", InsightPeriodType.DAYS_28);
  const followerCount = await insightCoverage("follower_count", InsightPeriodType.DAY);

  // Is there a 7-day or 28-day Reach window ending at the end of this report period?
  // These are the only legitimately API-provided unique-Reach values that may exist
  // even when the full calendar month (30/31 days) does not.
  const days28AtPeriodEnd = await db.socialInsightSnapshot.findMany({
    take: 1,
    where: {
      connectionId,
      metric: "reach",
      periodType: InsightPeriodType.DAYS_28,
      periodEnd: { gte: startOfDayUTC(periodEnd), lte: endOfDayUTC(periodEnd) },
    },
    select: { value: true },
  });
  const hasDays28AtPeriodEnd = days28AtPeriodEnd.length > 0;

  // Use the same Reach resolver the report builder uses: total_value for <=30 days,
  // overlapping-window estimate for 31 days. Never rely on summed daily snapshots.
  const reach = options.storedOnly
    ? await storedAccountReachForRange(connection.clientId, periodStart, periodEnd)
    : await periodAccountReachForRange(connection.clientId, periodStart, periodEnd);
  let reachStatus: ReachCoverageStatus = "PERIOD_UNAVAILABLE";
  let periodReachValue: number | null = reach.value;
  if (reach.value !== null) {
    reachStatus = reach.accuracy === "ESTIMATED" ? "PERIOD_ESTIMATED" : "PERIOD_AVAILABLE";
  } else if (hasDays28AtPeriodEnd) {
    reachStatus = "DAYS_28_AVAILABLE";
  } else if (reachDaily.complete) {
    reachStatus = "DAILY_COMPLETE";
  } else if (reachDaily.days > 0) {
    reachStatus = "DAILY_PARTIAL";
  }

  // Use the same Followers resolver the report builder uses.
  const followers = options.storedOnly
    ? await storedAccountFollowersForRange(connection.clientId, periodStart, periodEnd)
    : await periodAccountFollowersForRange(connection.clientId, periodStart, periodEnd);
  let followerStatus: FollowerCoverageStatus = "UNAVAILABLE";
  if (followers.gained !== null && followers.lost !== null) {
    followerStatus = followers.accuracy === "DERIVED" ? "PERIOD_DERIVED" : "PERIOD_AVAILABLE";
  }
  const followsCoverage = {
    from: followerStatus !== "UNAVAILABLE" ? periodStart : null,
    to: followerStatus !== "UNAVAILABLE" ? periodEnd : null,
    complete: followerStatus !== "UNAVAILABLE",
  };

  // Post-level insight coverage for the requested period
  const posts = await db.socialPost.findMany({
    where: { connectionId, publishedAt: { gte: periodStart, lte: periodEnd } },
    select: { id: true, publishedAt: true, metrics: true, metricAvailabilityState: true },
  });

  const reportFinalized = isMonthFinalized(periodEnd, new Date());
  const postsForResolution = posts.map((post, index) => ({
    id: post.id ?? `coverage-post-${index}`,
    publishedAt: post.publishedAt ?? periodStart,
    metrics: (post.metrics ?? {}) as Record<string, unknown>,
    metricAvailabilityState: (post.metricAvailabilityState ?? null) as Record<string, unknown> | null,
  }));
  const resolvedPostMetrics = reportFinalized ? await resolveReportPostMetrics(postsForResolution) : null;

  const metricCounts = new Map<TrackedMetric, { available: number; unsupported: number; missing: number }>();
  for (const metric of trackedMetrics) metricCounts.set(metric, { available: 0, unsupported: 0, missing: 0 });

  for (const [index, post] of posts.entries()) {
    const resolved = resolvedPostMetrics?.get(postsForResolution[index].id);
    const snapshotMetrics = resolved?.source === "SNAPSHOT" ? {
      views: resolved.metrics.views,
      ...(resolved.metrics.totalViews !== null ? { total_views: resolved.metrics.totalViews } : {}),
      total_interactions: resolved.metrics.totalInteractions,
      likes: resolved.metrics.likes,
      comments: resolved.metrics.comments,
      saved: resolved.metrics.saved,
      shares: resolved.metrics.shares,
      follows: resolved.metrics.follows,
    } : {};
    const snapshotAvailability = resolved?.source === "SNAPSHOT"
      ? Object.fromEntries(Object.entries(resolved.availability).map(([metric, state]) => [metric, state]))
      : {};
    const typedPost = {
      metrics: { ...((post.metrics ?? {}) as Record<string, unknown>), ...snapshotMetrics },
      metricAvailabilityState: {
        ...(((post.metricAvailabilityState ?? null) as Record<string, string> | null) ?? {}),
        ...snapshotAvailability,
        ...(reportFinalized ? { reach: "NOT_SUPPORTED" } : {}),
      },
    };
    for (const metric of trackedMetrics) {
      const counts = metricCounts.get(metric)!;
      const state = metricCoverageState(typedPost, metric);
      if (state === "AVAILABLE") counts.available++;
      else if (state === "NOT_SUPPORTED") counts.unsupported++;
      else counts.missing++;
    }
  }

  const availableMetrics: string[] = [];
  const unsupportedMetrics: string[] = [];
  const missingMetrics: string[] = [];
  for (const [metric, counts] of metricCounts) {
    if (counts.available > 0) availableMetrics.push(metric);
    if (counts.unsupported > 0) unsupportedMetrics.push(metric);
    if (counts.missing > 0) missingMetrics.push(metric);
  }

  const insightsComplete = posts.length > 0 ? missingMetrics.length === 0 : true;

  // Build structured missing-range diagnostics for administrators/developers. Employee-facing
  // warnings are simplified below so raw errors and internal statuses never appear in the UI.
  const missingRanges: Array<{ start: string; end: string; reason: string }> = [];

  if (!mediaComplete) {
    if (!hasAnyPost) {
      missingRanges.push(buildMissingRange(periodStart, periodEnd, "لا توجد منشورات متزامنة لهذه الفترة."));
    } else if (mediaFrom && mediaFrom > periodStart) {
      const end = new Date(mediaFrom.valueOf() - 1);
      const cappedEnd = end > periodEnd ? periodEnd : end;
      missingRanges.push(buildMissingRange(periodStart, cappedEnd, "قد تكون منشورات بداية الفترة غير متزامنة بعد."));
    } else if (postsInPeriod._count === 0) {
      missingRanges.push(buildMissingRange(periodStart, periodEnd, "لم يُعثر على منشورات داخل هذه الفترة."));
    } else if (connection.lastSuccessfulSyncAt && connection.lastSuccessfulSyncAt < periodEnd) {
      missingRanges.push(buildMissingRange(periodEnd, periodEnd, "آخر مزامنة ناجحة قبل نهاية الفترة."));
    } else {
      missingRanges.push(buildMissingRange(periodStart, periodEnd, "بيانات المنشورات لا تزال قيد المزامنة لهذه الفترة."));
    }
  }

  if (connection.collaborativeBackfillStatus !== BackfillStatus.COMPLETED) {
    missingRanges.push(buildMissingRange(periodStart, periodEnd, "بيانات المنشورات التعاونية لا تزال قيد المزامنة."));
  }

  if (reachStatus === "PERIOD_UNAVAILABLE") {
    if (reachDaily.days > 0) {
      missingRanges.push(buildMissingRange(periodStart, periodEnd, "لا يوجد Reach فريد للفترة بالكامل؛ متاح Reach يومي أو 28 يوم."));
    } else {
      missingRanges.push(buildMissingRange(periodStart, periodEnd, "لا توجد بيانات وصول متزامنة."));
    }
  } else if (reachStatus === "PERIOD_ESTIMATED") {
    missingRanges.push(buildMissingRange(periodStart, periodEnd, reach.tooltip ?? "Reach قيمة تقديرية؛ Meta API لا يوفر نافذة وصول فريدة مباشرة لمدة 31 يوماً."));
  } else if (reachStatus === "DAILY_PARTIAL") {
    missingRanges.push(buildMissingRange(periodStart, periodEnd, "بيانات الوصول اليومية ناقصة لبعض أيام الفترة."));
  } else if (reachStatus === "DAYS_28_AVAILABLE" && !periodReachValue) {
    missingRanges.push(buildMissingRange(periodStart, periodEnd, "بيانات الوصول الفريدة للفترة بالكامل غير متاحة؛ متاح Reach لآخر 28 يوم فقط."));
  }

  if (followerStatus === "UNAVAILABLE") {
    missingRanges.push(buildMissingRange(periodStart, periodEnd, "لا توجد بيانات follows_and_unfollows للفترة."));
  } else if (followerStatus === "PERIOD_DERIVED") {
    missingRanges.push(buildMissingRange(periodStart, periodEnd, followers.tooltip ?? "حركة المتابعين قيمة مركّبة لأن Meta API لا يسمح بنطاق 31 يوم مباشر."));
  }

  if (!insightsComplete) {
    missingRanges.push(buildMissingRange(periodStart, periodEnd, `بعض المنشورات تفتقر إلى مؤشرات: ${missingMetrics.join(", ")}.`));
  }

  // Final status is period-aware: only an overlapping explicit report closeout can put a finalized
  // report into the closing state. Generic connection work may target a different calendar month.
  let status: CoverageStatus;
  const reachReady = reachStatus === "PERIOD_AVAILABLE" || reachStatus === "PERIOD_ESTIMATED";
  const allComplete = mediaComplete && reachReady && followerStatus !== "UNAVAILABLE" && insightsComplete;

  const anyBackfillFailed =
    connection.historicalBackfillStatus === BackfillStatus.FAILED ||
    connection.collaborativeBackfillStatus === BackfillStatus.FAILED;

  const finalized = reportFinalized;
  const hasMatchingReportCloseout = activeJobs.some(
    (job) => job.type === SyncJobType.REPORT_PERIOD_CLOSEOUT && reportPeriodCloseoutOverlaps(job.payload, periodStart, periodEnd),
  );
  const hasRelevantHistoricalBackfill = !mediaComplete && activeJobs.some(
    (job) => job.type === SyncJobType.HISTORICAL_MEDIA_BACKFILL || job.type === SyncJobType.HISTORICAL_COLLABORATIVE_BACKFILL,
  );
  const hasOpenPeriodSync = !finalized && activeJobs.some(
    (job) => job.type === SyncJobType.INCREMENTAL_MEDIA_SYNC || job.type === SyncJobType.DAILY_ACCOUNT_INSIGHT_SYNC || job.type === SyncJobType.RECENT_POST_INSIGHT_REFRESH,
  );

  let warnings: string[] = [];
  if (allComplete) {
    status = "COMPLETE";
    warnings = [READY_FOR_APPROVAL_MESSAGE];
  } else if (finalized && hasMatchingReportCloseout) {
    status = "SYNCING";
    warnings = [CLOSING_MONTH_MESSAGE];
  } else if (hasRelevantHistoricalBackfill || hasOpenPeriodSync) {
    status = "SYNCING";
    warnings = [PREPARING_MONTH_MESSAGE];
  } else {
    // Incomplete and nothing is actively running. Tell the employee the data is incomplete and will
    // be auto-completed, but keep all technical diagnostics in the server logs only.
    status = anyBackfillFailed ? "FAILED" : hasAnyPost || reachDaily.days > 0 || followerCount.days > 0 || postsInPeriod._count > 0 ? "PARTIAL" : "UNAVAILABLE";
    warnings = [STALLED_INCOMPLETE_MESSAGE];
  }

  // Preserve full technical diagnostics for administrators/developers; never expose raw error
  // text in the employee-facing response.
  logEvent("report.coverage.diagnostics", {
    connectionId: connection.id,
    clientId: connection.clientId,
    periodStart: toISODate(periodStart),
    periodEnd: toISODate(periodEnd),
    status,
    historicalBackfillStatus: connection.historicalBackfillStatus,
    collaborativeBackfillStatus: connection.collaborativeBackfillStatus,
    activeJobs: activeJobs.map((job) => ({ type: job.type, status: job.status })),
    relevantWork: { hasMatchingReportCloseout, hasRelevantHistoricalBackfill, hasOpenPeriodSync },
    lastErrors: {
      historical: connection.historicalBackfillLastError,
      collaborative: connection.collaborativeBackfillLastError,
      accountInsights: connection.accountInsightsLastError,
    },
    lastSuccessfulSyncAt: connection.lastSuccessfulSyncAt,
    retryAttempts: {
      historical: connection.historicalBackfillRetryCount,
      collaborative: connection.collaborativeBackfillRetryCount,
    },
    mediaComplete,
    reachStatus,
    followerStatus,
    insightsComplete,
    unsupportedPostMetrics: unsupportedMetrics,
    missingRangesCount: missingRanges.length,
  });

  return {
    status,
    mediaCoverage: { from: mediaFrom, to: mediaTo, complete: mediaComplete },
    postInsightCoverage: { availableMetrics, unsupportedMetrics, missingMetrics },
    reachCoverage: { from: reachDaily.from, to: reachDaily.to, complete: reachDaily.complete },
    reach28DayCoverage: { from: reach28Day.from, to: reach28Day.to, complete: reach28Day.complete },
    followerCountCoverage: { from: followerCount.from, to: followerCount.to, complete: followerCount.complete },
    followsCoverage,
    reachStatus,
    followerStatus,
    followersGained: followers.gained,
    followersLost: followers.lost,
    netFollowerGrowth: followers.net,
    storyCoverage: { status: "NOT_COLLECTED" },
    historicalBackfillStatus: connection.historicalBackfillStatus,
    collaborativeBackfillStatus: connection.collaborativeBackfillStatus,
    missingRanges,
    warnings,
  };
}
