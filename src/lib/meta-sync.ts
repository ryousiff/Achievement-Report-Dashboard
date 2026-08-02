import { Platform } from "@prisma/client";
import { db } from "@/lib/db";
import { decryptToken } from "@/lib/token-encryption";
import { ConnectorError } from "@/lib/connectors/types";

type MetaMedia = { id: string; caption?: string; media_type?: string; media_url?: string; thumbnail_url?: string; permalink?: string; timestamp?: string; like_count?: number; comments_count?: number };
type MetaInsight = { name?: string; values?: Array<{ value?: number; end_time?: string }> };
type MetaErrorResponse = { error?: { code?: number; message?: string; error_subcode?: number } };
type MetricAvailability = Record<string, "returned" | "unavailable" | "unsupported" | "failed">;

const graphUrl = "https://graph.facebook.com/v23.0";
const insightMetrics = ["views", "reach", "saved", "shares", "total_interactions", "follows"] as const;

export class MetaSyncError extends ConnectorError {
  constructor(message: string, readonly metaCode: "rate_limited" | "request_failed", retryAfterMs?: number) { super(message, metaCode, retryAfterMs); }
}

async function graph<T>(path: string, token: string, parameters: Record<string, string>) {
  const url = new URL(`${graphUrl}/${path}`);
  Object.entries({ ...parameters, access_token: token }).forEach(([key, value]) => url.searchParams.set(key, value));
  const response = await fetch(url, { cache: "no-store" });
  if (response.ok) return response.json() as Promise<T>;
  const body = await response.json().catch(() => ({})) as MetaErrorResponse;
  const code = body.error?.code;
  const rateLimited = response.status === 429 || code === 4 || code === 17 || code === 32 || code === 613;
  const retryAfter = Number(response.headers.get("retry-after"));
  throw new MetaSyncError(body.error?.message ?? "Meta sync request failed.", rateLimited ? "rate_limited" : "request_failed", Number.isFinite(retryAfter) ? retryAfter * 1000 : undefined);
}

async function postInsights(postId: string, token: string) {
  const metrics: Record<string, number> = {};
  const availability: MetricAvailability = {};
  for (const metric of insightMetrics) {
    try {
      const insights = await graph<{ data?: MetaInsight[] }>(`${postId}/insights`, token, { metric });
      const insight = insights.data?.[0];
      const value = insight?.values?.[0]?.value;
      if (typeof insight?.name === "string" && typeof value === "number") { metrics[insight.name] = value; availability[metric] = "returned"; }
      else availability[metric] = "unavailable";
    } catch (error) {
      if (error instanceof MetaSyncError && error.code === "rate_limited") throw error;
      availability[metric] = error instanceof MetaSyncError ? "unsupported" : "failed";
    }
  }
  return { metrics, availability };
}

async function syncDailyAccountMetric(connectionId: string, accountId: string, token: string, metric: "follows" | "reach", since: Date) {
  try {
    const insights = await graph<{ data?: MetaInsight[] }>(`${accountId}/insights`, token, { metric, period: "day", since: String(Math.floor(since.valueOf() / 1000)), until: String(Math.floor(Date.now() / 1000)) });
    for (const insight of insights.data ?? []) for (const item of insight.values ?? []) {
      if (typeof item.value !== "number" || !item.end_time) continue;
      const periodEnd = new Date(item.end_time);
      const periodStart = new Date(periodEnd);
      periodStart.setUTCDate(periodStart.getUTCDate() - 1);
      await db.socialInsightSnapshot.upsert({ where: { connectionId_metric_periodStart_periodEnd: { connectionId, metric, periodStart, periodEnd } }, create: { connectionId, metric, periodStart, periodEnd, value: item.value }, update: { value: item.value } });
    }
  } catch (error) { if (error instanceof MetaSyncError && error.code === "rate_limited") throw error; }
}

export async function syncInstagramConnection(connectionId: string) {
  const connection = await db.socialConnection.findUnique({ where: { id: connectionId }, select: { id: true, platform: true, externalAccountId: true, encryptedToken: true, lastSuccessfulSyncAt: true } });
  if (!connection || connection.platform !== Platform.INSTAGRAM) throw new Error("Instagram connection not found.");
  const token = decryptToken(connection.encryptedToken);
  const since = connection.lastSuccessfulSyncAt ? new Date(connection.lastSuccessfulSyncAt.valueOf() - 2 * 24 * 60 * 60 * 1000) : new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  let cursor: string | undefined;
  let pages = 0;
  let posts = 0;
  do {
    const parameters: Record<string, string> = { fields: "id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count", since: String(Math.floor(since.valueOf() / 1000)), limit: "100" };
    if (cursor) parameters.after = cursor;
    const media = await graph<{ data?: MetaMedia[]; paging?: { cursors?: { after?: string } } }>(`${connection.externalAccountId}/media`, token, parameters);
    const existingPosts = await db.socialPost.findMany({ where: { connectionId, externalPostId: { in: (media.data ?? []).map((item) => item.id) } }, select: { externalPostId: true, publishedAt: true, metrics: true, metricAvailability: true } });
    const existingByExternalId = new Map(existingPosts.map((post) => [post.externalPostId, post]));
    for (const item of media.data ?? []) {
      if (!item.timestamp || !item.media_type) continue;
      const existing = existingByExternalId.get(item.id);
      const publishedAt = new Date(item.timestamp);
      const refreshInsights = !existing || publishedAt.valueOf() > Date.now() - 14 * 24 * 60 * 60 * 1000;
      const insights = refreshInsights ? await postInsights(item.id, token) : { metrics: existing.metrics as Record<string, number>, availability: (existing.metricAvailability as MetricAvailability | null) ?? {} };
      const metrics: Record<string, number> = { likes: item.like_count ?? 0, comments: item.comments_count ?? 0, ...insights.metrics };
      const metricAvailability: MetricAvailability = { likes: "returned", comments: "returned", ...insights.availability };
      if (metrics.total_interactions === undefined) {
        metrics.total_interactions = metrics.likes + metrics.comments + (metrics.saved ?? 0) + (metrics.shares ?? 0);
        metricAvailability.total_interactions = metricAvailability.saved === "returned" || metricAvailability.shares === "returned" ? "returned" : "unavailable";
      }
      await db.socialPost.upsert({ where: { connectionId_externalPostId: { connectionId, externalPostId: item.id } }, create: { connectionId, externalPostId: item.id, caption: item.caption, mediaType: item.media_type, mediaUrl: item.media_url, thumbnailUrl: item.thumbnail_url, permalink: item.permalink, publishedAt: new Date(item.timestamp), metrics, metricAvailability }, update: { caption: item.caption, mediaType: item.media_type, mediaUrl: item.media_url, thumbnailUrl: item.thumbnail_url, permalink: item.permalink, publishedAt: new Date(item.timestamp), metrics, metricAvailability } });
      posts += 1;
    }
    cursor = media.paging?.cursors?.after;
    pages += 1;
  } while (cursor && pages < 50);
  await syncDailyAccountMetric(connectionId, connection.externalAccountId, token, "follows", since);
  await syncDailyAccountMetric(connectionId, connection.externalAccountId, token, "reach", since);
  return { posts };
}

export type ConnectionSyncResult = { connectionId: string; displayName: string; status: "success" | "failed"; posts: number; durationMs: number; error?: string };
export type ClientSyncResult = { connections: number; posts: number; joinedExisting: boolean; results: ConnectionSyncResult[] };

export async function syncClientInstagramPosts(clientId: string): Promise<ClientSyncResult> {
  const connections = await db.socialConnection.findMany({ where: { clientId, platform: Platform.INSTAGRAM }, select: { id: true, displayName: true } });
  const results: ConnectionSyncResult[] = [];
  for (const connection of connections) {
    const startedAt = Date.now();
    try { const result = await syncInstagramConnection(connection.id); results.push({ connectionId: connection.id, displayName: connection.displayName, status: "success", posts: result.posts, durationMs: Date.now() - startedAt }); }
    catch (error) { results.push({ connectionId: connection.id, displayName: connection.displayName, status: "failed", posts: 0, durationMs: Date.now() - startedAt, error: error instanceof Error ? error.message : "Unable to synchronize this account." }); }
  }
  return { connections: connections.length, posts: results.reduce((total, result) => total + result.posts, 0), joinedExisting: false, results };
}
