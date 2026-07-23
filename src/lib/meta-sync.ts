import { Platform } from "@prisma/client";
import { db } from "@/lib/db";
import { decryptToken } from "@/lib/token-encryption";

type MetaMedia = { id: string; caption?: string; media_type?: string; media_url?: string; thumbnail_url?: string; permalink?: string; timestamp?: string; like_count?: number; comments_count?: number };
type MetaInsight = { name?: string; values?: Array<{ value?: number }> };

const graphUrl = "https://graph.facebook.com/v23.0";

async function graph<T>(path: string, token: string, parameters: Record<string, string>) {
  const url = new URL(`${graphUrl}/${path}`);
  Object.entries({ ...parameters, access_token: token }).forEach(([key, value]) => url.searchParams.set(key, value));
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error("Meta sync request failed.");
  return response.json() as Promise<T>;
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
      let insightMetrics: Record<string, number> = {};
      try {
        const insights = await graph<{ data?: MetaInsight[] }>(`${item.id}/insights`, token, { metric: "views,reach,saved,shares,total_interactions" });
        insightMetrics = Object.fromEntries((insights.data ?? []).flatMap((insight) => insight.name && typeof insight.values?.[0]?.value === "number" ? [[insight.name, insight.values[0].value]] : []));
      } catch {
        insightMetrics = {};
      }
      await db.socialPost.upsert({
        where: { connectionId_externalPostId: { connectionId: connection.id, externalPostId: item.id } },
        create: { connectionId: connection.id, externalPostId: item.id, caption: item.caption, mediaType: item.media_type, mediaUrl: item.media_url, thumbnailUrl: item.thumbnail_url, permalink: item.permalink, publishedAt: new Date(item.timestamp), metrics: { likes: item.like_count ?? 0, comments: item.comments_count ?? 0, ...insightMetrics } },
        update: { caption: item.caption, mediaType: item.media_type, mediaUrl: item.media_url, thumbnailUrl: item.thumbnail_url, permalink: item.permalink, publishedAt: new Date(item.timestamp), metrics: { likes: item.like_count ?? 0, comments: item.comments_count ?? 0, ...insightMetrics } },
      });
      synced += 1;
    }
    await db.socialConnection.update({ where: { id: connection.id }, data: { lastSyncedAt: new Date() } });
  }
  return { connections: connections.length, posts: synced };
}
