import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/session";

export async function GET(request: NextRequest, { params }: { params: Promise<{ clientId: string }> }) {
  if (!(await getSessionUser(request))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { clientId } = await params;
  const since = new Date();
  since.setMonth(since.getMonth() - 3);
  const posts = await db.socialPost.findMany({ where: { connection: { clientId }, publishedAt: { gte: since } }, orderBy: { publishedAt: "desc" }, take: 100 });
  const ranked = posts.map((post) => {
    const metrics = post.metrics as Record<string, number>;
    return { ...post, score: (metrics.total_interactions ?? 0) + (metrics.shares ?? 0) + (metrics.saved ?? 0) + (metrics.follows ?? 0) };
  }).sort((left, right) => right.score - left.score);
  return NextResponse.json({ posts: ranked });
}
