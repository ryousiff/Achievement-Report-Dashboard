import { NextRequest, NextResponse } from "next/server";
import { requireFeature } from "@/lib/access";
import {
  reportPosts,
  periodAccountReachForRange,
  periodAccountViewsForRange,
  periodAccountFollowersForRange,
  periodAccountInteractionsForRange,
  followersCountAt,
} from "@/lib/report-data";
import { periodPaidMetricsForRange } from "@/lib/ads-insights";

function sumMetric(posts: Array<{ metrics: Record<string, number> }>, metric: string) {
  return posts.reduce((acc, post) => acc + (post.metrics[metric] ?? 0), 0);
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ clientId: string }> }) {
  if (!(await requireFeature(request, "view_reports")))
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { clientId } = await params;
  const startValue = request.nextUrl.searchParams.get("periodStart");
  const endValue = request.nextUrl.searchParams.get("periodEnd");
  const since = startValue ? new Date(`${startValue}T00:00:00.000Z`) : new Date();
  const until = endValue ? new Date(`${endValue}T23:59:59.999Z`) : new Date();
  if (!startValue) since.setMonth(since.getMonth() - 3);
  if (Number.isNaN(since.valueOf()) || Number.isNaN(until.valueOf()))
    return NextResponse.json({ error: "Invalid report period." }, { status: 400 });

  const posts = await reportPosts(clientId, since, until);
  const ownedPosts = posts.filter((post) => post.mediaSource === "OWNED");
  const collabPosts = posts.filter((post) => post.mediaSource === "COLLABORATIVE");

  const [reach, totalViews, followers, followersCount, interactions, paid] = await Promise.all([
    periodAccountReachForRange(clientId, since, until),
    periodAccountViewsForRange(clientId, since, until),
    periodAccountFollowersForRange(clientId, since, until),
    followersCountAt(clientId, until),
    periodAccountInteractionsForRange(clientId, since, until),
    periodPaidMetricsForRange(clientId, since, until),
  ]);

  const totalInteractions = sumMetric(posts, "total_interactions");
  const combinedInteractions = (interactions.values.total_interactions ?? totalInteractions) + (paid.values.paid_interactions ?? 0);
  const engagementRate =
    reach.value && reach.value > 0
      ? `${((combinedInteractions / reach.value) * 100).toFixed(2)}%`
      : null;

  return NextResponse.json({
    followers: followersCount,
    reach: reach.value,
    reachAccuracy: reach.accuracy,
    reachMethod: reach.method,
    "total-views": totalViews.value,
    totalViewsAccuracy: totalViews.accuracy,
    totalViewsMethod: totalViews.method,
    views: sumMetric(ownedPosts, "views"),
    collaborativeViews: sumMetric(collabPosts, "views"),
    follows: followers.gained,
    "followers-lost": followers.lost,
    "net-follower-growth": followers.net,
    followersAccuracy: followers.accuracy,
    followersMethod: followers.method,
    posts: posts.length,
    "owned-posts": ownedPosts.length,
    "collaborative-posts": collabPosts.length,
    total_interactions: combinedInteractions,
    likes: (interactions.values.likes ?? sumMetric(posts, "likes")) + (paid.values.ad_likes ?? 0),
    comments: (interactions.values.comments ?? sumMetric(posts, "comments")) + (paid.values.ad_comments ?? 0),
    shares: (interactions.values.shares ?? sumMetric(posts, "shares")) + (paid.values.ad_shares ?? 0),
    saved: (interactions.values.saved ?? sumMetric(posts, "saved")) + (paid.values.ad_saved ?? 0),
    "media-follows": sumMetric(posts, "follows"),
    "engagement-rate": engagementRate,
  });
}
