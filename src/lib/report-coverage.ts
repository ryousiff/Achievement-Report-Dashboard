import { BackfillStatus, SyncJobStatus, SyncJobType } from "@prisma/client";
import { db } from "@/lib/db";
import { calculateBackfillStart } from "@/lib/backfill-window";
import { getHistoricalBackfillConfig } from "@/lib/env";

export type CoverageStatus = "COMPLETE" | "PARTIAL" | "SYNCING" | "UNAVAILABLE" | "FAILED";

export type MetricCoverage = { from: Date | null; to: Date | null; complete: boolean };

export type PostInsightCoverage = { availableMetrics: string[]; missingMetrics: string[] };

export type ReportCoverage = {
  status: CoverageStatus;
  mediaCoverage: MetricCoverage;
  postInsightCoverage: PostInsightCoverage;
  reachCoverage: MetricCoverage;
  followsCoverage: MetricCoverage;
  storyCoverage: { status: "NOT_COLLECTED" };
  historicalBackfillStatus: BackfillStatus;
  missingRanges: Array<{ start: string; end: string; reason: string }>;
  warnings: string[];
};

const trackedMetrics = ["reach", "views", "total_interactions", "likes", "comments", "saved", "shares", "follows"] as const;

type TrackedMetric = (typeof trackedMetrics)[number];

function toISODate(date: Date) {
  return date.toISOString().slice(0, 10);
}

function startOfDayUTC(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function daysBetweenInclusive(from: Date, to: Date) {
  const start = startOfDayUTC(from);
  const end = startOfDayUTC(to);
  return Math.max(1, Math.floor((end.valueOf() - start.valueOf()) / (24 * 60 * 60 * 1000)) + 1);
}

function isMetricAvailable(post: { metrics: Record<string, unknown>; metricAvailabilityState: Record<string, string> | null }, metric: TrackedMetric) {
  const state = post.metricAvailabilityState?.[metric];
  if (state === "AVAILABLE") return true;
  if (state === "NOT_SUPPORTED" || state === "NOT_RETURNED" || state === "FAILED" || state === "PENDING") return false;
  if (state === undefined || state === null) {
    return typeof post.metrics[metric] === "number";
  }
  return false;
}

function buildMissingRange(start: Date, end: Date, reason: string): { start: string; end: string; reason: string } {
  return { start: toISODate(start), end: toISODate(end), reason };
}

export async function getCoverage(connectionId: string, periodStart: Date, periodEnd: Date): Promise<ReportCoverage> {
  const connection = await db.socialConnection.findUnique({
    where: { id: connectionId },
    select: {
      id: true,
      historicalBackfillStatus: true,
      historicalBackfillStart: true,
      historicalBackfillLastError: true,
      reachCoverageStart: true,
      followsCoverageStart: true,
      accountInsightsLastSyncedAt: true,
      accountInsightsBackfillCompletedAt: true,
      accountInsightsLastError: true,
      lastSuccessfulSyncAt: true,
    },
  });

  const empty: ReportCoverage = {
    status: "UNAVAILABLE",
    mediaCoverage: { from: null, to: null, complete: false },
    postInsightCoverage: { availableMetrics: [], missingMetrics: [] },
    reachCoverage: { from: null, to: null, complete: false },
    followsCoverage: { from: null, to: null, complete: false },
    storyCoverage: { status: "NOT_COLLECTED" },
    historicalBackfillStatus: BackfillStatus.NOT_STARTED,
    missingRanges: [],
    warnings: ["لا يوجد ربط بإنستغرام لهذا العميل."],
  };

  if (!connection) return empty;

  const activeJobs = await db.syncJob.findMany({
    where: { connectionId, status: { in: [SyncJobStatus.QUEUED, SyncJobStatus.RUNNING] } },
    select: { type: true, status: true },
  });

  const activeBackfill =
    connection.historicalBackfillStatus === BackfillStatus.RUNNING ||
    connection.historicalBackfillStatus === BackfillStatus.PARTIAL ||
    activeJobs.some((job) => job.type === SyncJobType.HISTORICAL_MEDIA_BACKFILL);

  const activeInsights = activeJobs.some((job) => job.type === SyncJobType.DAILY_ACCOUNT_INSIGHT_SYNC);

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

  const backfillStart = connection.historicalBackfillStart ?? calculateBackfillStart(new Date(), getHistoricalBackfillConfig().months);
  const mediaFrom = allPostsRange._min.publishedAt;
  const mediaTo = allPostsRange._max.publishedAt;
  const hasAnyPost = Boolean(mediaFrom) && Boolean(mediaTo);

  let mediaComplete = false;
  if (connection.historicalBackfillStatus === BackfillStatus.COMPLETED && periodStart >= backfillStart) {
    mediaComplete = true;
  } else if (mediaFrom && mediaFrom <= periodStart && connection.lastSuccessfulSyncAt && connection.lastSuccessfulSyncAt >= periodEnd) {
    mediaComplete = true;
  }

  // Reach/follows daily snapshot coverage
  async function insightCoverage(metric: "reach" | "follows") {
    const snapshots = await db.socialInsightSnapshot.findMany({
      where: { connectionId, metric, periodEnd: { gte: periodStart, lte: periodEnd } },
      select: { periodEnd: true },
    });
    const days = new Set(snapshots.map((snapshot) => toISODate(snapshot.periodEnd)));
    const expectedDays = daysBetweenInclusive(periodStart, periodEnd);
    const complete = days.size >= expectedDays;
    const from = metric === "reach" ? connection!.reachCoverageStart : connection!.followsCoverageStart;
    const maxPeriodEnd = snapshots.length ? new Date(Math.max(...snapshots.map((snapshot) => snapshot.periodEnd.valueOf()))) : null;
    return { from, to: maxPeriodEnd, complete, days: days.size, expectedDays };
  }

  const reach = await insightCoverage("reach");
  const follows = await insightCoverage("follows");

  // Post-level insight coverage for the requested period
  const posts = await db.socialPost.findMany({
    where: { connectionId, publishedAt: { gte: periodStart, lte: periodEnd } },
    select: { metrics: true, metricAvailabilityState: true },
  });

  const metricCounts = new Map<TrackedMetric, { available: number; missing: number }>();
  for (const metric of trackedMetrics) metricCounts.set(metric, { available: 0, missing: 0 });

  for (const post of posts) {
    const typedPost = {
      metrics: (post.metrics ?? {}) as Record<string, unknown>,
      metricAvailabilityState: (post.metricAvailabilityState ?? null) as Record<string, string> | null,
    };
    for (const metric of trackedMetrics) {
      const counts = metricCounts.get(metric)!;
      if (isMetricAvailable(typedPost, metric)) counts.available++;
      else counts.missing++;
    }
  }

  const availableMetrics: string[] = [];
  const missingMetrics: string[] = [];
  for (const [metric, counts] of metricCounts) {
    if (counts.available > 0) availableMetrics.push(metric);
    if (counts.missing > 0) missingMetrics.push(metric);
  }

  const insightsComplete = posts.length > 0 ? missingMetrics.length === 0 : true;

  // Build missing ranges and warnings
  const missingRanges: Array<{ start: string; end: string; reason: string }> = [];
  const warnings: string[] = [];

  if (!mediaComplete) {
    if (!hasAnyPost) {
      warnings.push("لا توجد منشورات متزامنة لهذه الفترة.");
      missingRanges.push(buildMissingRange(periodStart, periodEnd, "لا توجد منشورات متزامنة لهذه الفترة."));
    } else if (mediaFrom && mediaFrom > periodStart) {
      const end = new Date(mediaFrom.valueOf() - 1);
      const cappedEnd = end > periodEnd ? periodEnd : end;
      missingRanges.push(buildMissingRange(periodStart, cappedEnd, "قد تكون منشورات بداية الفترة غير متزامنة بعد."));
      warnings.push(`تغطية المنشورات تبدأ من ${toISODate(mediaFrom)}؛ قد تكون بداية الفترة غير مكتملة.`);
    } else if (postsInPeriod._count === 0) {
      warnings.push("لم يُعثر على منشورات داخل هذه الفترة.");
    } else if (connection.lastSuccessfulSyncAt && connection.lastSuccessfulSyncAt < periodEnd) {
      warnings.push("آخر مزامنة ناجحة قبل نهاية الفترة؛ قد تكون المنشورات الأحدث غير متزامنة.");
    } else {
      warnings.push("تغطية المنشورات غير مكتملة.");
    }
  }

  if (!reach.complete) {
    if (!connection.reachCoverageStart) {
      warnings.push("لا تتوفر بيانات وصول يومية للحساب في هذه الفترة.");
      missingRanges.push(buildMissingRange(periodStart, periodEnd, "لا توجد بيانات وصول يومية متزامنة."));
    } else if (connection.reachCoverageStart > periodStart) {
      const end = new Date(connection.reachCoverageStart.valueOf() - 1);
      const cappedEnd = end > periodEnd ? periodEnd : end;
      missingRanges.push(buildMissingRange(periodStart, cappedEnd, "بيانات الوصول اليومية غير متاحة قبل هذا التاريخ."));
      warnings.push(`تغطية الوصول تبدأ من ${toISODate(connection.reachCoverageStart)}؛ قد تكون بداية الفترة غير مكتملة.`);
    } else {
      warnings.push("بيانات الوصول اليومية ناقصة لبعض أيام الفترة.");
    }
  }

  if (!follows.complete) {
    if (!connection.followsCoverageStart) {
      warnings.push("لا تتوفر بيانات متابعين جدد يومية للحساب في هذه الفترة.");
      missingRanges.push(buildMissingRange(periodStart, periodEnd, "لا توجد بيانات متابعين يومية متزامنة."));
    } else if (connection.followsCoverageStart > periodStart) {
      const end = new Date(connection.followsCoverageStart.valueOf() - 1);
      const cappedEnd = end > periodEnd ? periodEnd : end;
      missingRanges.push(buildMissingRange(periodStart, cappedEnd, "بيانات المتابعين اليومية غير متاحة قبل هذا التاريخ."));
      warnings.push(`تغطية المتابعين تبدأ من ${toISODate(connection.followsCoverageStart)}؛ قد تكون بداية الفترة غير مكتملة.`);
    } else {
      warnings.push("بيانات المتابعين اليومية ناقصة لبعض أيام الفترة.");
    }
  }

  if (!insightsComplete) {
    warnings.push(`بعض المنشورات تفتقر إلى مؤشرات: ${missingMetrics.map((metric) => ({ reach: "الوصول", views: "المشاهدات", total_interactions: "التفاعل", likes: "الإعجابات", comments: "التعليقات", saved: "الحفظ", shares: "المشاركات", follows: "المتابعون الجدد" })[metric as TrackedMetric] ?? metric).join("، ")}.`);
  }

  // Final status
  let status: CoverageStatus;
  const allComplete = mediaComplete && reach.complete && follows.complete && insightsComplete;

  if (connection.historicalBackfillStatus === BackfillStatus.FAILED) {
    status = allComplete ? "PARTIAL" : "FAILED";
    if (status === "FAILED") warnings.unshift(connection.historicalBackfillLastError ?? "فشل التحميل التاريخي للبيانات.");
    else warnings.unshift("فشل التحميل التاريخي لكن بعض البيانات المتزامنة متاحة.");
  } else if (activeBackfill && !mediaComplete) {
    status = "SYNCING";
    warnings.unshift("جارٍ تحميل البيانات التاريخية. أعدي فتح التقرير أو تحديث البيانات لاحقاً.");
  } else if (activeInsights && (!reach.complete || !follows.complete)) {
    status = "SYNCING";
    warnings.unshift("جارٍ تحميل بيانات الوصول/المتابعين اليومية.");
  } else if (allComplete) {
    status = "COMPLETE";
  } else if (hasAnyPost || reach.days > 0 || follows.days > 0 || postsInPeriod._count > 0) {
    status = "PARTIAL";
  } else {
    status = "UNAVAILABLE";
  }

  return {
    status,
    mediaCoverage: { from: mediaFrom, to: mediaTo, complete: mediaComplete },
    postInsightCoverage: { availableMetrics, missingMetrics },
    reachCoverage: { from: reach.from, to: reach.to, complete: reach.complete },
    followsCoverage: { from: follows.from, to: follows.to, complete: follows.complete },
    storyCoverage: { status: "NOT_COLLECTED" },
    historicalBackfillStatus: connection.historicalBackfillStatus,
    missingRanges,
    warnings,
  };
}
