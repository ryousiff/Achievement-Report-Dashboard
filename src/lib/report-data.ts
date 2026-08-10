import { BlockType, InsightPeriodType, MediaSource } from "@prisma/client";
import { db } from "@/lib/db";
import { decryptToken } from "@/lib/token-encryption";
import { graph } from "@/lib/meta-sync";

export type ReportMetric = "reach" | "views" | "total_interactions" | "likes" | "comments" | "saved" | "shares" | "follows" | "posts";

export type ReachAccuracy = "EXACT" | "ESTIMATED" | null;
export type ReachMethod = "META_TOTAL_VALUE" | "OVERLAPPING_WINDOWS_ESTIMATE" | "SNAPSHOT" | "UNAVAILABLE" | null;

export type ReachResult = {
  value: number | null;
  accuracy: ReachAccuracy;
  method: ReachMethod;
  tooltip?: string;
};

type PostMetrics = Record<string, number>;
type ReportPost = { id: string; externalPostId: string; caption: string | null; mediaType: string; mediaUrl: string | null; thumbnailUrl: string | null; permalink: string | null; publishedAt: string; metrics: PostMetrics; metricAvailability: Record<string, string>; metricAvailabilityState: Record<string, string> | null; mediaSource: MediaSource; isCollaborative: boolean; score: number };
type ReportBlock = { type: BlockType; title: string; content: Record<string, unknown> };

export function completeDailySeries(periodStart: Date, periodEnd: Date, entries: Array<[string, number]>) {
  const valuesByDay = new Map(entries);
  const series: Array<[string, number]> = [];
  const date = new Date(Date.UTC(periodStart.getUTCFullYear(), periodStart.getUTCMonth(), periodStart.getUTCDate()));
  const end = new Date(Date.UTC(periodEnd.getUTCFullYear(), periodEnd.getUTCMonth(), periodEnd.getUTCDate()));
  while (date <= end) { const day = date.toISOString().slice(0, 10); series.push([day, valuesByDay.get(day) ?? 0]); date.setUTCDate(date.getUTCDate() + 1); }
  return series;
}

const metricLabel: Record<ReportMetric, string> = { reach: "شخص تم الوصول له", views: "مشاهدة", total_interactions: "التفاعل مع المحتوى", likes: "إعجاب", comments: "تعليق", saved: "حفظ", shares: "مشاركة", follows: "المتابعون الجدد", posts: "منشور" };

function value(metrics: PostMetrics, metric: ReportMetric) {
  return metric === "posts" ? 0 : metrics[metric] ?? 0;
}

function score(post: ReportPost) {
  return (post.metrics.total_interactions ?? 0) + (post.metrics.shares ?? 0) + (post.metrics.saved ?? 0) + (post.metrics.follows ?? 0);
}

function total(posts: ReportPost[], metric: ReportMetric) {
  return metric === "posts" ? posts.length : posts.reduce((sum, post) => sum + value(post.metrics, metric), 0);
}

function kpi(id: string, label: string, value: string, available = true, extra?: Record<string, unknown>) {
  return { id, label, value, available, display: "cards", ...extra };
}

function mediaBlock(title: string, body: string, posts: ReportPost[], display: string[]) {
  return { type: BlockType.MEDIA, title, content: { body, mediaItems: posts, mediaDisplay: display, autoFilled: true } };
}

export async function reportPosts(clientId: string, periodStart: Date, periodEnd: Date) {
  const posts = await db.socialPost.findMany({ where: { connection: { clientId }, publishedAt: { gte: periodStart, lte: periodEnd } }, orderBy: { publishedAt: "desc" } });
  return posts.map((post): ReportPost => {
    const metrics = post.metrics as PostMetrics;
    const item = {
      id: post.id,
      externalPostId: post.externalPostId,
      caption: post.caption,
      mediaType: post.mediaType,
      mediaUrl: post.mediaUrl,
      thumbnailUrl: post.thumbnailUrl,
      permalink: post.permalink,
      publishedAt: post.publishedAt.toISOString(),
      metrics,
      metricAvailability: (post.metricAvailability as Record<string, string> | null) ?? {},
      metricAvailabilityState: (post.metricAvailabilityState as Record<string, string> | null) ?? null,
      mediaSource: post.mediaSource,
      isCollaborative: post.mediaSource === MediaSource.COLLABORATIVE,
      score: 0,
    };
    return { ...item, score: score(item) };
  });
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

function periodTypeForDuration(days: number): InsightPeriodType | null {
  if (days === 1) return InsightPeriodType.DAY;
  if (days === 7) return InsightPeriodType.WEEK;
  if (days === 28) return InsightPeriodType.DAYS_28;
  return null;
}

const reachCache = new Map<string, { result: ReachResult; expiresAt: number }>();
const REACH_CACHE_TTL_MS = 5 * 60 * 1000;

/** Clear the in-memory reach resolver cache. Useful in tests. */
export function clearReachCache() {
  reachCache.clear();
}

function reachCacheKey(clientId: string, periodStart: Date, periodEnd: Date) {
  return `${clientId}:${startOfDayUTC(periodStart).toISOString()}:${startOfDayUTC(periodEnd).toISOString()}`;
}

function getCachedReach(clientId: string, periodStart: Date, periodEnd: Date): ReachResult | undefined {
  const key = reachCacheKey(clientId, periodStart, periodEnd);
  const entry = reachCache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt < Date.now()) {
    reachCache.delete(key);
    return undefined;
  }
  return entry.result;
}

function setCachedReach(clientId: string, periodStart: Date, periodEnd: Date, result: ReachResult) {
  const key = reachCacheKey(clientId, periodStart, periodEnd);
  reachCache.set(key, { result, expiresAt: Date.now() + REACH_CACHE_TTL_MS });
}

function addDaysUTC(date: Date, days: number): Date {
  const d = startOfDayUTC(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

const ESTIMATED_TOOLTIP = "قيمة تقديرية محسوبة من نوافذ الوصول الفريد المتداخلة في Meta API، لأن Meta API لا يوفر نافذة وصول فريدة مباشرة لمدة 31 يوماُ.";
const SUM_DAILY_TOOLTIP = "مجموع الوصول اليومي؛ قد يحتوي على أشخاص وصل إليهم أكثر من منشور واحد، لذا لا يُستخدم كوصول فريد.";

async function fetchConnection(clientId: string) {
  return db.socialConnection.findFirst({
    where: { clientId, platform: "INSTAGRAM" },
    select: { externalAccountId: true, encryptedToken: true },
  });
}

async function fetchTotalValueReach(clientId: string, periodStart: Date, periodEnd: Date): Promise<ReachResult> {
  const connection = await fetchConnection(clientId);
  if (!connection || !connection.externalAccountId || !connection.encryptedToken) {
    return { value: null, accuracy: null, method: "UNAVAILABLE" };
  }
  const since = startOfDayUTC(periodStart);
  const until = addDaysUTC(periodEnd, 1); // `until` is exclusive
  const windowDays = (until.valueOf() - since.valueOf()) / (24 * 60 * 60 * 1000);
  if (windowDays > 30) return { value: null, accuracy: null, method: "UNAVAILABLE" };
  try {
    const token = decryptToken(connection.encryptedToken);
    const res = await graph<{ data?: Array<{ total_value?: { value?: number } }> }>(
      `${connection.externalAccountId}/insights`,
      token,
      {
        metric: "reach",
        period: "day",
        metric_type: "total_value",
        since: String(Math.floor(since.valueOf() / 1000)),
        until: String(Math.floor(until.valueOf() / 1000)),
      },
    );
    const value = res.data?.[0]?.total_value?.value;
    if (typeof value !== "number") return { value: null, accuracy: null, method: "UNAVAILABLE" };
    return { value, accuracy: "EXACT", method: "META_TOTAL_VALUE" };
  } catch (error) {
    return { value: null, accuracy: null, method: "UNAVAILABLE" };
  }
}

/** Return the account-level unique Reach for a report period.
 * - 1–30 days: exact Meta `total_value` (deduplicated by Meta).
 * - 31 days: estimated using overlapping 30/29-day `total_value` windows (A + B - C).
 * - Never sums daily reach or post reach.
 */
export async function periodAccountReach(clientId: string, periodStart: Date, periodEnd: Date): Promise<ReachResult> {
  const cached = getCachedReach(clientId, periodStart, periodEnd);
  if (cached) return cached;

  const days = daysBetweenInclusive(periodStart, periodEnd);

  if (days <= 30) {
    const total = await fetchTotalValueReach(clientId, periodStart, periodEnd);
    if (total.value !== null) {
      setCachedReach(clientId, periodStart, periodEnd, total);
      return total;
    }
    // Fallback to a matching stored snapshot (1/7/28 day) only if total_value is not available.
    const periodType = periodTypeForDuration(days);
    if (periodType) {
      const snapshots = await db.socialInsightSnapshot.findMany({
        take: 1,
        where: {
          connection: { clientId },
          metric: "reach",
          periodType,
          periodEnd: { gte: startOfDayUTC(periodEnd), lte: endOfDayUTC(periodEnd) },
          periodStart: { gte: startOfDayUTC(periodStart), lte: endOfDayUTC(periodStart) },
        },
        orderBy: { periodEnd: "desc" },
        select: { value: true },
      });
      const value = snapshots[0]?.value ?? null;
      const result: ReachResult = value !== null
        ? { value, accuracy: "EXACT", method: "SNAPSHOT" }
        : { value: null, accuracy: null, method: "UNAVAILABLE" };
      setCachedReach(clientId, periodStart, periodEnd, result);
      return result;
    }
    const unavailable: ReachResult = { value: null, accuracy: null, method: "UNAVAILABLE" };
    setCachedReach(clientId, periodStart, periodEnd, unavailable);
    return unavailable;
  }

  if (days === 31) {
    // Overlapping 30/29-day windows inclusion-exclusion estimate.
    // A = D1..D30, B = D2..D31, C = D2..D30 (intersection proxy).
    const [A, B, C] = await Promise.all([
      fetchTotalValueReach(clientId, periodStart, addDaysUTC(periodStart, 29)),
      fetchTotalValueReach(clientId, addDaysUTC(periodStart, 1), periodEnd),
      fetchTotalValueReach(clientId, addDaysUTC(periodStart, 1), addDaysUTC(periodStart, 29)),
    ]);

    if (A.value !== null && B.value !== null && C.value !== null) {
      const estimate = A.value + B.value - C.value;
      const result: ReachResult = { value: estimate, accuracy: "ESTIMATED", method: "OVERLAPPING_WINDOWS_ESTIMATE", tooltip: ESTIMATED_TOOLTIP };
      setCachedReach(clientId, periodStart, periodEnd, result);
      return result;
    }

    // Fallback to the best available 30-day total_value window (A or B), never SUM(daily reach).
    if (A.value !== null) {
      const result: ReachResult = { value: A.value, accuracy: "ESTIMATED", method: "META_TOTAL_VALUE", tooltip: ESTIMATED_TOOLTIP };
      setCachedReach(clientId, periodStart, periodEnd, result);
      return result;
    }
    if (B.value !== null) {
      const result: ReachResult = { value: B.value, accuracy: "ESTIMATED", method: "META_TOTAL_VALUE", tooltip: ESTIMATED_TOOLTIP };
      setCachedReach(clientId, periodStart, periodEnd, result);
      return result;
    }

    const unavailable: ReachResult = { value: null, accuracy: null, method: "UNAVAILABLE" };
    setCachedReach(clientId, periodStart, periodEnd, unavailable);
    return unavailable;
  }

  const unavailable: ReachResult = { value: null, accuracy: null, method: "UNAVAILABLE" };
  setCachedReach(clientId, periodStart, periodEnd, unavailable);
  return unavailable;
}

/** Sum daily net-new-follower snapshots for the period. `follower_count` is additive (daily net change),
 * unlike reach, so summing the days gives the total account-level follower growth for the period.
 * Returns null if any day in the period is missing, so we never present a partial sum as a period total. */
export async function periodAccountFollowerCount(clientId: string, periodStart: Date, periodEnd: Date): Promise<number | null> {
  const snapshots = await db.socialInsightSnapshot.findMany({
    where: {
      connection: { clientId },
      metric: "follower_count",
      periodType: InsightPeriodType.DAY,
      periodEnd: { gte: startOfDayUTC(periodStart), lte: endOfDayUTC(periodEnd) },
    },
    select: { periodEnd: true, value: true },
  });
  const expectedDays = daysBetweenInclusive(periodStart, periodEnd);
  const days = new Set(snapshots.map((s) => s.periodEnd.toISOString().slice(0, 10)));
  if (days.size < expectedDays) return null; // incomplete coverage — do not silently under-count
  return snapshots.reduce((sum, s) => sum + s.value, 0);
}

/** Find the most recent reach snapshot of a specific period type ending on or immediately before `date`.
 * Used to expose "الوصول خلال آخر 28 يوماُ" as a separate, honestly-labeled metric when period Reach is unavailable. */
export async function latestAccountReachWindow(
  clientId: string,
  date: Date,
  periodType: InsightPeriodType,
): Promise<{ value: number; periodStart: Date; periodEnd: Date } | null> {
  const snapshots = await db.socialInsightSnapshot.findMany({
    take: 1,
    where: {
      connection: { clientId },
      metric: "reach",
      periodType,
      periodEnd: { gte: startOfDayUTC(date), lte: endOfDayUTC(date) },
    },
    orderBy: { periodEnd: "desc" },
    select: { value: true, periodStart: true, periodEnd: true },
  });
  const snapshot = snapshots[0];
  if (!snapshot) return null;
  return { value: snapshot.value, periodStart: snapshot.periodStart, periodEnd: snapshot.periodEnd };
}

/** @deprecated Kept for compatibility; use `periodAccountReach` or `periodAccountFollowerCount`.
 *  The old implementation summed snapshots, which is wrong for reach (double-counts unique users). */
export async function periodAccountMetricTotal(clientId: string, metric: "reach" | "follows", periodStart: Date, periodEnd: Date) {
  const snapshots = await db.socialInsightSnapshot.findMany({ where: { connection: { clientId }, metric, periodEnd: { gte: periodStart, lte: periodEnd } }, select: { value: true } });
  if (snapshots.length === 0) return null;
  return snapshots.reduce((sum, snapshot) => sum + snapshot.value, 0);
}

export async function buildStandardReportBlocks(clientId: string, periodStart: Date, periodEnd: Date): Promise<ReportBlock[]> {
  const posts = await reportPosts(clientId, periodStart, periodEnd);
  const totals = Object.fromEntries((["reach", "views", "total_interactions", "likes", "comments", "saved", "shares", "follows", "posts"] as ReportMetric[]).map((metric) => [metric, total(posts, metric)])) as Record<ReportMetric, number>;
  const hasMetric = (metric: ReportMetric) => metric === "posts" || posts.some((post) => post.metricAvailability[metric] === "returned" || (Object.keys(post.metricAvailability).length === 0 && typeof post.metrics[metric] === "number"));
  // Account-level reach is Meta's unique-accounts-reached metric for the account; summing per-post reach would double-count
  // people reached by more than one post, so prefer the account-level daily snapshots (matches Meta's own dashboards and
  // third-party tools like Iconosquare) and only fall back to the per-post sum when no snapshots have been synced yet.
  // Account-level reach and follows are sourced from Meta's daily account insights, not by summing post-level
  // metrics (which would double-count people reached by multiple posts and mis-attribute follower growth).
  const reach = await periodAccountReach(clientId, periodStart, periodEnd);
  const accountFollows = await periodAccountFollowerCount(clientId, periodStart, periodEnd);
  const hasReach = reach.value !== null;
  const hasFollows = accountFollows !== null;
  totals.reach = reach.value ?? 0;
  totals.follows = accountFollows ?? 0;
  const engagementRate = hasReach && totals.reach > 0 && hasMetric("total_interactions") ? `${((totals.total_interactions / totals.reach) * 100).toFixed(2)}%` : "غير متاح";
  const topBy = (metric: ReportMetric) => [...posts].sort((left, right) => value(right.metrics, metric) - value(left.metrics, metric)).filter((post) => value(post.metrics, metric) > 0).slice(0, 4);
  const topInteractions = topBy("total_interactions");
  const topViews = topBy("views");
  const topFollows = topBy("follows");
  const formats = ["REELS", "IMAGE", "VIDEO", "CAROUSEL_ALBUM"].map((mediaType) => ({ id: `format-${mediaType}`, label: mediaType === "REELS" ? "الريلز" : mediaType === "IMAGE" ? "المنشورات" : mediaType === "VIDEO" ? "الفيديوهات" : "الألبومات", value: String(posts.filter((post) => post.mediaType === mediaType).reduce((sum, post) => sum + (post.metrics.total_interactions ?? 0), 0)), display: "cards" })).filter((item) => Number(item.value) > 0);

  const followerSnapshots = await db.socialInsightSnapshot.findMany({
    where: { connection: { clientId }, metric: "follower_count", periodType: InsightPeriodType.DAY, periodEnd: { gte: startOfDayUTC(periodStart), lte: endOfDayUTC(periodEnd) } },
    orderBy: { periodEnd: "asc" },
  });
  const dailyFollowEntries = [...followerSnapshots.reduce((days, snapshot) => { const day = snapshot.periodEnd.toISOString().slice(0, 10); days.set(day, (days.get(day) ?? 0) + snapshot.value); return days; }, new Map<string, number>()).entries()];
  const expectedFollowerDays = daysBetweenInclusive(periodStart, periodEnd);
  const followerDataComplete = dailyFollowEntries.length >= expectedFollowerDays;
  const followerSource = followerDataComplete
    ? "بيانات صافي اكتساب المتابعين (follower_count) اليومية من Meta."
    : `بيانات صافي اكتساب المتابعين (follower_count) اليومية من Meta — متاحة لـ ${dailyFollowEntries.length} من أصل ${expectedFollowerDays} يوم. إجمالي الأيام المتاحة: ${dailyFollowEntries.reduce((sum, [, value]) => sum + value, 0).toLocaleString()}.`;
  const completeFollowerEntries = completeDailySeries(periodStart, periodEnd, dailyFollowEntries);
  const followerValues = completeFollowerEntries.map(([, value]) => value);
  const followerLabels = completeFollowerEntries.map(([day]) => day);

  const reachExtra = { reachAccuracy: reach.accuracy, reachMethod: reach.method, tooltip: reach.tooltip };
  const reachKpis = [
    kpi("reach", metricLabel.reach, hasReach ? totals.reach.toLocaleString() : "غير متاح", hasReach, reach.accuracy === "ESTIMATED" ? { ...reachExtra, badge: "تقديري" } : reachExtra),
  ];

  // Optional: expose SUM(daily reach) as a clearly labelled, separate metric. Never use it as unique reach.
  const reachDailySnapshots = await db.socialInsightSnapshot.findMany({
    where: {
      connection: { clientId },
      metric: "reach",
      periodType: InsightPeriodType.DAY,
      periodEnd: { gte: startOfDayUTC(periodStart), lte: endOfDayUTC(periodEnd) },
    },
    select: { value: true },
  });
  if (reachDailySnapshots.length > 0) {
    reachKpis.push(kpi("daily-reach-sum", "مجموع الوصول اليومي", reachDailySnapshots.reduce((sum, s) => sum + s.value, 0).toLocaleString(), true, { tooltip: SUM_DAILY_TOOLTIP }));
  }

  return [
    { type: BlockType.TEXT, title: "غلاف التقرير", content: { body: "تقرير الإنجاز الشهري", page: "cover" } },
    { type: BlockType.KPI, title: "أهم الإحصائيات", content: { body: "إحصائيات الفترة المحددة من بيانات Meta المتاحة.", kpis: [...reachKpis, kpi("views", metricLabel.views, hasMetric("views") ? totals.views.toLocaleString() : "غير متاح", hasMetric("views")), kpi("engagement-rate", "متوسط التفاعل على أساس الوصول", engagementRate, hasReach), kpi("follows", "المتابعون الجدد", hasFollows ? totals.follows.toLocaleString() : "غير متاح", hasFollows), kpi("posts", metricLabel.posts, totals.posts.toLocaleString())], comparison: "none", autoFilled: true } },
    { type: BlockType.KPI, title: "التفاعل مع المحتوى", content: { body: "إجماليات التفاعل للمنشورات خلال الفترة.", kpis: [kpi("total_interactions", metricLabel.total_interactions, hasMetric("total_interactions") ? totals.total_interactions.toLocaleString() : "غير متاح", hasMetric("total_interactions")), kpi("likes", metricLabel.likes, hasMetric("likes") ? totals.likes.toLocaleString() : "غير متاح", hasMetric("likes")), kpi("comments", metricLabel.comments, hasMetric("comments") ? totals.comments.toLocaleString() : "غير متاح", hasMetric("comments")), kpi("saved", "حفظ", hasMetric("saved") ? totals.saved.toLocaleString() : "غير متاح", hasMetric("saved")), kpi("shares", "مشاركة", hasMetric("shares") ? totals.shares.toLocaleString() : "غير متاح", hasMetric("shares"))], comparison: "none", autoFilled: true } },
    { type: BlockType.CHART, title: "معدل اكتساب المتابعين اليومي", content: followerDataComplete ? { body: followerSource, chart: { type: "line", metric: "المتابعون الجدد يومياً", values: followerValues.join(", "), labels: followerLabels.join(", "), insight: `إجمالي المتابعين الجدد خلال الأيام المتاحة: ${followerValues.reduce((sum, value) => sum + value, 0).toLocaleString()}.` } } : { body: followerSource, chartUnavailable: true, unavailableReason: "Meta توفر بيانات follower_count لآخر 30 يوم فقط؛ الفترة المطلوبة غير مكتملة." } },
    mediaBlock("أعلى المنشورات من حيث اكتساب المتابعين", "تم اختيار المنشورات الأعلى من بيانات الفترة.", topFollows, ["follows"]),
    { type: BlockType.KPI, title: "التفاعل حسب نوع المحتوى", content: { body: "إجمالي التفاعل حسب نوع المنشور.", kpis: formats, comparison: "none", autoFilled: true } },
    mediaBlock("أعلى المنشورات من حيث التفاعل", "تم اختيار المنشورات الأعلى تفاعلاً من بيانات الفترة.", topInteractions, ["total_interactions", "views"]),
    mediaBlock("أعلى المنشورات من حيث المشاهدات", "تم اختيار المنشورات الأعلى مشاهدة من بيانات الفترة.", topViews, ["views", "total_interactions"]),
    mediaBlock("محتوى الشهر", "أضيفي نماذج إضافية من المحتوى أو احتفظي بالمنشورات المختارة تلقائياً.", [...posts].sort((left, right) => right.score - left.score).slice(0, 4), ["total_interactions", "views"]),
    { type: BlockType.NOTES, title: "التوصيات", content: { body: "أضيفي توصيات عملية قابلة للتنفيذ للشهر القادم." } },
    { type: BlockType.TEXT, title: "شكراً على ثقتكم", content: { body: "Kaan Creative", page: "closing" } },
  ];
}
