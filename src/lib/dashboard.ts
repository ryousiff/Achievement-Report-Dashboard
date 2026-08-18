import { InsightPeriodType, ReportStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { completeDailySeries } from "@/lib/report-data";

export function deduplicateByExternalPostId<T extends { externalPostId?: string | null }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (!item.externalPostId) return true;
    if (seen.has(item.externalPostId)) return false;
    seen.add(item.externalPostId);
    return true;
  });
}

export function startOfToday(daysAgo = 0) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - daysAgo);
  date.setUTCHours(0, 0, 0, 0);
  return date;
}

export function startOfMonth(date = new Date()) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

export function endOfMonth(date = new Date()) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0, 23, 59, 59, 999));
}

export async function activeClientsCount() {
  return db.client.count({ where: { active: true } });
}

/** New clients created within the current calendar month, for the "+N this month" dashboard subtitle. */
export async function newClientsThisMonthCount() {
  return db.client.count({ where: { createdAt: { gte: startOfMonth(), lte: endOfMonth() } } });
}

export async function reportsNeedingReviewCount() {
  return db.report.count({ where: { status: ReportStatus.NEEDS_REVIEW } });
}

export async function completedReportsThisMonthCount() {
  return db.report.count({
    where: {
      status: { in: [ReportStatus.APPROVED, ReportStatus.EXPORTED] },
      createdAt: { gte: startOfMonth(), lte: endOfMonth() },
    },
  });
}

/** Same as completedReportsThisMonthCount, for the previous calendar month, so the dashboard can show
 * an actual "+N/-N from last month" comparison instead of a fixed placeholder. */
export async function completedReportsLastMonthCount() {
  const lastMonth = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - 1, 1));
  return db.report.count({
    where: {
      status: { in: [ReportStatus.APPROVED, ReportStatus.EXPORTED] },
      createdAt: { gte: startOfMonth(lastMonth), lte: endOfMonth(lastMonth) },
    },
  });
}

export async function connectedInstagramAccountsCount() {
  return db.socialConnection.count({ where: { platform: "INSTAGRAM" } });
}

/** Most recent successful sync across every Instagram connection, for the "last synced N ago"
 * dashboard subtitle. Null when no Instagram connection has ever synced successfully. */
export async function mostRecentInstagramSyncAt(): Promise<Date | null> {
  const connection = await db.socialConnection.findFirst({
    where: { platform: "INSTAGRAM", lastSuccessfulSyncAt: { not: null } },
    orderBy: { lastSuccessfulSyncAt: "desc" },
    select: { lastSuccessfulSyncAt: true },
  });
  return connection?.lastSuccessfulSyncAt ?? null;
}

export async function recentReports(limit = 5) {
  return db.report.findMany({
    where: { status: { in: [ReportStatus.NEEDS_REVIEW, ReportStatus.APPROVED, ReportStatus.EXPORTED] } },
    include: { client: { select: { name: true } } },
    orderBy: { updatedAt: "desc" },
    take: limit,
  });
}

export async function connectedAccounts() {
  return db.socialConnection.findMany({
    where: { sourceAccountId: { not: null } },
    select: {
      id: true,
      platform: true,
      displayName: true,
      lastSuccessfulSyncAt: true,
      client: { select: { name: true } },
    },
    orderBy: { lastSuccessfulSyncAt: "desc" },
    take: 10,
  });
}

export async function reachSeries(days = 30) {
  const periodEnd = new Date();
  const periodStart = startOfToday(days - 1);
  // Prefer Meta's account-level daily reach snapshots (unique accounts reached per day) over summing per-post reach,
  // which double-counts people reached by more than one post and inflates totals vs. Meta's own numbers.
  const snapshots = await db.socialInsightSnapshot.findMany({
    where: { metric: "reach", periodType: InsightPeriodType.DAY, periodEnd: { gte: periodStart, lte: periodEnd } },
    select: { periodEnd: true, value: true },
  });
  const dayTotals = new Map<string, number>();
  if (snapshots.length > 0) {
    for (const snapshot of snapshots) { const day = snapshot.periodEnd.toISOString().slice(0, 10); dayTotals.set(day, (dayTotals.get(day) ?? 0) + snapshot.value); }
  } else {
    const posts = await db.socialPost.findMany({
      where: { publishedAt: { gte: periodStart, lte: periodEnd } },
      select: { publishedAt: true, externalPostId: true, metrics: true, metricAvailability: true },
    });
    const entries = deduplicateByExternalPostId(posts)
      .filter((post) => (post.metricAvailability as Record<string, string> | null)?.reach === "returned" || typeof (post.metrics as Record<string, number>).reach === "number")
      .map((post) => {
        const day = post.publishedAt.toISOString().slice(0, 10);
        const metrics = post.metrics as Record<string, number>;
        return [day, metrics.reach ?? 0] as [string, number];
      });
    for (const [day, value] of entries) dayTotals.set(day, (dayTotals.get(day) ?? 0) + value);
  }
  const series = completeDailySeries(periodStart, periodEnd, [...dayTotals.entries()]);
  return { labels: series.map(([day]) => day), values: series.map(([, value]) => value) };
}
