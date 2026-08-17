import { BlockType, InsightPeriodType, MediaSource } from "@prisma/client";
import { db } from "@/lib/db";
import { decryptToken } from "@/lib/token-encryption";
import { graph } from "@/lib/meta-sync";
import { splitRangeByMonth } from "@/lib/report-period";
import { mediaThumbnailUrl } from "@/lib/media-storage";

export type ReportMetric = "reach" | "views" | "total_interactions" | "likes" | "comments" | "saved" | "shares" | "follows" | "posts";

/** Stable, non-editable markers (`content.refreshKey`) identifying which blocks in
 * `buildStandardReportBlocks()`'s output are data-driven (safe to recompute/replace on
 * refresh) vs. manual (cover/closing text, recommendations — never touched by refresh).
 * Used by `refreshReportData()` (src/lib/report-refresh.ts) to merge freshly computed
 * data into a report's already-saved blocks without discarding manual edits.
 *
 * "kpi-content-type" is kept here even though `buildStandardReportBlocks` no longer emits
 * it, so `refreshReportData` still recognizes it as data-driven (rather than manual) and
 * drops any block still carrying it from older, already-saved reports on their next refresh. */
export const REPORT_DATA_DRIVEN_REFRESH_KEYS = [
  "kpi-overview",
  "kpi-interactions",
  "chart-followers",
  "media-top-follows",
  "kpi-content-type",
  "media-top-interactions",
  "media-top-views",
  "media-month-content",
] as const;
export type ReportRefreshKey =
  | (typeof REPORT_DATA_DRIVEN_REFRESH_KEYS)[number]
  | "cover"
  | "notes-recommendations"
  | "closing";

export type ReachAccuracy = "EXACT" | "ESTIMATED" | null;
export type ReachMethod = "META_TOTAL_VALUE" | "OVERLAPPING_WINDOWS_ESTIMATE" | "SNAPSHOT" | "UNAVAILABLE" | null;

export type ReachResult = {
  value: number | null;
  accuracy: ReachAccuracy;
  method: ReachMethod;
  tooltip?: string;
};

type PostMetrics = Record<string, number>;
type ReportPost = { id: string; externalPostId: string; caption: string | null; mediaType: string; mediaUrl: string | null; thumbnailUrl: string | null; thumbnailStorageUrl: string | null; permalink: string | null; publishedAt: string; metrics: PostMetrics; metricAvailability: Record<string, string>; metricAvailabilityState: Record<string, string> | null; mediaSource: MediaSource; isCollaborative: boolean; score: number };
export type ReportBlock = { type: BlockType; title: string; content: Record<string, unknown> };

export function completeDailySeries(periodStart: Date, periodEnd: Date, entries: Array<[string, number]>) {
  const valuesByDay = new Map(entries);
  const series: Array<[string, number]> = [];
  const date = new Date(Date.UTC(periodStart.getUTCFullYear(), periodStart.getUTCMonth(), periodStart.getUTCDate()));
  const end = new Date(Date.UTC(periodEnd.getUTCFullYear(), periodEnd.getUTCMonth(), periodEnd.getUTCDate()));
  while (date <= end) { const day = date.toISOString().slice(0, 10); series.push([day, valuesByDay.get(day) ?? 0]); date.setUTCDate(date.getUTCDate() + 1); }
  return series;
}

const metricLabel: Record<ReportMetric, string> = { reach: "شخص تم الوصول له", views: "مشاهدات المنشورات العضوية", total_interactions: "التفاعل مع المحتوى", likes: "إعجاب", comments: "تعليق", saved: "حفظ", shares: "مشاركة", follows: "المتابعون الجدد", posts: "منشور" };

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

function mediaBlock(title: string, body: string, posts: ReportPost[], display: string[], refreshKey: ReportRefreshKey) {
  return { type: BlockType.MEDIA, title, content: { body, mediaItems: posts, mediaDisplay: display, autoFilled: true, refreshKey } };
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
      thumbnailStorageUrl: mediaThumbnailUrl(post.thumbnailStorageKey),
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
    select: { id: true, externalAccountId: true, encryptedToken: true },
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

// ===== Account-level Total Views =====

export type ViewsAccuracy = "EXACT" | "DERIVED" | null;
export type ViewsMethod = "META_TOTAL_VALUE" | "OVERLAPPING_WINDOWS_COMPOSITION" | "AGGREGATE_OF_PERIOD_CHUNKS" | "SNAPSHOT" | "UNAVAILABLE" | null;

export type ViewsResult = {
  value: number | null;
  accuracy: ViewsAccuracy;
  method: ViewsMethod;
  tooltip?: string;
};

const VIEWS_DERIVED_TOOLTIP = "قيمة مركّبة من نوافز views المتداخلة لأن Meta API لا يتيح نطاقاً زمنياً مباشراً لمدة 31 يوماُ.";

const viewsCache = new Map<string, { result: ViewsResult; expiresAt: number }>();
const VIEWS_CACHE_TTL_MS = 5 * 60 * 1000;

/** Clear the in-memory views resolver cache. Useful in tests. */
export function clearViewsCache() {
  viewsCache.clear();
}

function viewsCacheKey(clientId: string, periodStart: Date, periodEnd: Date) {
  return `${clientId}:views:${startOfDayUTC(periodStart).toISOString()}:${startOfDayUTC(periodEnd).toISOString()}`;
}

function getCachedViews(clientId: string, periodStart: Date, periodEnd: Date): ViewsResult | undefined {
  const key = viewsCacheKey(clientId, periodStart, periodEnd);
  const entry = viewsCache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt < Date.now()) {
    viewsCache.delete(key);
    return undefined;
  }
  return entry.result;
}

function setCachedViews(clientId: string, periodStart: Date, periodEnd: Date, result: ViewsResult) {
  const key = viewsCacheKey(clientId, periodStart, periodEnd);
  viewsCache.set(key, { result, expiresAt: Date.now() + VIEWS_CACHE_TTL_MS });
}

async function fetchTotalValueViews(clientId: string, periodStart: Date, periodEnd: Date): Promise<ViewsResult> {
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
        metric: "views",
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

/** Return the account-level Total Views for a report period.
 * - 1–30 days: exact Meta `total_value`.
 * - 31 days: derived using overlapping 30/29-day `total_value` windows (A + B - C).
 * - Never sums media-level views.
 */
export async function periodAccountViews(clientId: string, periodStart: Date, periodEnd: Date): Promise<ViewsResult> {
  const cached = getCachedViews(clientId, periodStart, periodEnd);
  if (cached) return cached;

  const days = daysBetweenInclusive(periodStart, periodEnd);

  if (days <= 30) {
    const result = await fetchTotalValueViews(clientId, periodStart, periodEnd);
    setCachedViews(clientId, periodStart, periodEnd, result);
    return result;
  }

  if (days === 31) {
    const [A, B, C] = await Promise.all([
      fetchTotalValueViews(clientId, periodStart, addDaysUTC(periodStart, 29)),
      fetchTotalValueViews(clientId, addDaysUTC(periodStart, 1), periodEnd),
      fetchTotalValueViews(clientId, addDaysUTC(periodStart, 1), addDaysUTC(periodStart, 29)),
    ]);

    if (A.value !== null && B.value !== null && C.value !== null) {
      const value = A.value + B.value - C.value;
      const result: ViewsResult = { value, accuracy: "DERIVED", method: "OVERLAPPING_WINDOWS_COMPOSITION", tooltip: VIEWS_DERIVED_TOOLTIP };
      setCachedViews(clientId, periodStart, periodEnd, result);
      return result;
    }

    if (A.value !== null) {
      const result: ViewsResult = { value: A.value, accuracy: "DERIVED", method: "META_TOTAL_VALUE", tooltip: VIEWS_DERIVED_TOOLTIP };
      setCachedViews(clientId, periodStart, periodEnd, result);
      return result;
    }
    if (B.value !== null) {
      const result: ViewsResult = { value: B.value, accuracy: "DERIVED", method: "META_TOTAL_VALUE", tooltip: VIEWS_DERIVED_TOOLTIP };
      setCachedViews(clientId, periodStart, periodEnd, result);
      return result;
    }
  }

  const unavailable: ViewsResult = { value: null, accuracy: null, method: "UNAVAILABLE" };
  setCachedViews(clientId, periodStart, periodEnd, unavailable);
  return unavailable;
}

// ===== Follower movement (gained / lost / net) =====

export type FollowersAccuracy = "EXACT" | "DERIVED" | null;
export type FollowersMethod = "META_TOTAL_VALUE" | "OVERLAPPING_WINDOWS_COMPOSITION" | "AGGREGATE_OF_PERIOD_CHUNKS" | "SNAPSHOT" | "UNAVAILABLE" | null;

export type FollowersResult = {
  gained: number | null;
  lost: number | null;
  net: number | null;
  accuracy: FollowersAccuracy;
  method: FollowersMethod;
  raw?: { dimension: string; value: number }[];
  tooltip?: string;
};

const DERIVED_TOOLTIP = "قيمة مركّبة من نوافز follows_and_unfollows المتداخلة لأن Meta API لا يتيح نطاقاً زمنياً مباشراً لمدة 31 يوماً.";

const followersCache = new Map<string, { result: FollowersResult; expiresAt: number }>();
const FOLLOWERS_CACHE_TTL_MS = 5 * 60 * 1000;

/** Clear the in-memory followers resolver cache. Useful in tests. */
export function clearFollowersCache() {
  followersCache.clear();
}

function followersCacheKey(clientId: string, periodStart: Date, periodEnd: Date) {
  return `${clientId}:followers:${startOfDayUTC(periodStart).toISOString()}:${startOfDayUTC(periodEnd).toISOString()}`;
}

function getCachedFollowers(clientId: string, periodStart: Date, periodEnd: Date): FollowersResult | undefined {
  const key = followersCacheKey(clientId, periodStart, periodEnd);
  const entry = followersCache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt < Date.now()) {
    followersCache.delete(key);
    return undefined;
  }
  return entry.result;
}

function setCachedFollowers(clientId: string, periodStart: Date, periodEnd: Date, result: FollowersResult) {
  const key = followersCacheKey(clientId, periodStart, periodEnd);
  followersCache.set(key, { result, expiresAt: Date.now() + FOLLOWERS_CACHE_TTL_MS });
}

function parseFollowerBreakdown(insight: unknown): { gained: number; lost: number; raw: { dimension: string; value: number }[] } | null {
  const breakdowns = (insight as any)?.total_value?.breakdowns as Array<{
    dimension_keys: string[];
    results: Array<{ dimension_values: string[]; value: number }>;
  }> | undefined;
  if (!breakdowns || breakdowns.length === 0) return null;
  const results = breakdowns[0].results;
  const raw = results.map((r) => ({ dimension: r.dimension_values[0] ?? "UNKNOWN", value: r.value }));
  const gained = results.find((r) => r.dimension_values[0] === "FOLLOWER")?.value ?? 0;
  const lost = results.find((r) => r.dimension_values[0] === "NON_FOLLOWER")?.value ?? 0;
  return { gained, lost, raw };
}

async function fetchFollowerMovementTotal(clientId: string, periodStart: Date, periodEnd: Date): Promise<FollowersResult> {
  const connection = await fetchConnection(clientId);
  if (!connection || !connection.externalAccountId || !connection.encryptedToken) {
    return { gained: null, lost: null, net: null, accuracy: null, method: "UNAVAILABLE" };
  }
  const since = startOfDayUTC(periodStart);
  const until = addDaysUTC(periodEnd, 1); // exclusive
  const windowDays = (until.valueOf() - since.valueOf()) / (24 * 60 * 60 * 1000);
  if (windowDays > 30) return { gained: null, lost: null, net: null, accuracy: null, method: "UNAVAILABLE" };
  try {
    const token = decryptToken(connection.encryptedToken);
    const res = await graph<{ data?: Array<unknown> }>(
      `${connection.externalAccountId}/insights`,
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
    const parsed = parseFollowerBreakdown(res.data?.[0]);
    if (!parsed) return { gained: null, lost: null, net: null, accuracy: null, method: "UNAVAILABLE" };
    return {
      gained: parsed.gained,
      lost: parsed.lost,
      net: parsed.gained - parsed.lost,
      accuracy: "EXACT",
      method: "META_TOTAL_VALUE",
      raw: parsed.raw,
    };
  } catch (error) {
    return { gained: null, lost: null, net: null, accuracy: null, method: "UNAVAILABLE" };
  }
}

/** Resolve account-level follower movement (gained / lost / net) for a report period.
 * - 1–30 days: exact Meta total_value for the range.
 * - 31 days: derived from overlapping 30/29-day windows (A + B - C) for gained and lost separately.
 * - Never uses account-insight `follower_count` or media-level `follows`.
 */
export async function periodAccountFollowers(clientId: string, periodStart: Date, periodEnd: Date): Promise<FollowersResult> {
  const cached = getCachedFollowers(clientId, periodStart, periodEnd);
  if (cached) return cached;

  const days = daysBetweenInclusive(periodStart, periodEnd);

  if (days <= 30) {
    const result = await fetchFollowerMovementTotal(clientId, periodStart, periodEnd);
    setCachedFollowers(clientId, periodStart, periodEnd, result);
    return result;
  }

  if (days === 31) {
    const [A, B, C] = await Promise.all([
      fetchFollowerMovementTotal(clientId, periodStart, addDaysUTC(periodStart, 29)),
      fetchFollowerMovementTotal(clientId, addDaysUTC(periodStart, 1), periodEnd),
      fetchFollowerMovementTotal(clientId, addDaysUTC(periodStart, 1), addDaysUTC(periodStart, 29)),
    ]);

    if (A.gained !== null && B.gained !== null && C.gained !== null && A.lost !== null && B.lost !== null && C.lost !== null) {
      const gained = A.gained + B.gained - C.gained;
      const lost = A.lost + B.lost - C.lost;
      const result: FollowersResult = {
        gained,
        lost,
        net: gained - lost,
        accuracy: "DERIVED",
        method: "OVERLAPPING_WINDOWS_COMPOSITION",
        raw: [
          { dimension: "gained_A", value: A.gained },
          { dimension: "gained_B", value: B.gained },
          { dimension: "gained_C", value: C.gained },
          { dimension: "lost_A", value: A.lost },
          { dimension: "lost_B", value: B.lost },
          { dimension: "lost_C", value: C.lost },
        ],
        tooltip: DERIVED_TOOLTIP,
      };
      setCachedFollowers(clientId, periodStart, periodEnd, result);
      return result;
    }

    if (A.gained !== null && A.lost !== null) {
      const result: FollowersResult = { ...A, accuracy: "DERIVED", method: "META_TOTAL_VALUE", tooltip: DERIVED_TOOLTIP };
      setCachedFollowers(clientId, periodStart, periodEnd, result);
      return result;
    }
    if (B.gained !== null && B.lost !== null) {
      const result: FollowersResult = { ...B, accuracy: "DERIVED", method: "META_TOTAL_VALUE", tooltip: DERIVED_TOOLTIP };
      setCachedFollowers(clientId, periodStart, periodEnd, result);
      return result;
    }
  }

  const unavailable: FollowersResult = { gained: null, lost: null, net: null, accuracy: null, method: "UNAVAILABLE" };
  setCachedFollowers(clientId, periodStart, periodEnd, unavailable);
  return unavailable;
}

/** Fetch the current total followers for an account from the IG User node (followers_count),
 * not from account insights. */
export type DailyFollowerMovement = {
  gainedSeries: Array<[string, number]>;
  lostSeries: Array<[string, number]>;
  netSeries: Array<[string, number]>;
  complete: boolean;
};

async function fetchAndStoreDailyFollowerMovement(
  connectionId: string,
  externalAccountId: string,
  token: string,
  day: Date,
): Promise<{ gained: number; lost: number } | null> {
  const since = startOfDayUTC(day);
  const until = addDaysUTC(day, 1);
  try {
    const res = await graph<{ data?: Array<unknown> }>(
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
    const parsed = parseFollowerBreakdown(res.data?.[0]);
    if (!parsed) return null;
    const periodEnd = new Date(since);
    periodEnd.setUTCDate(periodEnd.getUTCDate() + 1);
    periodEnd.setUTCHours(7);
    const periodStart = new Date(periodEnd);
    periodStart.setUTCDate(periodStart.getUTCDate() - 1);
    // Store gained
    await db.socialInsightSnapshot.upsert({
      where: {
        connectionId_metric_periodType_periodStart_periodEnd: {
          connectionId,
          metric: "followers_gained",
          periodType: InsightPeriodType.DAY,
          periodStart,
          periodEnd,
        },
      },
      create: { connectionId, metric: "followers_gained", periodType: InsightPeriodType.DAY, periodStart, periodEnd, value: parsed.gained },
      update: { value: parsed.gained },
    });
    // Store lost
    await db.socialInsightSnapshot.upsert({
      where: {
        connectionId_metric_periodType_periodStart_periodEnd: {
          connectionId,
          metric: "followers_lost",
          periodType: InsightPeriodType.DAY,
          periodStart,
          periodEnd,
        },
      },
      create: { connectionId, metric: "followers_lost", periodType: InsightPeriodType.DAY, periodStart, periodEnd, value: parsed.lost },
      update: { value: parsed.lost },
    });
    return { gained: parsed.gained, lost: parsed.lost };
  } catch (error) {
    return null;
  }
}

/** Build a daily gained/lost/net series for the period by fetching follows_and_unfollows one day at a time.
 * Values are stored in SocialInsightSnapshot for reuse. */
export async function dailyFollowerMovement(clientId: string, periodStart: Date, periodEnd: Date): Promise<DailyFollowerMovement> {
  const connection = await fetchConnection(clientId);
  if (!connection || !connection.externalAccountId || !connection.encryptedToken) {
    return { gainedSeries: [], lostSeries: [], netSeries: [], complete: false };
  }
  const token = decryptToken(connection.encryptedToken);
  const expected = daysBetweenInclusive(periodStart, periodEnd);
  const gainedByDay = new Map<string, number>();
  const lostByDay = new Map<string, number>();

  const current = startOfDayUTC(periodStart);
  const end = startOfDayUTC(periodEnd);
  while (current <= end) {
    const day = current.toISOString().slice(0, 10);
    // Check stored snapshots first
    const periodEnd = new Date(current);
    periodEnd.setUTCDate(periodEnd.getUTCDate() + 1);
    periodEnd.setUTCHours(7);
    const periodStartDay = new Date(periodEnd);
    periodStartDay.setUTCDate(periodStartDay.getUTCDate() - 1);
    const stored = await db.socialInsightSnapshot.findFirst({
      where: {
        connection: { clientId },
        metric: "followers_gained",
        periodType: InsightPeriodType.DAY,
        periodStart: periodStartDay,
        periodEnd,
      },
      select: { value: true },
    });
    const storedLost = await db.socialInsightSnapshot.findFirst({
      where: {
        connection: { clientId },
        metric: "followers_lost",
        periodType: InsightPeriodType.DAY,
        periodStart: periodStartDay,
        periodEnd,
      },
      select: { value: true },
    });
    if (stored && storedLost) {
      gainedByDay.set(day, stored.value);
      lostByDay.set(day, storedLost.value);
    } else {
      const fetched = await fetchAndStoreDailyFollowerMovement(connection.id, connection.externalAccountId, token, current);
      if (fetched) {
        gainedByDay.set(day, fetched.gained);
        lostByDay.set(day, fetched.lost);
      }
    }
    current.setUTCDate(current.getUTCDate() + 1);
  }

  const complete = gainedByDay.size >= expected;
  const gainedSeries = completeDailySeries(periodStart, periodEnd, [...gainedByDay.entries()]);
  const lostSeries = completeDailySeries(periodStart, periodEnd, [...lostByDay.entries()]);
  const netSeries: Array<[string, number]> = gainedSeries.map(([day, gained], i) => [day, gained - lostSeries[i][1]]);
  return { gainedSeries, lostSeries, netSeries, complete };
}

export async function currentFollowersCount(clientId: string): Promise<number | null> {
  const connection = await fetchConnection(clientId);
  if (!connection || !connection.externalAccountId || !connection.encryptedToken) return null;
  try {
    const token = decryptToken(connection.encryptedToken);
    const res = await graph<{ followers_count?: number }>(connection.externalAccountId, token, { fields: "followers_count" });
    return typeof res.followers_count === "number" ? res.followers_count : null;
  } catch (error) {
    return null;
  }
}

/** @deprecated Kept for compatibility; use `periodAccountReach` or `periodAccountFollowers`.
 *  The old implementation summed snapshots, which is wrong for reach (double-counts unique people). */
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

type ReportDataResolvers = {
  reach: (clientId: string, periodStart: Date, periodEnd: Date) => Promise<ReachResult>;
  followers: (clientId: string, periodStart: Date, periodEnd: Date) => Promise<FollowersResult>;
  views: (clientId: string, periodStart: Date, periodEnd: Date) => Promise<ViewsResult>;
  dailyFollowerMovement: (clientId: string, periodStart: Date, periodEnd: Date) => Promise<DailyFollowerMovement>;
};

const defaultReportDataResolvers: ReportDataResolvers = {
  reach: periodAccountReachForRange,
  followers: periodAccountFollowersForRange,
  views: periodAccountViewsForRange,
  dailyFollowerMovement,
};

const DB_ONLY_SUM_DAILY_REACH_TOOLTIP = "مجموع الوصول اليومي من بيانات متزامنة؛ قد يحتوي على أشخاص وصل إليهم أكثر من منشور واحد، لذا لا يُستخدم كوصول فريد.";
const DB_ONLY_POST_SUM_VIEWS_TOOLTIP = "مجموع إجمالي المشاهدات على مستوى المنشورات من البيانات المتزامنة؛ قد تختلف عن قيمة الحساب الإجمالية في Meta.";

/** Read account-level Reach from stored snapshots only (no Meta API calls).
 *  Prefers an exact period snapshot, then falls back to a full daily sum for short periods. */
export async function periodAccountReachFromDatabase(clientId: string, periodStart: Date, periodEnd: Date): Promise<ReachResult> {
  const days = daysBetweenInclusive(periodStart, periodEnd);
  if (days > 31) return { value: null, accuracy: null, method: "UNAVAILABLE", tooltip: LONG_RANGE_REACH_TOOLTIP };

  const exactSnapshots = await db.socialInsightSnapshot.findMany({
    where: {
      connection: { clientId },
      metric: "reach",
      periodStart: { gte: startOfDayUTC(periodStart), lte: endOfDayUTC(periodStart) },
      periodEnd: { gte: startOfDayUTC(periodEnd), lte: endOfDayUTC(periodEnd) },
    },
    select: { value: true, periodType: true },
    orderBy: { periodEnd: "desc" },
  });
  const exact = exactSnapshots[0];
  if (exact) return { value: exact.value, accuracy: "EXACT", method: "SNAPSHOT" };

  if (days <= 31) {
    const dailySnapshots = await db.socialInsightSnapshot.findMany({
      where: {
        connection: { clientId },
        metric: "reach",
        periodType: InsightPeriodType.DAY,
        periodEnd: { gte: startOfDayUTC(periodStart), lte: endOfDayUTC(periodEnd) },
      },
      select: { value: true },
    });
    const expectedDays = daysBetweenInclusive(periodStart, periodEnd);
    if (dailySnapshots.length >= expectedDays) {
      return { value: dailySnapshots.reduce((sum, s) => sum + s.value, 0), accuracy: "EXACT", method: "SNAPSHOT", tooltip: DB_ONLY_SUM_DAILY_REACH_TOOLTIP };
    }
  }

  return { value: null, accuracy: null, method: "UNAVAILABLE" };
}

/** Read account-level Total Views from stored post metrics only (no Meta API calls).
 *  Sums media-level total_views because account-level total_value is not persisted. */
export async function periodAccountViewsFromDatabase(clientId: string, periodStart: Date, periodEnd: Date): Promise<ViewsResult> {
  const posts = await reportPosts(clientId, periodStart, periodEnd);
  const value = posts.reduce((sum, post) => sum + (post.metrics.total_views ?? 0), 0);
  if (posts.length === 0) return { value: null, accuracy: null, method: "UNAVAILABLE" };
  return { value, accuracy: "EXACT", method: "SNAPSHOT", tooltip: DB_ONLY_POST_SUM_VIEWS_TOOLTIP };
}

/** Read daily gained/lost follower snapshots without fetching from Meta. */
export async function dailyFollowerMovementFromDatabase(clientId: string, periodStart: Date, periodEnd: Date): Promise<DailyFollowerMovement> {
  const connection = await fetchConnection(clientId);
  if (!connection) return { gainedSeries: [], lostSeries: [], netSeries: [], complete: false };
  const expected = daysBetweenInclusive(periodStart, periodEnd);
  const gainedByDay = new Map<string, number>();
  const lostByDay = new Map<string, number>();
  const current = startOfDayUTC(periodStart);
  const end = startOfDayUTC(periodEnd);
  while (current <= end) {
    const day = current.toISOString().slice(0, 10);
    const periodEndDay = new Date(current);
    periodEndDay.setUTCDate(periodEndDay.getUTCDate() + 1);
    periodEndDay.setUTCHours(7);
    const periodStartDay = new Date(periodEndDay);
    periodStartDay.setUTCDate(periodStartDay.getUTCDate() - 1);
    const [stored, storedLost] = await Promise.all([
      db.socialInsightSnapshot.findFirst({ where: { connection: { clientId }, metric: "followers_gained", periodType: InsightPeriodType.DAY, periodStart: periodStartDay, periodEnd: periodEndDay }, select: { value: true } }),
      db.socialInsightSnapshot.findFirst({ where: { connection: { clientId }, metric: "followers_lost", periodType: InsightPeriodType.DAY, periodStart: periodStartDay, periodEnd: periodEndDay }, select: { value: true } }),
    ]);
    if (stored && storedLost) {
      gainedByDay.set(day, stored.value);
      lostByDay.set(day, storedLost.value);
    }
    current.setUTCDate(current.getUTCDate() + 1);
  }
  const complete = gainedByDay.size >= expected;
  const gainedSeries = completeDailySeries(periodStart, periodEnd, [...gainedByDay.entries()]);
  const lostSeries = completeDailySeries(periodStart, periodEnd, [...lostByDay.entries()]);
  const netSeries: Array<[string, number]> = gainedSeries.map(([day, gained], i) => [day, gained - lostSeries[i][1]]);
  return { gainedSeries, lostSeries, netSeries, complete };
}

/** Compose follower movement for longer periods from stored daily snapshots only. */
export async function periodAccountFollowersFromDatabase(clientId: string, periodStart: Date, periodEnd: Date): Promise<FollowersResult> {
  const days = daysBetweenInclusive(periodStart, periodEnd);
  if (days <= 31) {
    const movement = await dailyFollowerMovementFromDatabase(clientId, periodStart, periodEnd);
    if (movement.gainedSeries.length === 0) return { gained: null, lost: null, net: null, accuracy: null, method: "UNAVAILABLE" };
    const gained = movement.gainedSeries.reduce((sum, [, v]) => sum + v, 0);
    const lost = movement.lostSeries.reduce((sum, [, v]) => sum + v, 0);
    const accuracy = movement.complete ? "EXACT" : null;
    const method = movement.complete ? "SNAPSHOT" : "UNAVAILABLE";
    return { gained, lost, net: gained - lost, accuracy, method };
  }

  const chunks = splitRangeByMonth(periodStart, periodEnd);
  let totalGained = 0;
  let totalLost = 0;
  for (const chunk of chunks) {
    const movement = await dailyFollowerMovementFromDatabase(clientId, chunk.start, chunk.end);
    if (movement.gainedSeries.length === 0) return { gained: null, lost: null, net: null, accuracy: null, method: "UNAVAILABLE", tooltip: LONG_RANGE_AGGREGATE_TOOLTIP };
    totalGained += movement.gainedSeries.reduce((sum, [, v]) => sum + v, 0);
    totalLost += movement.lostSeries.reduce((sum, [, v]) => sum + v, 0);
  }
  return { gained: totalGained, lost: totalLost, net: totalGained - totalLost, accuracy: "EXACT", method: "AGGREGATE_OF_PERIOD_CHUNKS", tooltip: LONG_RANGE_AGGREGATE_TOOLTIP };
}

/** Build standard blocks using only data already in the database. */
export async function buildStandardReportBlocksFromDatabase(clientId: string, periodStart: Date, periodEnd: Date): Promise<ReportBlock[]> {
  return buildStandardReportBlocks(clientId, periodStart, periodEnd, {
    reach: periodAccountReachFromDatabase,
    followers: periodAccountFollowersFromDatabase,
    views: periodAccountViewsFromDatabase,
    dailyFollowerMovement: dailyFollowerMovementFromDatabase,
  });
}

export async function buildStandardReportBlocks(clientId: string, periodStart: Date, periodEnd: Date, resolvers: Partial<ReportDataResolvers> = {}): Promise<ReportBlock[]> {
  const posts = await reportPosts(clientId, periodStart, periodEnd);
  const totals = Object.fromEntries((["reach", "views", "total_interactions", "likes", "comments", "saved", "shares", "follows", "posts"] as ReportMetric[]).map((metric) => [metric, total(posts, metric)])) as Record<ReportMetric, number>;
  const hasMetric = (metric: ReportMetric) => metric === "posts" || posts.some((post) => post.metricAvailability[metric] === "returned" || (Object.keys(post.metricAvailability).length === 0 && typeof post.metrics[metric] === "number"));
  // Account-level reach is Meta's unique-accounts-reached metric for the account; summing per-post reach would double-count
  // people reached by more than one post, so prefer the account-level daily snapshots (matches Meta's own dashboards and
  // third-party tools like Iconosquare) and only fall back to the per-post sum when no snapshots have been synced yet.
  const days = daysBetweenInclusive(periodStart, periodEnd);
  const resolve = { ...defaultReportDataResolvers, ...resolvers };
  const reach = await resolve.reach(clientId, periodStart, periodEnd);
  const followers = await resolve.followers(clientId, periodStart, periodEnd);
  const totalViews = await resolve.views(clientId, periodStart, periodEnd);
  const hasReach = reach.value !== null;
  const hasFollows = followers.gained !== null;
  const hasTotalViews = totalViews.value !== null;
  totals.reach = reach.value ?? 0;
  totals.follows = followers.gained ?? 0;
  const engagementRate = hasReach && totals.reach > 0 && hasMetric("total_interactions") ? `${((totals.total_interactions / totals.reach) * 100).toFixed(2)}%` : "غير متاح";
  const topBy = (metric: ReportMetric) => [...posts].sort((left, right) => value(right.metrics, metric) - value(left.metrics, metric)).filter((post) => value(post.metrics, metric) > 0).slice(0, 4);
  const topInteractions = topBy("total_interactions");
  const topViews = topBy("views");
  const topFollows = topBy("follows");

  const dailyMovement = days <= 31 ? await resolve.dailyFollowerMovement(clientId, periodStart, periodEnd) : { complete: false, gainedSeries: [] as Array<[string, number]>, lostSeries: [] as Array<[string, number]>, netSeries: [] as Array<[string, number]> };
  const expectedFollowerDays = daysBetweenInclusive(periodStart, periodEnd);
  const followerDataComplete = dailyMovement.complete && dailyMovement.gainedSeries.length >= expectedFollowerDays;
  // The daily chart has its own data source (a per-day `follows_and_unfollows` breakdown call) which is
  // independent from the account-level period total resolved by periodAccountFollowers()/periodAccountFollowersForRange()
  // (Meta's own range `total_value`, or an overlapping-windows composition for 31-day periods). Even when every
  // day of the chart is present, the two can legitimately diverge — never let the chart's own daily sum stand
  // in for, or be confused with, the validated period total shown on the KPI cards.
  const followerSource = followerDataComplete
    ? "بيانات المتابعين الجدد (follows_and_unfollows) اليومية من Meta."
    : `بيانات المتابعين الجدد (follows_and_unfollows) اليومية من Meta — متاحة لـ ${dailyMovement.gainedSeries.length} من أصل ${expectedFollowerDays} يوم.`;
  const followerValues = dailyMovement.gainedSeries.map(([, value]) => value);
  const followerLabels = dailyMovement.gainedSeries.map(([day]) => day);
  const followerChartHasData = dailyMovement.gainedSeries.length > 0;
  const dailyChartSum = followerValues.reduce((sum, value) => sum + value, 0);
  const followerPeriodTotalLabel = hasFollows ? followers.gained!.toLocaleString() : "غير متاح";
  const followerInsightLines = [
    `إجمالي المتابعين الجدد خلال الأيام المتاحة: ${dailyChartSum.toLocaleString()}.`,
    `إجمالي المتابعين الجدد للفترة (المصدر المعتمد): ${followerPeriodTotalLabel}.`,
  ];
  if (!followerDataComplete) {
    followerInsightLines.push(
      "تنبيه تغطية: بيانات الرسم البياني اليومية غير مكتملة لهذه الفترة، لذلك لا يعكس مجموعها الإجمالي الفعلي المعتمد أعلاه.",
    );
  } else if (hasFollows && dailyChartSum !== followers.gained) {
    followerInsightLines.push(
      "ملاحظة: القيمة المعتمدة أعلاه (periodAccountFollowers) هي المصدر الرسمي؛ الفرق عن مجموع الرسم البياني اليومي طبيعي بسبب اختلاف طريقة احتساب Meta بين المجموع اليومي والفترة الكاملة.",
    );
  }
  const followerInsight = followerInsightLines.join(" ");

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

  const followsTooltip = followers.tooltip;
  const followsExtra = followers.gained !== null ? { followersAccuracy: followers.accuracy, followersMethod: followers.method, tooltip: followsTooltip } : undefined;
  const followKpis = [
    followsExtra?.followersAccuracy === "DERIVED"
      ? kpi("follows", "المتابعون الجدد", followers.gained!.toLocaleString(), true, { ...followsExtra, badge: "مركّب" })
      : kpi("follows", "المتابعون الجدد", hasFollows ? followers.gained!.toLocaleString() : "غير متاح", hasFollows, followsExtra),
  ];

  const totalViewsExtra = totalViews.value !== null ? { viewsAccuracy: totalViews.accuracy, viewsMethod: totalViews.method, tooltip: totalViews.tooltip } : undefined;
  const totalViewsKpis = [
    totalViewsExtra?.viewsAccuracy === "DERIVED"
      ? kpi("total-views", "إجمالي المشاهدات", totalViews.value!.toLocaleString(), true, { ...totalViewsExtra, badge: "مركّب" })
      : kpi("total-views", "إجمالي المشاهدات", hasTotalViews ? totalViews.value!.toLocaleString() : "غير متاح", hasTotalViews, totalViewsExtra),
  ];
  if (followers.lost !== null && followers.net !== null) {
    followKpis.push(
      kpi("followers-lost", "المتابعون المفقودون", followers.lost.toLocaleString(), true, { tooltip: "عدد الحسابات التي ألغت المتابعة أو تركت Instagram خلال الفترة." }),
      kpi("net-follower-growth", "صافي نمو المتابعين", (followers.net >= 0 ? "+" : "") + followers.net.toLocaleString(), true, { tooltip: "المتابعون الجدد ناقص المتابعون المفقودون." }),
    );
  }

  return [
    { type: BlockType.TEXT, title: "غلاف التقرير", content: { body: "تقرير الإنجاز الشهري", page: "cover", refreshKey: "cover" satisfies ReportRefreshKey } },
    { type: BlockType.KPI, title: "أهم الإحصائيات", content: { body: "إحصائيات الفترة المحددة من بيانات Meta المتاحة.", kpis: [...reachKpis, ...followKpis, ...totalViewsKpis, kpi("views", metricLabel.views, hasMetric("views") ? totals.views.toLocaleString() : "غير متاح", hasMetric("views")), kpi("engagement-rate", "متوسط التفاعل على أساس الوصول", engagementRate, hasReach), kpi("posts", metricLabel.posts, totals.posts.toLocaleString())], autoFilled: true, refreshKey: "kpi-overview" satisfies ReportRefreshKey } },
    { type: BlockType.KPI, title: "التفاعل مع المحتوى", content: { body: "إجماليات التفاعل للمنشورات خلال الفترة.", kpis: [kpi("total_interactions", metricLabel.total_interactions, hasMetric("total_interactions") ? totals.total_interactions.toLocaleString() : "غير متاح", hasMetric("total_interactions")), kpi("likes", metricLabel.likes, hasMetric("likes") ? totals.likes.toLocaleString() : "غير متاح", hasMetric("likes")), kpi("comments", metricLabel.comments, hasMetric("comments") ? totals.comments.toLocaleString() : "غير متاح", hasMetric("comments")), kpi("saved", "حفظ", hasMetric("saved") ? totals.saved.toLocaleString() : "غير متاح", hasMetric("saved")), kpi("shares", "مشاركة", hasMetric("shares") ? totals.shares.toLocaleString() : "غير متاح", hasMetric("shares"))], autoFilled: true, refreshKey: "kpi-interactions" satisfies ReportRefreshKey } },
    { type: BlockType.CHART, title: "معدل اكتساب المتابعين اليومي", content: followerChartHasData ? { body: followerSource, chart: { type: "line", metric: "المتابعون الجدد يومياً", values: followerValues.join(", "), labels: followerLabels.join(", "), insight: followerInsight }, refreshKey: "chart-followers" satisfies ReportRefreshKey } : { body: followerSource, chartUnavailable: true, unavailableReason: "تعذّر جلب بيانات follows_and_unfollows اليومية للفترة؛ لا توجد بيانات يومية متاحة.", refreshKey: "chart-followers" satisfies ReportRefreshKey } },
    mediaBlock("أعلى المنشورات من حيث اكتساب المتابعين", "تم اختيار المنشورات الأعلى من بيانات الفترة.", topFollows, ["follows"], "media-top-follows"),
    mediaBlock("أعلى المنشورات من حيث التفاعل", "تم اختيار المنشورات الأعلى تفاعلاً من بيانات الفترة.", topInteractions, ["total_interactions", "views"], "media-top-interactions"),
    mediaBlock("أعلى المنشورات من حيث المشاهدات العضوية", "تم اختيار المنشورات الأعلى مشاهدة عضوياً من بيانات الفترة.", topViews, ["views", "total_interactions"], "media-top-views"),
    mediaBlock("محتوى الشهر", "أضيفي نماذج إضافية من المحتوى أو احتفظي بالمنشورات المختارة تلقائياً.", [...posts].sort((left, right) => right.score - left.score).slice(0, 4), ["total_interactions", "views"], "media-month-content"),
    { type: BlockType.NOTES, title: "التوصيات", content: { body: "أضيفي توصيات عملية قابلة للتنفيذ للشهر القادم.", refreshKey: "notes-recommendations" satisfies ReportRefreshKey } },
    { type: BlockType.TEXT, title: "شكراً على ثقتكم", content: { body: "Kaan Creative", page: "closing", refreshKey: "closing" satisfies ReportRefreshKey } },
  ];
}

const LONG_RANGE_REACH_TOOLTIP = "لا يمكن حساب الوصول الفريد لأكثر من 31 يوماً؛ Meta API لا توفر نافذة وصول فريدة لهذه المدة وتجميع نوافذ أقصر لا يُنتج قيمة فريدة صحيحة.";
const LONG_RANGE_AGGREGATE_TOOLTIP = "قيمة محسوبة بجمع القيم الشهرية (أو جزئية) باستخدام total_value المباشر أو التركيب المتداخل للنوافذ حيثما لزم الأمر. تنطبق على المقاييس التراكمية فقط.";

/** Long-range Reach resolver.
 *  - ≤30 days: exact Meta total_value.
 *  - 31 days: existing overlapping-window estimate.
 *  - >31 days: UNAVAILABLE. Unique Reach is non-additive; summing shorter windows
 *    would misrepresent the true unique audience for the full period. */
export async function periodAccountReachForRange(clientId: string, periodStart: Date, periodEnd: Date): Promise<ReachResult> {
  const days = daysBetweenInclusive(periodStart, periodEnd);
  if (days <= 31) return periodAccountReach(clientId, periodStart, periodEnd);
  return { value: null, accuracy: null, method: "UNAVAILABLE", tooltip: LONG_RANGE_REACH_TOOLTIP };
}

function mergeAccuracy(values: Array<"EXACT" | "DERIVED" | null>): "EXACT" | "DERIVED" | null {
  if (values.some((a) => a === null)) return null;
  if (values.includes("DERIVED")) return "DERIVED";
  return "EXACT";
}

/** Long-range Total Views resolver.
 *  - ≤31 days: delegates to periodAccountViews.
 *  - >31 days: splits the range into calendar-month chunks (each ≤31 days),
 *    resolves each chunk via the existing ≤31-day logic, and sums the results.
 *    Total views are additive across disjoint time windows, so this aggregation is valid. */
export async function periodAccountViewsForRange(clientId: string, periodStart: Date, periodEnd: Date): Promise<ViewsResult> {
  const days = daysBetweenInclusive(periodStart, periodEnd);
  if (days <= 31) return periodAccountViews(clientId, periodStart, periodEnd);

  const chunks = splitRangeByMonth(periodStart, periodEnd);
  const results = await Promise.all(chunks.map((chunk) => periodAccountViews(clientId, chunk.start, chunk.end)));

  if (results.some((r) => r.value === null)) {
    return { value: null, accuracy: null, method: "UNAVAILABLE", tooltip: LONG_RANGE_AGGREGATE_TOOLTIP };
  }

  const total = results.reduce((sum, r) => sum + (r.value ?? 0), 0);
  const accuracy = mergeAccuracy(results.map((r) => r.accuracy));
  return {
    value: total,
    accuracy,
    method: "AGGREGATE_OF_PERIOD_CHUNKS",
    tooltip: LONG_RANGE_AGGREGATE_TOOLTIP,
  };
}

/** Long-range Follower movement resolver.
 *  - ≤31 days: delegates to periodAccountFollowers.
 *  - >31 days: splits the range into calendar-month chunks and sums gained/lost/net.
 *    Follower movement is additive across disjoint time windows, so this is valid. */
export async function periodAccountFollowersForRange(clientId: string, periodStart: Date, periodEnd: Date): Promise<FollowersResult> {
  const days = daysBetweenInclusive(periodStart, periodEnd);
  if (days <= 31) return periodAccountFollowers(clientId, periodStart, periodEnd);

  const chunks = splitRangeByMonth(periodStart, periodEnd);
  const results = await Promise.all(chunks.map((chunk) => periodAccountFollowers(clientId, chunk.start, chunk.end)));

  if (results.some((r) => r.gained === null || r.lost === null)) {
    return { gained: null, lost: null, net: null, accuracy: null, method: "UNAVAILABLE", tooltip: LONG_RANGE_AGGREGATE_TOOLTIP };
  }

  const gained = results.reduce((sum, r) => sum + (r.gained ?? 0), 0);
  const lost = results.reduce((sum, r) => sum + (r.lost ?? 0), 0);
  const accuracy = mergeAccuracy(results.map((r) => r.accuracy));
  return {
    gained,
    lost,
    net: gained - lost,
    accuracy,
    method: "AGGREGATE_OF_PERIOD_CHUNKS",
    tooltip: LONG_RANGE_AGGREGATE_TOOLTIP,
  };
}
