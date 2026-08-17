import { InsightPeriodType } from "@prisma/client";
import { db } from "@/lib/db";
import {
  buildStandardReportBlocks,
  dailyFollowerMovement,
  dailyFollowerMovementFromDatabase,
  periodAccountFollowersForRange,
  periodAccountReachForRange,
  periodAccountViewsForRange,
  type FollowersResult,
  type ReachResult,
  type ReportBlock,
  type ViewsResult,
} from "@/lib/report-data";
import { splitRangeByMonth } from "@/lib/report-period";

const LONG_RANGE_REACH_TOOLTIP = "لا يمكن حساب الوصول الفريد لأكثر من 31 يوماً؛ Meta API لا توفر نافذة وصول فريدة لهذه المدة وتجميع نوافذ أقصر لا يُنتج قيمة فريدة صحيحة.";
const LONG_RANGE_AGGREGATE_TOOLTIP = "قيمة محسوبة بجمع القيم الشهرية المحفوظة في قاعدة البيانات. تنطبق على المقاييس التراكمية فقط.";
const REACH_31_DAY_TOOLTIP = "قيمة تقديرية محفوظة للفترة ومحتسبة من نوافذ الوصول الفريد المتداخلة في Meta API، لأن Meta API لا يوفر نافذة وصول فريدة مباشرة لمدة 31 يوماً.";
const DERIVED_31_DAY_TOOLTIP = "قيمة محفوظة للفترة ومركّبة من نوافذ Meta total_value المتداخلة لأن Meta API لا يتيح نطاقاً زمنياً مباشراً لمدة 31 يوماً.";

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
  const start = startOfDayUTC(from);
  const end = startOfDayUTC(to);
  return Math.max(1, Math.floor((end.valueOf() - start.valueOf()) / (24 * 60 * 60 * 1000)) + 1);
}

/** Read one authoritative account-period value that the sync worker previously persisted.
 * TOTAL_VALUE snapshots are keyed by the exact report-period boundaries and are never reconstructed
 * from daily reach, media views, or the follower chart. */
export async function storedPeriodMetric(
  clientId: string,
  metric: "reach" | "views" | "followers_gained" | "followers_lost",
  periodStart: Date,
  periodEnd: Date,
): Promise<number | null> {
  const rows = await db.socialInsightSnapshot.findMany({
    take: 1,
    where: {
      connection: { clientId },
      metric,
      periodType: InsightPeriodType.TOTAL_VALUE,
      periodStart: { gte: startOfDayUTC(periodStart), lte: endOfDayUTC(periodStart) },
      periodEnd: { gte: startOfDayUTC(periodEnd), lte: endOfDayUTC(periodEnd) },
    },
    orderBy: { capturedAt: "desc" },
    select: { value: true },
  });
  return rows[0]?.value ?? null;
}

/** Unique Reach is deliberately unavailable for ranges longer than 31 days because it is non-additive. */
export async function storedAccountReachForRange(clientId: string, periodStart: Date, periodEnd: Date): Promise<ReachResult> {
  const days = daysBetweenInclusive(periodStart, periodEnd);
  if (days > 31) return { value: null, accuracy: null, method: "UNAVAILABLE", tooltip: LONG_RANGE_REACH_TOOLTIP };

  const value = await storedPeriodMetric(clientId, "reach", periodStart, periodEnd);
  if (value === null) return { value: null, accuracy: null, method: "UNAVAILABLE" };

  if (days === 31) {
    return {
      value,
      accuracy: "ESTIMATED",
      method: "OVERLAPPING_WINDOWS_ESTIMATE",
      tooltip: REACH_31_DAY_TOOLTIP,
    };
  }
  return { value, accuracy: "EXACT", method: "META_TOTAL_VALUE" };
}

async function storedViewsForSinglePeriod(clientId: string, periodStart: Date, periodEnd: Date): Promise<ViewsResult> {
  const value = await storedPeriodMetric(clientId, "views", periodStart, periodEnd);
  if (value === null) return { value: null, accuracy: null, method: "UNAVAILABLE" };
  const days = daysBetweenInclusive(periodStart, periodEnd);
  return days === 31
    ? { value, accuracy: "DERIVED", method: "OVERLAPPING_WINDOWS_COMPOSITION", tooltip: DERIVED_31_DAY_TOOLTIP }
    : { value, accuracy: "EXACT", method: "META_TOTAL_VALUE" };
}

/** Total Views are additive across disjoint calendar periods, so long reports sum stored monthly totals. */
export async function storedAccountViewsForRange(clientId: string, periodStart: Date, periodEnd: Date): Promise<ViewsResult> {
  const days = daysBetweenInclusive(periodStart, periodEnd);
  if (days <= 31) return storedViewsForSinglePeriod(clientId, periodStart, periodEnd);

  const chunks = splitRangeByMonth(periodStart, periodEnd);
  const results = await Promise.all(chunks.map((chunk) => storedViewsForSinglePeriod(clientId, chunk.start, chunk.end)));
  if (results.some((result) => result.value === null)) {
    return { value: null, accuracy: null, method: "UNAVAILABLE", tooltip: LONG_RANGE_AGGREGATE_TOOLTIP };
  }
  const value = results.reduce((sum, result) => sum + (result.value ?? 0), 0);
  const accuracy = results.some((result) => result.accuracy === "DERIVED") ? "DERIVED" : "EXACT";
  return { value, accuracy, method: "AGGREGATE_OF_PERIOD_CHUNKS", tooltip: LONG_RANGE_AGGREGATE_TOOLTIP };
}

async function storedFollowersForSinglePeriod(clientId: string, periodStart: Date, periodEnd: Date): Promise<FollowersResult> {
  const [gained, lost] = await Promise.all([
    storedPeriodMetric(clientId, "followers_gained", periodStart, periodEnd),
    storedPeriodMetric(clientId, "followers_lost", periodStart, periodEnd),
  ]);
  if (gained === null || lost === null) {
    return { gained: null, lost: null, net: null, accuracy: null, method: "UNAVAILABLE" };
  }
  const days = daysBetweenInclusive(periodStart, periodEnd);
  return days === 31
    ? {
        gained,
        lost,
        net: gained - lost,
        accuracy: "DERIVED",
        method: "OVERLAPPING_WINDOWS_COMPOSITION",
        tooltip: DERIVED_31_DAY_TOOLTIP,
      }
    : { gained, lost, net: gained - lost, accuracy: "EXACT", method: "META_TOTAL_VALUE" };
}

/** Follower movement is additive across disjoint calendar periods, so long reports sum stored month totals. */
export async function storedAccountFollowersForRange(clientId: string, periodStart: Date, periodEnd: Date): Promise<FollowersResult> {
  const days = daysBetweenInclusive(periodStart, periodEnd);
  if (days <= 31) return storedFollowersForSinglePeriod(clientId, periodStart, periodEnd);

  const chunks = splitRangeByMonth(periodStart, periodEnd);
  const results = await Promise.all(chunks.map((chunk) => storedFollowersForSinglePeriod(clientId, chunk.start, chunk.end)));
  if (results.some((result) => result.gained === null || result.lost === null)) {
    return { gained: null, lost: null, net: null, accuracy: null, method: "UNAVAILABLE", tooltip: LONG_RANGE_AGGREGATE_TOOLTIP };
  }
  const gained = results.reduce((sum, result) => sum + (result.gained ?? 0), 0);
  const lost = results.reduce((sum, result) => sum + (result.lost ?? 0), 0);
  const accuracy = results.some((result) => result.accuracy === "DERIVED") ? "DERIVED" : "EXACT";
  return {
    gained,
    lost,
    net: gained - lost,
    accuracy,
    method: "AGGREGATE_OF_PERIOD_CHUNKS",
    tooltip: LONG_RANGE_AGGREGATE_TOOLTIP,
  };
}

async function reachPreferStored(clientId: string, periodStart: Date, periodEnd: Date): Promise<ReachResult> {
  const stored = await storedAccountReachForRange(clientId, periodStart, periodEnd);
  if (stored.value !== null || daysBetweenInclusive(periodStart, periodEnd) > 31) return stored;
  return periodAccountReachForRange(clientId, periodStart, periodEnd);
}

/** For report creation, reuse every stored monthly Views total and ask Meta only for missing chunks. */
async function viewsPreferStored(clientId: string, periodStart: Date, periodEnd: Date): Promise<ViewsResult> {
  const days = daysBetweenInclusive(periodStart, periodEnd);
  if (days <= 31) {
    const stored = await storedViewsForSinglePeriod(clientId, periodStart, periodEnd);
    return stored.value !== null ? stored : periodAccountViewsForRange(clientId, periodStart, periodEnd);
  }
  const chunks = splitRangeByMonth(periodStart, periodEnd);
  const results: ViewsResult[] = [];
  for (const chunk of chunks) {
    const stored = await storedViewsForSinglePeriod(clientId, chunk.start, chunk.end);
    results.push(stored.value !== null ? stored : await periodAccountViewsForRange(clientId, chunk.start, chunk.end));
  }
  if (results.some((result) => result.value === null)) return { value: null, accuracy: null, method: "UNAVAILABLE", tooltip: LONG_RANGE_AGGREGATE_TOOLTIP };
  return {
    value: results.reduce((sum, result) => sum + (result.value ?? 0), 0),
    accuracy: results.some((result) => result.accuracy === "DERIVED") ? "DERIVED" : "EXACT",
    method: "AGGREGATE_OF_PERIOD_CHUNKS",
    tooltip: LONG_RANGE_AGGREGATE_TOOLTIP,
  };
}

/** For report creation, reuse every stored monthly follower total and ask Meta only for missing chunks. */
async function followersPreferStored(clientId: string, periodStart: Date, periodEnd: Date): Promise<FollowersResult> {
  const days = daysBetweenInclusive(periodStart, periodEnd);
  if (days <= 31) {
    const stored = await storedFollowersForSinglePeriod(clientId, periodStart, periodEnd);
    return stored.gained !== null && stored.lost !== null ? stored : periodAccountFollowersForRange(clientId, periodStart, periodEnd);
  }
  const chunks = splitRangeByMonth(periodStart, periodEnd);
  const results: FollowersResult[] = [];
  for (const chunk of chunks) {
    const stored = await storedFollowersForSinglePeriod(clientId, chunk.start, chunk.end);
    results.push(stored.gained !== null && stored.lost !== null ? stored : await periodAccountFollowersForRange(clientId, chunk.start, chunk.end));
  }
  if (results.some((result) => result.gained === null || result.lost === null)) {
    return { gained: null, lost: null, net: null, accuracy: null, method: "UNAVAILABLE", tooltip: LONG_RANGE_AGGREGATE_TOOLTIP };
  }
  const gained = results.reduce((sum, result) => sum + (result.gained ?? 0), 0);
  const lost = results.reduce((sum, result) => sum + (result.lost ?? 0), 0);
  return {
    gained,
    lost,
    net: gained - lost,
    accuracy: results.some((result) => result.accuracy === "DERIVED") ? "DERIVED" : "EXACT",
    method: "AGGREGATE_OF_PERIOD_CHUNKS",
    tooltip: LONG_RANGE_AGGREGATE_TOOLTIP,
  };
}

/** DB-only report builder used by refresh/export. Account-period KPIs come only from authoritative
 * TOTAL_VALUE snapshots; media/post metrics continue to come from SocialPost rows. */
export async function buildStandardReportBlocksFromStoredPeriodSnapshots(
  clientId: string,
  periodStart: Date,
  periodEnd: Date,
): Promise<ReportBlock[]> {
  return buildStandardReportBlocks(clientId, periodStart, periodEnd, {
    reach: storedAccountReachForRange,
    views: storedAccountViewsForRange,
    followers: storedAccountFollowersForRange,
    dailyFollowerMovement: dailyFollowerMovementFromDatabase,
  });
}

/** Initial report creation prefers DB snapshots to avoid unnecessary Meta requests, but can still fall back
 * to Meta for a recent missing period. Refresh/export never use this mixed mode. */
export async function buildStandardReportBlocksPreferStoredPeriodSnapshots(
  clientId: string,
  periodStart: Date,
  periodEnd: Date,
): Promise<ReportBlock[]> {
  return buildStandardReportBlocks(clientId, periodStart, periodEnd, {
    reach: reachPreferStored,
    views: viewsPreferStored,
    followers: followersPreferStored,
    dailyFollowerMovement,
  });
}
