import { db } from "@/lib/db";
import { decryptToken } from "@/lib/token-encryption";
import { graph, MetaSyncError } from "@/lib/meta-sync";
import { mediaThumbnailKey, persistMediaThumbnail } from "@/lib/media-storage";
import { getThumbnailBackfillConfig } from "@/lib/env";
import { logError, logEvent } from "@/lib/observability";

/** How many of this connection's posts are still missing a permanently-stored thumbnail. Used both to
 * decide whether to enqueue a THUMBNAIL_BACKFILL job at all, and to decide whether a batch that just
 * ran needs a follow-up continuation job. */
export async function countPendingThumbnails(connectionId: string): Promise<number> {
  return db.socialPost.count({ where: { connectionId, thumbnailStorageKey: null } });
}

export type ThumbnailBackfillResult = { stored: number; skipped: number; remaining: number };

/** Processes a single small, bounded batch of a connection's posts that are still missing a
 * permanently-stored thumbnail (see src/lib/media-storage.ts): refetches a fresh media_url/
 * thumbnail_url from the Meta Graph API (the value already saved may have expired) and persists it.
 *
 * This is the low-priority, resumable counterpart to the one-off `scripts/backfill-media-thumbnails.ts`
 * — it is dispatched as a normal SyncJob (type THUMBNAIL_BACKFILL) by processNextSyncJob, so it
 * automatically inherits that queue's existing Meta app-wide cooldown check (before claiming the job)
 * and retry/backoff handling (on failure) with zero special-casing here. A rate-limit error is simply
 * rethrown so the queue's existing cooldown logic takes over; any other single-post failure is logged
 * and skipped so it never aborts the rest of the batch. */
export async function runThumbnailBackfillChunk(connectionId: string): Promise<ThumbnailBackfillResult> {
  const { batchSize } = getThumbnailBackfillConfig();

  const connection = await db.socialConnection.findUnique({ where: { id: connectionId }, select: { encryptedToken: true } });
  if (!connection) return { stored: 0, skipped: 0, remaining: 0 };

  const posts = await db.socialPost.findMany({
    where: { connectionId, thumbnailStorageKey: null },
    select: { id: true, externalPostId: true, mediaUrl: true, thumbnailUrl: true },
    orderBy: { publishedAt: "desc" },
    take: batchSize,
  });

  logEvent("thumbnail.backfill.batch_started", { connectionId, batchSize: posts.length });

  if (posts.length === 0) {
    logEvent("thumbnail.backfill.batch_completed", { connectionId, stored: 0, skipped: 0, remaining: 0 });
    return { stored: 0, skipped: 0, remaining: 0 };
  }

  const token = decryptToken(connection.encryptedToken);
  let stored = 0;
  let skipped = 0;

  for (const post of posts) {
    let sourceUrl: string | null = post.thumbnailUrl ?? post.mediaUrl;
    try {
      const fresh = await graph<{ media_url?: string; thumbnail_url?: string }>(post.externalPostId, token, { fields: "media_url,thumbnail_url" });
      sourceUrl = fresh.thumbnail_url ?? fresh.media_url ?? sourceUrl;
    } catch (error) {
      if (error instanceof MetaSyncError && error.code === "rate_limited") {
        logEvent("thumbnail.backfill.rate_limited", { connectionId, message: error.message });
        // Bubble up so the caller (processNextSyncJob) applies the shared app-wide cooldown and
        // reschedules this job for after it clears, exactly like any other Instagram job type.
        throw error;
      }
      // A single post's URL could not be refreshed (deleted post, permanent permission error, etc.) —
      // fall back to whatever URL is already stored rather than failing the whole batch over it.
      logEvent("thumbnail.backfill.skipped", { connectionId, externalPostId: post.externalPostId, reason: "refresh_failed", message: error instanceof Error ? error.message : String(error) });
    }

    if (!sourceUrl) {
      skipped++;
      logEvent("thumbnail.backfill.skipped", { connectionId, externalPostId: post.externalPostId, reason: "no_source_url" });
      continue;
    }

    const key = mediaThumbnailKey(connectionId, post.externalPostId);
    const storedKey = await persistMediaThumbnail(sourceUrl, key);
    if (!storedKey) {
      skipped++;
      logEvent("thumbnail.backfill.skipped", { connectionId, externalPostId: post.externalPostId, reason: "persist_failed" });
      continue;
    }

    try {
      await db.socialPost.update({ where: { id: post.id }, data: { thumbnailStorageKey: storedKey } });
      stored++;
      logEvent("thumbnail.backfill.stored", { connectionId, externalPostId: post.externalPostId });
    } catch (error) {
      // Never let a DB hiccup on one row take down the batch (or, transitively, normal Meta sync).
      skipped++;
      logError("thumbnail.backfill.skipped", error, { connectionId, externalPostId: post.externalPostId, reason: "db_update_failed" });
    }
  }

  const remaining = await countPendingThumbnails(connectionId);
  logEvent("thumbnail.backfill.batch_completed", { connectionId, stored, skipped, remaining });
  return { stored, skipped, remaining };
}
