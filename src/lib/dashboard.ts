import { ReportStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { completeDailySeries } from "@/lib/report-data";

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

export async function connectedInstagramAccountsCount() {
  return db.socialConnection.count({ where: { platform: "INSTAGRAM" } });
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
  const posts = await db.socialPost.findMany({
    where: { publishedAt: { gte: periodStart, lte: periodEnd } },
    select: { publishedAt: true, metrics: true, metricAvailability: true },
  });
  const entries = posts
    .filter((post) => (post.metricAvailability as Record<string, string> | null)?.reach === "returned" || typeof (post.metrics as Record<string, number>).reach === "number")
    .map((post) => {
      const day = post.publishedAt.toISOString().slice(0, 10);
      const metrics = post.metrics as Record<string, number>;
      return [day, metrics.reach ?? 0] as [string, number];
    });
  const dayTotals = new Map<string, number>();
  for (const [day, value] of entries) dayTotals.set(day, (dayTotals.get(day) ?? 0) + value);
  const series = completeDailySeries(periodStart, periodEnd, [...dayTotals.entries()]);
  return { labels: series.map(([day]) => day), values: series.map(([, value]) => value) };
}
