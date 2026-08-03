import { BackfillStatus, Platform } from "@prisma/client";
import { db } from "@/lib/db";
import { decryptToken } from "@/lib/token-encryption";
import { ConnectorError } from "@/lib/connectors/types";
import { calculateBackfillStart } from "@/lib/backfill-window";
import { getHistoricalBackfillConfig } from "@/lib/env";

type MetaMedia = { id: string; caption?: string; media_type?: string; media_url?: string; thumbnail_url?: string; permalink?: string; timestamp?: string; like_count?: number; comments_count?: number };
type MetaInsight = { name?: string; values?: Array<{ value?: number; end_time?: string }> };
type MetaErrorResponse = { error?: { code?: number; message?: string; error_subcode?: number; type?: string } };
type MetricAvailability = Record<string, "returned" | "unavailable" | "unsupported" | "failed">;
/** Richer per-metric state distinguishing "we don't have it (yet)" from "Meta told us it doesn't exist"
 * from "a real zero." Stored alongside the legacy MetricAvailability strings (which existing report code
 * still reads) rather than replacing them, to avoid a wider blast radius across report-data.ts. */
export type MetricAvailabilityState = "AVAILABLE" | "NOT_SUPPORTED" | "NOT_RETURNED" | "EXPIRED" | "PERMISSION_DENIED" | "PENDING" | "FAILED";

const graphUrl = "https://graph.facebook.com/v23.0";
const insightMetrics = ["views", "reach", "saved", "shares", "total_interactions", "follows"] as const;

export class MetaSyncError extends ConnectorError {
  constructor(message: string, readonly metaCode: "rate_limited" | "request_failed", retryAfterMs?: number, readonly permanent = false) { super(message, metaCode, retryAfterMs); }
}

async function graph<T>(path: string, token: string, parameters: Record<string, string>) {
  const url = new URL(`${graphUrl}/${path}`);
  Object.entries({ ...parameters, access_token: token }).forEach(([key, value]) => url.searchParams.set(key, value));
  const response = await fetch(url, { cache: "no-store" });
  if (response.ok) return response.json() as Promise<T>;
  const body = await response.json().catch(() => ({})) as MetaErrorResponse;
  const code = body.error?.code;
  const rateLimited = response.status === 429 || code === 4 || code === 17 || code === 32 || code === 613;
  // Permission errors (10, 200s) and "does not exist"/deleted-object errors (100) are not going to succeed on
  // retry — classify them so callers can stop retrying instead of burning through attempts pointlessly.
  const permanent = !rateLimited && (code === 10 || code === 100 || (code !== undefined && code >= 200 && code < 300));
  const retryAfter = Number(response.headers.get("retry-after"));
  throw new MetaSyncError(body.error?.message ?? "Meta sync request failed.", rateLimited ? "rate_limited" : "request_failed", Number.isFinite(retryAfter) ? retryAfter * 1000 : undefined, permanent);
}

function availabilityState(availability: MetricAvailability[string]): MetricAvailabilityState {
  switch (availability) {
    case "returned": return "AVAILABLE";
    case "unavailable": return "NOT_RETURNED";
    case "unsupported": return "NOT_SUPPORTED";
    case "failed": return "FAILED";
    default: return "PENDING";
  }
}

async function postInsights(postId: string, token: string) {
  const metrics: Record<string, number> = {};
  const availability: MetricAvailability = {};
  const results = await Promise.allSettled(insightMetrics.map(async (metric) => {
    try {
      const insights = await graph<{ data?: MetaInsight[] }>(`${postId}/insights`, token, { metric });
      const insight = insights.data?.[0];
      const value = insight?.values?.[0]?.value;
      if (typeof insight?.name === "string" && typeof value === "number") return { metric, name: insight.name, value, availability: "returned" as const };
      return { metric, availability: "unavailable" as const };
    } catch (error) {
      if (error instanceof MetaSyncError && error.code === "rate_limited") throw error;
      return { metric, availability: error instanceof MetaSyncError ? "unsupported" as const : "failed" as const };
    }
  }));
  for (const result of results) {
    if (result.status === "rejected") throw result.reason;
    const { metric, name, value, availability: metricAvailability } = result.value;
    if (typeof name === "string" && typeof value === "number") metrics[name] = value;
    availability[metric] = metricAvailability;
  }
  return { metrics, availability };
}

function buildPostRecord(item: MetaMedia, insights: { metrics: Record<string, number>; availability: MetricAvailability }) {
  const metrics: Record<string, number> = { likes: item.like_count ?? 0, comments: item.comments_count ?? 0, ...insights.metrics };
  const metricAvailability: MetricAvailability = { likes: "returned", comments: "returned", ...insights.availability };
  if (metrics.total_interactions === undefined) {
    metrics.total_interactions = metrics.likes + metrics.comments + (metrics.saved ?? 0) + (metrics.shares ?? 0);
    metricAvailability.total_interactions = metricAvailability.saved === "returned" || metricAvailability.shares === "returned" ? "returned" : "unavailable";
  }
  const metricAvailabilityState = Object.fromEntries(Object.entries(metricAvailability).map(([key, value]) => [key, availabilityState(value)]));
  return { metrics, metricAvailability, metricAvailabilityState };
}

async function upsertPost(connectionId: string, item: MetaMedia, insights: { metrics: Record<string, number>; availability: MetricAvailability }) {
  const { metrics, metricAvailability, metricAvailabilityState } = buildPostRecord(item, insights);
  const publishedAt = new Date(item.timestamp!);
  await db.socialPost.upsert({
    where: { connectionId_externalPostId: { connectionId, externalPostId: item.id } },
    create: { connectionId, externalPostId: item.id, caption: item.caption, mediaType: item.media_type!, mediaUrl: item.media_url, thumbnailUrl: item.thumbnail_url, permalink: item.permalink, publishedAt, metrics, metricAvailability, metricAvailabilityState, lastInsightRefreshAt: new Date() },
    update: { caption: item.caption, mediaType: item.media_type!, mediaUrl: item.media_url, thumbnailUrl: item.thumbnail_url, permalink: item.permalink, publishedAt, metrics, metricAvailability, metricAvailabilityState, lastInsightRefreshAt: new Date() },
  });
}

function connectionSelect() {
  return { id: true, platform: true, externalAccountId: true, encryptedToken: true, lastSuccessfulSyncAt: true, lastIncrementalSyncAt: true, historicalBackfillStatus: true, historicalBackfillStart: true, historicalBackfillCursor: true, historicalBackfillPageIndex: true, historicalBackfillRetryCount: true, historicalBackfillProcessedPosts: true } as const;
}

async function requireInstagramConnection(connectionId: string) {
  const connection = await db.socialConnection.findUnique({ where: { id: connectionId }, select: connectionSelect() });
  if (!connection || connection.platform !== Platform.INSTAGRAM) throw new Error("Instagram connection not found.");
  return connection;
}

/** Fast, small, "what's new since last time" sync — this is what runs continuously, including while a
 * historical backfill for the same connection may also be in progress (separate cursor, separate state). */
export async function runIncrementalSync(connectionId: string) {
  const connection = await requireInstagramConnection(connectionId);
  const token = decryptToken(connection.encryptedToken);
  const anchor = connection.lastIncrementalSyncAt ?? connection.lastSuccessfulSyncAt;
  const since = anchor ? new Date(anchor.valueOf() - 2 * 24 * 60 * 60 * 1000) : new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
  let cursor: string | undefined;
  let pages = 0;
  let posts = 0;
  const maxPages = 10; // incremental sync only needs to catch up on recent activity, not paginate deep
  do {
    const parameters: Record<string, string> = { fields: "id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count", since: String(Math.floor(since.valueOf() / 1000)), limit: "50" };
    if (cursor) parameters.after = cursor;
    const media = await graph<{ data?: MetaMedia[]; paging?: { cursors?: { after?: string } } }>(`${connection.externalAccountId}/media`, token, parameters);
    for (const item of media.data ?? []) {
      if (!item.timestamp || !item.media_type) continue;
      const insights = await postInsights(item.id, token);
      await upsertPost(connectionId, item, insights);
      posts += 1;
    }
    cursor = media.paging?.cursors?.after;
    pages += 1;
  } while (cursor && pages < maxPages);

  const now = new Date();
  await db.socialConnection.update({ where: { id: connectionId }, data: { lastIncrementalSyncAt: now, lastIncrementalSyncError: null } });
  return { posts };
}

/** Refreshes insights for already-stored posts published within the configured recent window — engagement
 * on older posts keeps changing after publication, and incremental sync above only *discovers* new posts. */
export async function runRecentInsightRefresh(connectionId: string) {
  const connection = await requireInstagramConnection(connectionId);
  const token = decryptToken(connection.encryptedToken);
  const { recentPostRefreshDays, historicalBackfillPostsPerRun } = { ...getHistoricalBackfillConfig(), historicalBackfillPostsPerRun: getHistoricalBackfillConfig().postsPerRun };
  const since = new Date(Date.now() - recentPostRefreshDays * 24 * 60 * 60 * 1000);
  const staleBefore = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const posts = await db.socialPost.findMany({
    where: { connectionId, publishedAt: { gte: since }, OR: [{ lastInsightRefreshAt: null }, { lastInsightRefreshAt: { lt: staleBefore } }] },
    orderBy: { publishedAt: "desc" },
    take: historicalBackfillPostsPerRun,
  });
  let refreshed = 0;
  for (const post of posts) {
    const insights = await postInsights(post.externalPostId, token);
    await upsertPost(connectionId, { id: post.externalPostId, caption: post.caption ?? undefined, media_type: post.mediaType, media_url: post.mediaUrl ?? undefined, thumbnail_url: post.thumbnailUrl ?? undefined, permalink: post.permalink ?? undefined, timestamp: post.publishedAt.toISOString() }, insights);
    refreshed += 1;
  }
  return { posts: refreshed };
}

/** One bounded, resumable unit of the historical backfill. Never advances the Meta pagination cursor past
 * a page until every item on that page has been successfully processed (see module docstring in
 * backfill-window.ts and the historicalBackfillPageIndex field on SocialConnection) — so a mid-page failure
 * (e.g. item 81 of 100) can only ever be retried, never silently skip the remaining items. */
export async function runHistoricalBackfillChunk(connectionId: string) {
  const connection = await requireInstagramConnection(connectionId);
  const token = decryptToken(connection.encryptedToken);
  const config = getHistoricalBackfillConfig();

  const start = connection.historicalBackfillStart ?? calculateBackfillStart(new Date(), config.months);
  if (connection.historicalBackfillStatus === BackfillStatus.NOT_STARTED) {
    await db.socialConnection.update({ where: { id: connectionId }, data: { historicalBackfillStatus: BackfillStatus.RUNNING, historicalBackfillStart: start, historicalBackfillStartedAt: new Date(), historicalBackfillCursor: null, historicalBackfillPageIndex: 0 } });
  }

  let cursor = connection.historicalBackfillCursor ?? undefined;
  let pageIndex = connection.historicalBackfillPageIndex ?? 0;
  let processedThisRun = 0;
  let apiCalls = 0;
  const startedAt = Date.now();
  const budgetExceeded = () => processedThisRun >= config.postsPerRun || apiCalls >= config.apiCallBudget || Date.now() - startedAt >= config.maxRuntimeMs;

  while (!budgetExceeded()) {
    const parameters: Record<string, string> = { fields: "id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count", since: String(Math.floor(start.valueOf() / 1000)), limit: "100" };
    if (cursor) parameters.after = cursor;
    const media = await graph<{ data?: MetaMedia[]; paging?: { cursors?: { after?: string } } }>(`${connection.externalAccountId}/media`, token, parameters);
    apiCalls += 1;
    const items = media.data ?? [];

    let index = pageIndex;
    while (index < items.length && !budgetExceeded()) {
      const item = items[index];
      if (item.timestamp && item.media_type) {
        const insights = await postInsights(item.id, token);
        apiCalls += Object.keys(insights.availability).length;
        await upsertPost(connectionId, item, insights);
        processedThisRun += 1;
      }
      index += 1;
      pageIndex = index; // only advances after the item at (index-1) is fully persisted
      await db.socialConnection.update({ where: { id: connectionId }, data: { historicalBackfillPageIndex: pageIndex, historicalBackfillProcessedPosts: { increment: 1 } } });
    }

    if (index < items.length) break; // budget hit mid-page: cursor stays put, pageIndex marks where to resume

    const nextCursor = media.paging?.cursors?.after;
    if (!nextCursor || items.length === 0) {
      await db.socialConnection.update({ where: { id: connectionId }, data: { historicalBackfillStatus: BackfillStatus.COMPLETED, historicalBackfillCompletedAt: new Date(), historicalBackfillCursor: null, historicalBackfillPageIndex: 0, lastSuccessfulSyncAt: new Date(), lastSyncedAt: new Date() } });
      return { posts: processedThisRun, completed: true };
    }

    cursor = nextCursor;
    pageIndex = 0;
    await db.socialConnection.update({ where: { id: connectionId }, data: { historicalBackfillCursor: cursor, historicalBackfillPageIndex: 0 } });
  }

  // Budget reached before finishing pagination: persist as PARTIAL and let the caller re-enqueue a continuation.
  await db.socialConnection.update({ where: { id: connectionId }, data: { historicalBackfillStatus: BackfillStatus.PARTIAL, historicalBackfillCursor: cursor ?? null, historicalBackfillPageIndex: pageIndex, lastSuccessfulSyncAt: new Date(), lastSyncedAt: new Date() } });
  return { posts: processedThisRun, completed: false };
}

export type ConnectionSyncResult = { connectionId: string; displayName: string; status: "success" | "failed"; posts: number; durationMs: number; error?: string };
export type ClientSyncResult = { connections: number; posts: number; joinedExisting: boolean; results: ConnectionSyncResult[] };

/** Legacy entry point kept for anything still calling the old "just sync everything" API (e.g. the
 * synchronous manual sync used by the media library preview) — now dispatches to incremental sync only;
 * the historical backfill is a separate, admin-triggered, queued job (see enqueueHistoricalBackfill). */
export async function syncClientInstagramPosts(clientId: string): Promise<ClientSyncResult> {
  const connections = await db.socialConnection.findMany({ where: { clientId, platform: Platform.INSTAGRAM }, select: { id: true, displayName: true } });
  const results: ConnectionSyncResult[] = [];
  for (const connection of connections) {
    const startedAt = Date.now();
    try { const result = await runIncrementalSync(connection.id); results.push({ connectionId: connection.id, displayName: connection.displayName, status: "success", posts: result.posts, durationMs: Date.now() - startedAt }); }
    catch (error) { results.push({ connectionId: connection.id, displayName: connection.displayName, status: "failed", posts: 0, durationMs: Date.now() - startedAt, error: error instanceof Error ? error.message : "Unable to synchronize this account." }); }
  }
  return { connections: connections.length, posts: results.reduce((total, result) => total + result.posts, 0), joinedExisting: false, results };
}
