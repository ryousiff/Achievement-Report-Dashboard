import { BackfillStatus, InsightPeriodType, SyncJobStatus, SyncJobType } from "@prisma/client";
import { db } from "@/lib/db";
import { calculateBackfillStart } from "@/lib/backfill-window";
import { getHistoricalBackfillConfig } from "@/lib/env";
import { periodAccountFollowers, periodAccountReach } from "@/lib/report-data";

export type CoverageStatus = "COMPLETE" | "PARTIAL" | "SYNCING" | "UNAVAILABLE" | "FAILED";

export type MetricCoverage = { from: Date | null; to: Date | null; complete: boolean };

export type PostInsightCoverage = { availableMetrics: string[]; missingMetrics: string[] };

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

const trackedMetrics = ["reach", "views", "total_interactions", "likes", "comments", "saved", "shares", "follows"] as const;

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
    },
  });

  const empty: ReportCoverage = {
    status: "UNAVAILABLE",
    mediaCoverage: { from: null, to: null, complete: false },
    postInsightCoverage: { availableMetrics: [], missingMetrics: [] },
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
    warnings: ["لا يوجد ربط بإنستغرام لهذا العميل."],
  };

  if (!connection) return empty;

  const activeJobs = await db.syncJob.findMany({
    where: { connectionId, status: { in: [SyncJobStatus.QUEUED, SyncJobStatus.RUNNING] } },
    select: { type: true, status: true },
  });

  const activeOwnedBackfill =
    connection.historicalBackfillStatus === BackfillStatus.RUNNING ||
    connection.historicalBackfillStatus === BackfillStatus.PARTIAL ||
    activeJobs.some((job) => job.type === SyncJobType.HISTORICAL_MEDIA_BACKFILL);

  const activeCollabBackfill =
    connection.collaborativeBackfillStatus === BackfillStatus.RUNNING ||
    connection.collaborativeBackfillStatus === BackfillStatus.PARTIAL ||
    activeJobs.some((job) => job.type === SyncJobType.HISTORICAL_COLLABORATIVE_BACKFILL);

  const activeBackfill = activeOwnedBackfill || activeCollabBackfill;

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
  const reach = await periodAccountReach(connection.clientId, periodStart, periodEnd);
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
  const followers = await periodAccountFollowers(connection.clientId, periodStart, periodEnd);
  let followerStatus: FollowerCoverageStatus = "UNAVAILABLE";
  if (followers.gained !== null && followers.lost !== null) {
    followerStatus = followers.accuracy === "DERIVED" ? "PERIOD_DERIVED" : "PERIOD_AVAILABLE";
  }

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

  if (connection.collaborativeBackfillStatus !== BackfillStatus.COMPLETED) {
    warnings.push("مزامنة المنشورات التعاونية غير مكتملة لهذه الفترة.");
    missingRanges.push(buildMissingRange(periodStart, periodEnd, "مزامنة المنشورات التعاونية غير مكتملة."));
  }

  if (reachStatus === "PERIOD_UNAVAILABLE") {
    if (reachDaily.days > 0) {
      warnings.push("بيانات الوصول الفريدة لهذه الفترة غير مكتملة.");
      missingRanges.push(buildMissingRange(periodStart, periodEnd, "لا يوجد Reach فريد للفترة بالكامل في Meta API؛ متاح فقط Reach يومي أو 28 يوم."));
    } else {
      warnings.push("لا تتوفر بيانات وصول للحساب في هذه الفترة.");
      missingRanges.push(buildMissingRange(periodStart, periodEnd, "لا توجد بيانات وصول متزامنة."));
    }
  } else if (reachStatus === "PERIOD_ESTIMATED") {
    warnings.push(reach.tooltip ?? "Reach قيمة تقديرية؛ Meta API لا يوفر نافذة وصول فريدة مباشرة لمدة 31 يوماً.");
  } else if (reachStatus === "DAILY_PARTIAL") {
    warnings.push("بيانات الوصول اليومية ناقصة لبعض أيام الفترة.");
  } else if (reachStatus === "DAYS_28_AVAILABLE" && !periodReachValue) {
    warnings.push("بيانات الوصول الفريدة للفترة بالكامل غير متاحة؛ متاح Reach لآخر 28 يوم فقط.");
  }

  if (followerStatus === "UNAVAILABLE") {
    warnings.push("لا تتوفر بيانات حركة المتابعين (follows_and_unfollows) للفترة المطلوبة.");
    missingRanges.push(buildMissingRange(periodStart, periodEnd, "لا توجد بيانات follows_and_unfollows للفترة."));
  } else if (followerStatus === "PERIOD_DERIVED") {
    warnings.push(followers.tooltip ?? "حركة المتابعين قيمة مركّبة لأن Meta API لا يسمح بنطاق 31 يوم مباشر.");
  }

  if (!insightsComplete) {
    warnings.push(`بعض المنشورات تفتقر إلى مؤشرات: ${missingMetrics.map((metric) => ({ reach: "الوصول", views: "المشاهدات", total_interactions: "التفاعل", likes: "الإعجابات", comments: "التعليقات", saved: "الحفظ", shares: "المشاركات", follows: "المتابعون الجدد" })[metric as TrackedMetric] ?? metric).join("، ")}.`);
  }

  // Final status
  let status: CoverageStatus;
  const allComplete = mediaComplete && reachStatus === "PERIOD_AVAILABLE" && followerStatus === "PERIOD_AVAILABLE" && insightsComplete;

  const anyBackfillFailed =
    connection.historicalBackfillStatus === BackfillStatus.FAILED ||
    connection.collaborativeBackfillStatus === BackfillStatus.FAILED;

  if (anyBackfillFailed) {
    status = allComplete ? "PARTIAL" : "FAILED";
    if (status === "FAILED") warnings.unshift(connection.historicalBackfillLastError ?? connection.collaborativeBackfillLastError ?? "فشل التحميل التاريخي للبيانات.");
    else warnings.unshift("فشل التحميل التاريخي لكن بعض البيانات المتزامنة متاحة.");
  } else if (activeBackfill && !mediaComplete) {
    status = "SYNCING";
    warnings.unshift("جارٍ تحميل البيانات التاريخية. أعدي فتح التقرير أو تحديث البيانات لاحقاً.");
  } else if (activeInsights && reachStatus !== "PERIOD_AVAILABLE" && followerStatus === "UNAVAILABLE") {
    status = "SYNCING";
    warnings.unshift("جارٍ تحميل بيانات الوصول/المتابعين اليومية.");
  } else if (allComplete) {
    status = "COMPLETE";
  } else if (hasAnyPost || reachDaily.days > 0 || followerCount.days > 0 || postsInPeriod._count > 0) {
    status = "PARTIAL";
  } else {
    status = "UNAVAILABLE";
  }

  return {
    status,
    mediaCoverage: { from: mediaFrom, to: mediaTo, complete: mediaComplete },
    postInsightCoverage: { availableMetrics, missingMetrics },
    reachCoverage: { from: reachDaily.from, to: reachDaily.to, complete: reachDaily.complete },
    reach28DayCoverage: { from: reach28Day.from, to: reach28Day.to, complete: reach28Day.complete },
    followerCountCoverage: { from: followerCount.from, to: followerCount.to, complete: followerCount.complete },
    followsCoverage: { from: followerCount.from, to: followerCount.to, complete: followerCount.complete },
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
