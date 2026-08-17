import { NextRequest, NextResponse } from "next/server";
import { InsightPeriodType } from "@prisma/client";
import { db } from "@/lib/db";
import { requireFeature } from "@/lib/access";
import { completeDailySeries } from "@/lib/report-data";
import { mediaThumbnailUrl } from "@/lib/media-storage";

export async function GET(request: NextRequest, { params }: { params: Promise<{ clientId: string }> }) {
  if (!(await requireFeature(request, "view_reports"))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { clientId } = await params;
  const startValue = request.nextUrl.searchParams.get("periodStart");
  const endValue = request.nextUrl.searchParams.get("periodEnd");
  const since = startValue ? new Date(`${startValue}T00:00:00.000Z`) : new Date();
  const until = endValue ? new Date(`${endValue}T23:59:59.999Z`) : undefined;
  if (!startValue) since.setMonth(since.getMonth() - 3);
  if (Number.isNaN(since.valueOf()) || (until && Number.isNaN(until.valueOf()))) return NextResponse.json({ error: "Invalid report period." }, { status: 400 });
  const posts = await db.socialPost.findMany({ where: { connection: { clientId }, publishedAt: { gte: since, ...(until ? { lte: until } : {}) } }, orderBy: { publishedAt: "desc" }, take: 100 });
  const ranked = posts.map((post) => {
    const metrics = post.metrics as Record<string, number>;
    return { ...post, thumbnailStorageUrl: mediaThumbnailUrl(post.thumbnailStorageKey), isCollaborative: post.mediaSource === "COLLABORATIVE", score: (metrics.total_interactions ?? 0) + (metrics.shares ?? 0) + (metrics.saved ?? 0) + (metrics.follows ?? 0) };
  }).sort((left, right) => right.score - left.score);
  const snapshots = await db.socialInsightSnapshot.findMany({ where: { connection: { clientId }, metric: "follower_count", periodType: InsightPeriodType.DAY, periodEnd: { gte: since, ...(until ? { lte: until } : {}) } }, orderBy: { periodEnd: "asc" } });
  const followerEntries = [...snapshots.reduce((days, snapshot) => { const day = snapshot.periodEnd.toISOString().slice(0, 10); days.set(day, (days.get(day) ?? 0) + snapshot.value); return days; }, new Map<string, number>()).entries()];
  const postFollowerEntries = [...ranked.map((post) => ({ ...post, metrics: post.metrics as Record<string, number> })).filter((post) => (post.metrics.follows ?? 0) > 0).reduce((days, post) => { const day = post.publishedAt.toISOString().slice(0, 10); days.set(day, (days.get(day) ?? 0) + (post.metrics.follows ?? 0)); return days; }, new Map<string, number>()).entries()];
  const series = followerEntries.length > 0 ? followerEntries : postFollowerEntries;
  const completeSeries = completeDailySeries(since, until ?? new Date(), series);
  return NextResponse.json({ posts: ranked, followerSeries: completeSeries.map(([, value]) => value), followerLabels: completeSeries.map(([day]) => day), hasFollowerData: series.length > 0 });
}
