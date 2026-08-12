import { NextRequest, NextResponse } from "next/server";
import { requireFeature } from "@/lib/access";
import {
  reportPosts,
  periodAccountReachForRange,
  periodAccountViewsForRange,
  periodAccountFollowersForRange,
} from "@/lib/report-data";

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

  const [reach, totalViews, followers] = await Promise.all([
    periodAccountReachForRange(clientId, since, until),
    periodAccountViewsForRange(clientId, since, until),
    periodAccountFollowersForRange(clientId, since, until),
  ]);

  const totalInteractions = sumMetric(posts, "total_interactions");
  const engagementRate =
    reach.value && reach.value > 0
      ? `${((totalInteractions / reach.value) * 100).toFixed(2)}%`
      : null;

  return NextResponse.json({
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
    total_interactions: totalInteractions,
    likes: sumMetric(posts, "likes"),
    comments: sumMetric(posts, "comments"),
    shares: sumMetric(posts, "shares"),
    saved: sumMetric(posts, "saved"),
    "media-follows": sumMetric(posts, "follows"),
    "engagement-rate": engagementRate,
  });
}
