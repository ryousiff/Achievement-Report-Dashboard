import { BackfillStatus, MediaSource, Platform, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { decryptToken } from "@/lib/token-encryption";
import { ConnectorError } from "@/lib/connectors/types";
import { calculateBackfillStart } from "@/lib/backfill-window";
import { getHistoricalBackfillConfig } from "@/lib/env";
import { mediaThumbnailKey, persistMediaThumbnail } from "@/lib/media-storage";
import { persistPostMetricSnapshot } from "@/lib/post-metric-snapshots";
import { logError } from "@/lib/observability";

const { metaSyncMinIntervalMs } = getHistoricalBackfillConfig();
const graphTimeoutMs = 30_000;

type MetaMedia = {
  id: string;
  caption?: string;
  media_type?: string;
  media_url?: string;
  thumbnail_url?: string;
  permalink?: string;
  timestamp?: string;
  like_count?: number;
  comments_count?: number;
  owner?: { id?: string; username?: string };
  collaborators?: { id?: string; username?: string }[];
};

type MetaInsight = { name?: string; values?: Array<{ value?: number; end_time?: string }> };
type MetaErrorResponse = { error?: { code?: number; message?: string; error_subcode?: number; type?: string } };

type MetricAvailability = Record<string, "returned" | "unavailable" | "unsupported" | "failed" | "permission_denied">;

/** Richer per-metric state distinguishing "we don't have it (yet)" from "Meta told us it doesn't exist"
 * from "a real zero." Stored alongside the legacy MetricAvailability strings (which existing report code
 * still reads) rather than replacing them, to avoid a wider blast radius across report-data.ts. */
export type MetricAvailabilityState = "AVAILABLE" | "NOT_SUPPORTED" | "NOT_RETURNED" | "EXPIRED" | "PERMISSION_DENIED" | "PENDING" | "FAILED";

const graphUrl = "https://graph.facebook.com/v23.0";
const mediaFields = "id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count";
const collaborativeMediaFields = `${mediaFields},owner{id,username},collaborators`;
const insightMetrics = ["views", "total_views", "reach", "saved", "shares", "total_interactions", "follows", "facebook_views"] as const;

// Simple, process-wide throttle for the Meta Graph API. `requestQueue` ensures we never issue more than
// one request at a time; `currentIntervalMs` is adjusted based on Meta's X-App-Usage header and on
// rate-limit errors, so the worker backs off as it gets close to the application request limit.
let requestQueue: Promise<unknown> = Promise.resolve();
let lastRequestTime = 0;
let currentIntervalMs = metaSyncMinIntervalMs;

function sleep(ms: number) { return new Promise<void>((resolve) => setTimeout(resolve, ms)); }

function appUsageFrom(headers: Headers): { call_count?: number; total_time?: number; call_cps?: number } | null {
  const raw = headers.get("x-app-usage");
  if (!raw) return null;
  try { return JSON.parse(raw) as { call_count?: number; total_time?: number; call_cps?: number }; } catch { return null; }
}

function adjustInterval(usage: { call_count?: number } | null, rateLimited = false) {
  if (rateLimited) {
    currentIntervalMs = Math.min(2000, currentIntervalMs * 2);
    return;
  }
  if (!usage || usage.call_count === undefined) {
    currentIntervalMs = Math.max(metaSyncMinIntervalMs, currentIntervalMs - 5);
    return;
  }
  const pct = usage.call_count;
  if (pct >= 90) currentIntervalMs = Math.min(2000, Math.max(currentIntervalMs, 1000));
  else if (pct >= 70) currentIntervalMs = Math.min(1000, Math.max(currentIntervalMs, 500));
  else if (pct >= 50) currentIntervalMs = Math.min(500, Math.max(currentIntervalMs, 250));
  else if (pct >= 25) currentIntervalMs = Math.min(250, Math.max(currentIntervalMs, 150));
  else currentIntervalMs = Math.max(metaSyncMinIntervalMs, currentIntervalMs - 10);
}

export class MetaSyncError extends ConnectorError {
  constructor(
    message: string,
    readonly metaCode: "rate_limited" | "request_failed",
    retryAfterMs?: number,
    readonly permanent = false,
    readonly metaErrorCode?: number,
  ) { super(message, metaCode, retryAfterMs); }
}

export async function graph<T>(path: string, token: string, parameters: Record<string, string>) {
  const execute = async () => {
    const url = new URL(`${graphUrl}/${path}`);
    Object.entries({ ...parameters, access_token: token }).forEach(([key, value]) => url.searchParams.set(key, value));

    const now = Date.now();
    const wait = Math.max(0, lastRequestTime + currentIntervalMs - now);
    if (wait > 0) await sleep(wait);

    try {
      const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(graphTimeoutMs) });
      lastRequestTime = Date.now();
      const usage = appUsageFrom(response.headers);
      if (response.ok) {
        adjustInterval(usage, false);
        return response.json() as T;
      }

      const body = await response.json().catch(() => ({})) as MetaErrorResponse;
      const code = body.error?.code;
      const rateLimited = response.status === 429 || code === 4 || code === 17 || code === 32 || code === 613;
      // Permission errors (10, 200s) and "does not exist"/deleted-object errors (100) are not going to succeed on
      // retry — classify them so callers can stop retrying instead of burning through attempts pointlessly.
      const permanent = !rateLimited && (code === 10 || code === 100 || (code !== undefined && code >= 200 && code < 300));
      const retryAfterHeader = Number(response.headers.get("retry-after"));
      let retryAfterMs: number | undefined;
      if (Number.isFinite(retryAfterHeader) && retryAfterHeader > 0) {
        retryAfterMs = Math.max(currentIntervalMs, retryAfterHeader * 1000);
      } else if (rateLimited) {
        // Application request limit (code 4) is app-level and typically needs several minutes to cool down,
        // so default to a longer wait than the per-user transient rate limits.
        const base = code === 4 ? 5 * 60 * 1000 : 60_000;
        retryAfterMs = Math.max(base, currentIntervalMs * 10);
      }
      adjustInterval(usage, rateLimited);
      throw new MetaSyncError(
        body.error?.message ?? "Meta sync request failed.",
        rateLimited ? "rate_limited" : "request_failed",
        retryAfterMs,
        permanent,
        code,
      );
    } catch (error) {
      if (error instanceof MetaSyncError) throw error;
      // Network/timeouts from fetch itself should be retried, not treated as permanent failures.
      throw new MetaSyncError(
        error instanceof Error ? error.message : "Meta sync request failed.",
        "request_failed",
        30_000,
      );
    }
  };

  const next = requestQueue.then(execute);
  requestQueue = next.catch(() => undefined);
  return next;
}

function availabilityState(availability: MetricAvailability[string]): MetricAvailabilityState {
  switch (availability) {
    case "returned": return "AVAILABLE";
    case "unavailable": return "NOT_RETURNED";
    case "unsupported": return "NOT_SUPPORTED";
    case "permission_denied": return "PERMISSION_DENIED";
    case "failed": return "FAILED";
    default: return "PENDING";
  }
}

type InsightBatch = { metrics: Record<string, number>; availability: MetricAvailability };

async function fetchInsightBatch(postId: string, token: string, metrics: string[]): Promise<InsightBatch> {
  const joined = metrics.join(",");
  try {
    const insights = await graph<{ data?: MetaInsight[] }>(`${postId}/insights`, token, { metric: joined });
    const result: InsightBatch = { metrics: {}, availability: {} };
    for (const insight of insights.data ?? []) {
      const value = insight.values?.[0]?.value;
      if (typeof insight.name === "string" && typeof value === "number") {
        result.metrics[insight.name] = value;
        result.availability[insight.name] = "returned";
      }
    }
    for (const metric of metrics) {
      if (!(metric in result.availability)) result.availability[metric] = "unavailable";
    }
    return result;
  } catch (error) {
    if (error instanceof MetaSyncError && error.code === "rate_limited") throw error;
    if (error instanceof MetaSyncError && error.permanent) {
      const code = error.metaErrorCode;
      const state = code === 10 || (code !== undefined && code >= 200 && code < 300) ? "permission_denied" as const : code === 100 ? "unsupported" as const : "failed" as const;
      return { metrics: {}, availability: Object.fromEntries(metrics.map((metric) => [metric, state])) as MetricAvailability };
    }
    return { metrics: {}, availability: Object.fromEntries(metrics.map((metric) => [metric, "failed" as const])) as MetricAvailability };
  }
}

async function postInsights(postId: string, token: string) {
  const results = await Promise.allSettled([
    fetchInsightBatch(postId, token, ["views", "total_views", "reach", "saved", "shares", "total_interactions"]),
    fetchInsightBatch(postId, token, ["follows"]),
    fetchInsightBatch(postId, token, ["facebook_views"]),
  ]);
  if (results[0].status === "rejected") throw results[0].reason;
  if (results[1].status === "rejected") throw results[1].reason;
  // facebook_views is optional and may be unsupported for some media product types; never let a transient
  // rate-limit on the optional metric be silently swallowed.
  if (results[2].status === "rejected" && results[2].reason instanceof MetaSyncError && results[2].reason.code === "rate_limited") throw results[2].reason;
  const core = results[0].value;
  const follows = results[1].value;
  const facebookViews = results[2].status === "fulfilled" ? results[2].value : { metrics: {}, availability: { facebook_views: "unavailable" as const } };
  const metrics = { ...core.metrics, ...follows.metrics, ...facebookViews.metrics };
  const availability = { ...core.availability, ...follows.availability, ...facebookViews.availability };
  return { metrics, availability };
}

function buildPostRecord(item: MetaMedia, insights: { metrics: Record<string, number>; availability: MetricAvailability }) {
  const metrics: Record<string, number> = {};
  const metricAvailability: MetricAvailability = {};
  if (typeof item.like_count === "number") {
    metrics.likes = item.like_count;
    metricAvailability.likes = "returned";
  }
  if (typeof item.comments_count === "number") {
    metrics.comments = item.comments_count;
    metricAvailability.comments = "returned";
  }
  Object.assign(metrics, insights.metrics);
  Object.assign(metricAvailability, insights.availability);
  const metricAvailabilityState = Object.fromEntries(Object.entries(metricAvailability).map(([key, value]) => [key, availabilityState(value)]));
  return { metrics, metricAvailability, metricAvailabilityState };
}

function extractMediaMetadata(item: MetaMedia, source: MediaSource): Record<string, unknown> | null {
  if (source !== MediaSource.COLLABORATIVE) return null;
  const metadata: Record<string, unknown> = {};
  if (item.owner) {
    metadata.originalOwnerId = item.owner.id;
    metadata.originalOwnerUsername = item.owner.username;
  }
  if (item.collaborators && item.collaborators.length > 0) {
    metadata.collaborators = item.collaborators;
  }
  return Object.keys(metadata).length > 0 ? metadata : null;
}

async function upsertPost(
  connectionId: string,
  item: MetaMedia,
  insights: { metrics: Record<string, number>; availability: MetricAvailability },
  source: MediaSource = MediaSource.OWNED,
  mediaMetadata: Record<string, unknown> | null = null,
) {
  const { metrics, metricAvailability, metricAvailabilityState } = buildPostRecord(item, insights);
  const publishedAt = new Date(item.timestamp!);

  // Post/metric persistence must not wait on thumbnail caching (a remote image download + MinIO
  // upload) — it never touches thumbnailStorageKey here, on either create or update, so an existing
  // cached thumbnail is never at risk of being cleared. Caching happens afterwards, in the background
  // (see below); the existing THUMBNAIL_BACKFILL job remains the safety net for any post that ends up
  // still missing a thumbnail (failed attempt, or the process exiting before it finished).
  const baseUpdate = {
    caption: item.caption,
    mediaType: item.media_type!,
    mediaUrl: item.media_url,
    thumbnailUrl: item.thumbnail_url,
    permalink: item.permalink,
    publishedAt,
    metrics,
    metricAvailability,
    metricAvailabilityState,
    lastInsightRefreshAt: new Date(),
  };
  const record = await db.socialPost.upsert({
    where: { connectionId_externalPostId: { connectionId, externalPostId: item.id } },
    create: {
      ...baseUpdate,
      connectionId,
      externalPostId: item.id,
      mediaSource: source,
      mediaMetadata: mediaMetadata ? mediaMetadata as Prisma.InputJsonValue : undefined,
    },
    update: {
      ...baseUpdate,
      // Never downgrade an OWNED record to COLLABORATIVE if it is encountered through another API path,
      // but do allow an upgrade from COLLABORATIVE to OWNED when the account is confirmed as the owner.
      mediaSource: source === MediaSource.OWNED ? MediaSource.OWNED : undefined,
      // Only update mediaMetadata for owned sources; a collaborative re-encounter should not replace an
      // existing owned record's (empty) metadata, and an owned re-encounter carries no new metadata.
      mediaMetadata: source === MediaSource.OWNED ? (mediaMetadata ? mediaMetadata as Prisma.InputJsonValue : undefined) : undefined,
    },
  });

  // Persist our own permanent copy of the display image, since Meta's media_url/thumbnail_url are
  // short-lived signed CDN URLs. Skipped entirely once a thumbnail is already cached for this post —
  // a post's image never changes after publish, so re-downloading and re-uploading the same bytes on
  // every subsequent incremental sync / recent-insight refresh would be pure waste; the existing
  // thumbnailStorageKey is reused instead (THUMBNAIL_BACKFILL remains the catch-up path for posts that
  // still have none). Fire-and-forget: never awaited, so it cannot slow down sync, and any failure here
  // is silently caught (logged) rather than surfaced — only successful persists ever write the key.
  const displaySourceUrl = item.thumbnail_url ?? item.media_url;
  if (displaySourceUrl && !record.thumbnailStorageKey) {
    void persistMediaThumbnail(displaySourceUrl, mediaThumbnailKey(connectionId, item.id))
      .then((thumbnailStorageKey) => {
        if (!thumbnailStorageKey) return undefined;
        return db.socialPost.update({ where: { id: record.id }, data: { thumbnailStorageKey } });
      })
      .catch((error) => logError("media.thumbnail.persist_failed", error, { connectionId, externalPostId: item.id }));
  }

  // Best-effort: capture/advance the immutable per-month historical snapshot for this post. Never
  // lets a snapshot-persistence failure break the primary sync (see post-metric-snapshots.ts).
  try {
    await persistPostMetricSnapshot(record.id, publishedAt, metrics);
  } catch (error) {
    logError("post_metric_snapshot.persist_failed", error, { connectionId, externalPostId: item.id });
  }
}

function connectionSelect() {
  return {
    id: true,
    platform: true,
    externalAccountId: true,
    encryptedToken: true,
    lastSuccessfulSyncAt: true,
    lastIncrementalSyncAt: true,
    historicalBackfillStatus: true,
    historicalBackfillStart: true,
    historicalBackfillCursor: true,
    historicalBackfillPageIndex: true,
    historicalBackfillStartedAt: true,
    historicalBackfillCompletedAt: true,
    historicalBackfillRetryCount: true,
    historicalBackfillProcessedPosts: true,
    collaborativeBackfillStatus: true,
    collaborativeBackfillStart: true,
    collaborativeBackfillCursor: true,
    collaborativeBackfillPageIndex: true,
    collaborativeBackfillStartedAt: true,
    collaborativeBackfillCompletedAt: true,
    collaborativeBackfillRetryCount: true,
    collaborativeBackfillProcessedPosts: true,
  } as const;
}

type InstagramConnection = Awaited<ReturnType<typeof requireInstagramConnection>>;

async function requireInstagramConnection(connectionId: string) {
  const connection = await db.socialConnection.findUnique({ where: { id: connectionId }, select: connectionSelect() });
  if (!connection || connection.platform !== Platform.INSTAGRAM) throw new Error("Instagram connection not found.");
  return connection;
}

type MediaPage = { data?: MetaMedia[]; paging?: { cursors?: { after?: string } } };

async function fetchMediaPage(
  accountId: string,
  token: string,
  endpoint: "media" | "collaborative_media",
  cursor: string | undefined,
  since: Date,
  fields: string,
  limit: string,
): Promise<MediaPage> {
  const parameters: Record<string, string> = { fields, since: String(Math.floor(since.valueOf() / 1000)), limit };
  if (cursor) parameters.after = cursor;
  return graph<MediaPage>(`${accountId}/${endpoint}`, token, parameters);
}

async function processMediaItem(connectionId: string, token: string, item: MetaMedia, source: MediaSource) {
  if (!item.timestamp || !item.media_type) return 0;
  const insights = await postInsights(item.id, token);
  await upsertPost(connectionId, item, insights, source, extractMediaMetadata(item, source));
  return 1;
}

/** Fast, small, "what's new since last time" sync — this is what runs continuously, including while a
 * historical backfill for the same connection may also be in progress (separate cursor, separate state).
 *
 * It now fetches both owned media and accepted collaborative media. Collaborative media is reconciled
 * over a wider window than owned media because a collaboration can be accepted long after the original
 * post was published. */
export async function runIncrementalSync(connectionId: string) {
  const connection = await requireInstagramConnection(connectionId);
  const token = decryptToken(connection.encryptedToken);
  const config = getHistoricalBackfillConfig();

  const anchor = connection.lastIncrementalSyncAt ?? connection.lastSuccessfulSyncAt;
  const ownedSince = anchor ? new Date(anchor.valueOf() - 2 * 24 * 60 * 60 * 1000) : new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
  const collabWindowDays = Math.max(14, config.collaborativeReconciliationDays);
  const collabSince = anchor ? new Date(anchor.valueOf() - collabWindowDays * 24 * 60 * 60 * 1000) : new Date(Date.now() - collabWindowDays * 24 * 60 * 60 * 1000);

  let posts = 0;

  // Owned media — keep a tight cap because we run this frequently.
  let ownedCursor: string | undefined;
  let ownedPages = 0;
  const maxOwnedPages = 5;
  do {
    const media = await fetchMediaPage(connection.externalAccountId, token, "media", ownedCursor, ownedSince, mediaFields, "25");
    for (const item of media.data ?? []) posts += await processMediaItem(connectionId, token, item, MediaSource.OWNED);
    ownedCursor = media.paging?.cursors?.after;
    ownedPages += 1;
  } while (ownedCursor && ownedPages < maxOwnedPages);

  // Accepted collaborative media — narrower pages and fewer of them per incremental run to avoid
  // burning through Meta's application call budget; historical backfill will catch older posts.
  let collabCursor: string | undefined;
  let collabPages = 0;
  const maxCollabPages = 3;
  do {
    const media = await fetchMediaPage(connection.externalAccountId, token, "collaborative_media", collabCursor, collabSince, collaborativeMediaFields, "25");
    for (const item of media.data ?? []) posts += await processMediaItem(connectionId, token, item, MediaSource.COLLABORATIVE);
    collabCursor = media.paging?.cursors?.after;
    collabPages += 1;
  } while (collabCursor && collabPages < maxCollabPages);

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
    const storedMetrics = (post.metrics ?? {}) as Record<string, number>;
    const insights = await postInsights(post.externalPostId, token);
    const metadata = post.mediaMetadata ? (post.mediaMetadata as Record<string, unknown>) : null;
    await upsertPost(
      connectionId,
      {
        id: post.externalPostId,
        caption: post.caption ?? undefined,
        media_type: post.mediaType,
        media_url: post.mediaUrl ?? undefined,
        thumbnail_url: post.thumbnailUrl ?? undefined,
        permalink: post.permalink ?? undefined,
        timestamp: post.publishedAt.toISOString(),
        like_count: storedMetrics.likes,
        comments_count: storedMetrics.comments,
      },
      insights,
      post.mediaSource,
      metadata,
    );
    refreshed += 1;
  }
  return { posts: refreshed };
}

type HistoricalSourceConfig = {
  endpoint: "media" | "collaborative_media";
  fields: string;
  status: string;
  start: string;
  cursor: string;
  pageIndex: string;
  startedAt: string;
  completedAt: string;
  processedPosts: string;
  lastError: string;
};

const HISTORICAL_SOURCE_CONFIG: Record<MediaSource, HistoricalSourceConfig> = {
  [MediaSource.OWNED]: {
    endpoint: "media",
    fields: mediaFields,
    status: "historicalBackfillStatus",
    start: "historicalBackfillStart",
    cursor: "historicalBackfillCursor",
    pageIndex: "historicalBackfillPageIndex",
    startedAt: "historicalBackfillStartedAt",
    completedAt: "historicalBackfillCompletedAt",
    processedPosts: "historicalBackfillProcessedPosts",
    lastError: "historicalBackfillLastError",
  },
  [MediaSource.COLLABORATIVE]: {
    endpoint: "collaborative_media",
    fields: collaborativeMediaFields,
    status: "collaborativeBackfillStatus",
    start: "collaborativeBackfillStart",
    cursor: "collaborativeBackfillCursor",
    pageIndex: "collaborativeBackfillPageIndex",
    startedAt: "collaborativeBackfillStartedAt",
    completedAt: "collaborativeBackfillCompletedAt",
    processedPosts: "collaborativeBackfillProcessedPosts",
    lastError: "collaborativeBackfillLastError",
  },
};

function readHistoricalState(connection: InstagramConnection, source: MediaSource) {
  const config = HISTORICAL_SOURCE_CONFIG[source];
  const record = connection as unknown as Record<string, unknown>;
  return {
    status: record[config.status] as BackfillStatus,
    start: record[config.start] as Date | null,
    cursor: record[config.cursor] as string | null,
    pageIndex: (record[config.pageIndex] as number | null) ?? 0,
  };
}

/** One bounded, resumable unit of the historical backfill for a single media source. Never advances the
 * Meta pagination cursor past a page until every item on that page has been successfully processed — so a
 * mid-page failure (e.g. item 81 of 100) can only ever be retried, never silently skip the remaining items. */
async function runHistoricalBackfillForSource(connectionId: string, source: MediaSource) {
  const connection = await requireInstagramConnection(connectionId);
  const token = decryptToken(connection.encryptedToken);
  const config = getHistoricalBackfillConfig();
  const sourceConfig = HISTORICAL_SOURCE_CONFIG[source];

  const state = readHistoricalState(connection, source);
  const start = state.start ?? calculateBackfillStart(new Date(), config.months);

  if (state.status === BackfillStatus.NOT_STARTED) {
    await db.socialConnection.update({
      where: { id: connectionId },
      data: {
        [sourceConfig.status]: BackfillStatus.RUNNING,
        [sourceConfig.start]: start,
        [sourceConfig.startedAt]: new Date(),
        [sourceConfig.cursor]: null,
        [sourceConfig.pageIndex]: 0,
        [sourceConfig.lastError]: null,
      } as any,
    });
  }

  let cursor: string | undefined = state.cursor ?? undefined;
  let pageIndex = state.pageIndex;
  let processedThisRun = 0;
  let apiCalls = 0;
  const startedAt = Date.now();
  const budgetExceeded = () => processedThisRun >= config.postsPerRun || apiCalls >= config.apiCallBudget || Date.now() - startedAt >= config.maxRuntimeMs;

  while (!budgetExceeded()) {
    const media = await fetchMediaPage(connection.externalAccountId, token, sourceConfig.endpoint, cursor, start, sourceConfig.fields, "100");
    apiCalls += 1;
    const items = media.data ?? [];

    let index = pageIndex;
    while (index < items.length && !budgetExceeded()) {
      const item = items[index];
      if (item.timestamp && item.media_type) {
        const insights = await postInsights(item.id, token);
        apiCalls += Object.keys(insights.availability).length;
        await upsertPost(connectionId, item, insights, source, extractMediaMetadata(item, source));
        processedThisRun += 1;
      }
      index += 1;
      pageIndex = index; // only advances after the item at (index-1) is fully persisted
      await db.socialConnection.update({
        where: { id: connectionId },
        data: { [sourceConfig.pageIndex]: pageIndex, [sourceConfig.processedPosts]: { increment: 1 } } as any,
      });
    }

    if (index < items.length) break; // budget hit mid-page: cursor stays put, pageIndex marks where to resume

    const nextCursor = media.paging?.cursors?.after;
    if (!nextCursor || items.length === 0) {
      await db.socialConnection.update({
        where: { id: connectionId },
        data: {
          [sourceConfig.status]: BackfillStatus.COMPLETED,
          [sourceConfig.completedAt]: new Date(),
          [sourceConfig.cursor]: null,
          [sourceConfig.pageIndex]: 0,
          [sourceConfig.lastError]: null,
          lastSuccessfulSyncAt: new Date(),
          lastSyncedAt: new Date(),
        } as any,
      });
      return { posts: processedThisRun, completed: true };
    }

    cursor = nextCursor;
    pageIndex = 0;
    await db.socialConnection.update({
      where: { id: connectionId },
      data: { [sourceConfig.cursor]: cursor, [sourceConfig.pageIndex]: 0 } as any,
    });
  }

  // Budget reached before finishing pagination: persist as PARTIAL and let the caller re-enqueue a continuation.
  await db.socialConnection.update({
    where: { id: connectionId },
    data: {
      [sourceConfig.status]: BackfillStatus.PARTIAL,
      [sourceConfig.cursor]: cursor ?? null,
      [sourceConfig.pageIndex]: pageIndex,
      [sourceConfig.lastError]: null,
      lastSuccessfulSyncAt: new Date(),
      lastSyncedAt: new Date(),
    } as any,
  });
  return { posts: processedThisRun, completed: false };
}

export async function runHistoricalBackfillChunk(connectionId: string) {
  return runHistoricalBackfillForSource(connectionId, MediaSource.OWNED);
}

export async function runHistoricalCollaborativeBackfillChunk(connectionId: string) {
  return runHistoricalBackfillForSource(connectionId, MediaSource.COLLABORATIVE);
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
