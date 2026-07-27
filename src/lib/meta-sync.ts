import { Platform } from "@prisma/client";
import { db } from "@/lib/db";
import { decryptToken } from "@/lib/token-encryption";

type MetaMedia = { id: string; caption?: string; media_type?: string; media_url?: string; thumbnail_url?: string; permalink?: string; timestamp?: string; like_count?: number; comments_count?: number };
type MetaInsight = { name?: string; values?: Array<{ value?: number; end_time?: string }> };

const graphUrl = "https://graph.facebook.com/v23.0";

async function graph<T>(path: string, token: string, parameters: Record<string, string>) {
  const url = new URL(`${graphUrl}/${path}`);
  Object.entries({ ...parameters, access_token: token }).forEach(([key, value]) => url.searchParams.set(key, value));
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error("Meta sync request failed.");
  return response.json() as Promise<T>;
}

async function postInsights(postId: string, token: string) {
  const metrics: Record<string, number> = {};
  for (const metric of ["views", "reach", "saved", "shares", "total_interactions", "follows"]) {
    try {
      const insights = await graph<{ data?: MetaInsight[] }>(`${postId}/insights`, token, { metric });
      const insight = insights.data?.[0];
      const value = insight?.values?.[0]?.value;
      if (typeof insight?.name === "string" && typeof value === "number") metrics[insight.name] = value;
    } catch {}
  }
  return metrics;
}

async function syncDailyFollows(connectionId: string, accountId: string, token: string, since: Date) {
  try {
    const insights = await graph<{ data?: MetaInsight[] }>(`${accountId}/insights`, token, { metric: "follows", period: "day", since: String(Math.floor(since.valueOf() / 1000)), until: String(Math.floor(Date.now() / 1000)) });
    for (const insight of insights.data ?? []) for (const item of insight.values ?? []) {
      if (typeof item.value !== "number" || !item.end_time) continue;
      const periodEnd = new Date(item.end_time);
      const periodStart = new Date(periodEnd);
      periodStart.setUTCDate(periodStart.getUTCDate() - 1);
      await db.socialInsightSnapshot.upsert({ where: { connectionId_metric_periodStart_periodEnd: { connectionId, metric: "follows", periodStart, periodEnd } }, create: { connectionId, metric: "follows", periodStart, periodEnd, value: item.value }, update: { value: item.value } });
    }
  } catch {}
}

export async function syncClientInstagramPosts(clientId: string) {
  const connections = await db.socialConnection.findMany({ where: { clientId, platform: Platform.INSTAGRAM }, select: { id: true, externalAccountId: true, encryptedToken: true } });
  let synced = 0;
  const since = new Date();
  since.setMonth(since.getMonth() - 3);

  for (const connection of connections) {
    const token = decryptToken(connection.encryptedToken);
    const media = await graph<{ data?: MetaMedia[] }>(`${connection.externalAccountId}/media`, token, { fields: "id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count", since: String(Math.floor(since.valueOf() / 1000)), limit: "100" });
    for (const item of media.data ?? []) {
      if (!item.timestamp || !item.media_type) continue;
      const insightMetrics = await postInsights(item.id, token);
      const metrics: Record<string, number> = { likes: item.like_count ?? 0, comments: item.comments_count ?? 0, ...insightMetrics };
      metrics.total_interactions ??= metrics.likes + metrics.comments + (metrics.saved ?? 0) + (metrics.shares ?? 0);
      await db.socialPost.upsert({
        where: { connectionId_externalPostId: { connectionId: connection.id, externalPostId: item.id } },
        create: { connectionId: connection.id, externalPostId: item.id, caption: item.caption, mediaType: item.media_type, mediaUrl: item.media_url, thumbnailUrl: item.thumbnail_url, permalink: item.permalink, publishedAt: new Date(item.timestamp), metrics },
        update: { caption: item.caption, mediaType: item.media_type, mediaUrl: item.media_url, thumbnailUrl: item.thumbnail_url, permalink: item.permalink, publishedAt: new Date(item.timestamp), metrics },
      });
      synced += 1;
    }
    await syncDailyFollows(connection.id, connection.externalAccountId, token, since);
    await db.socialConnection.update({ where: { id: connection.id }, data: { lastSyncedAt: new Date() } });
  }
  return { connections: connections.length, posts: synced };
}
