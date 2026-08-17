/** One-off/rerunnable backfill: persists a permanent copy of each already-synced post's display image
 * into MinIO (see src/lib/media-storage.ts), so report thumbnails stop breaking once Instagram's
 * short-lived signed media_url/thumbnail_url expire.
 *
 * Since posts synced a while ago may already have expired URLs stored in the database, this refetches
 * a fresh media_url/thumbnail_url from the Meta Graph API for each post before downloading it. Every
 * refetch competes with the worker for Meta's app-level request budget, so this script shares the same
 * application-wide cooldown the worker uses (src/lib/sync-queue.ts): it refuses to start while a
 * cooldown is active, and if Meta returns "(#4) Application request limit reached" mid-run, it
 * activates that same cooldown and stops immediately instead of burning through more posts/retries.
 * Safe to rerun any time — already-stored posts (thumbnailStorageKey set) are always skipped, so a run
 * that stops early just picks up where it left off next time.
 *
 * Usage:
 *   npx tsx scripts/backfill-media-thumbnails.ts
 *   npx tsx scripts/backfill-media-thumbnails.ts --clients="جمعية الإصلاح,سكن"
 *   npx tsx scripts/backfill-media-thumbnails.ts --clients="جمعية الإصلاح" --limit=10
 *   npx tsx scripts/backfill-media-thumbnails.ts --limit=200
 */
import { db } from "@/lib/db";
import { decryptToken } from "@/lib/token-encryption";
import { graph, MetaSyncError } from "@/lib/meta-sync";
import { mediaThumbnailKey, persistMediaThumbnail } from "@/lib/media-storage";
import { getMetaAppCooldownUntil, isMetaAppCooldownActive, setMetaAppCooldownUntil } from "@/lib/sync-queue";

function parseArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg?.slice(prefix.length);
}

function clientMatchesFilter(clientName: string, filter?: string[]) {
  if (!filter || filter.length === 0) return true;
  return filter.some((f) => clientName.includes(f) || f.includes(clientName));
}

function isAppRateLimit(error: unknown): error is MetaSyncError {
  return error instanceof MetaSyncError && error.code === "rate_limited";
}

class CooldownStop extends Error {}

async function main() {
  const clientFilter = parseArg("clients")?.split(",").map((c) => c.trim()).filter(Boolean);
  const limit = Number(parseArg("limit")) || undefined;

  if (await isMetaAppCooldownActive()) {
    const until = await getMetaAppCooldownUntil();
    console.log(`Meta app-wide cooldown is active (shared with the sync worker). Try again after ${until?.toISOString() ?? "the cooldown clears"}.`);
    await db.$disconnect();
    return;
  }

  const connections = await db.socialConnection.findMany({
    where: { platform: "INSTAGRAM" },
    select: { id: true, encryptedToken: true, client: { select: { name: true } } },
  });

  let processed = 0;
  let stored = 0;
  let skipped = 0;
  let stoppedForCooldown = false;

  try {
    for (const connection of connections) {
      if (!clientMatchesFilter(connection.client.name, clientFilter)) continue;
      if (limit !== undefined && processed >= limit) break;

      const posts = await db.socialPost.findMany({
        where: { connectionId: connection.id, thumbnailStorageKey: null },
        select: { id: true, externalPostId: true, mediaUrl: true, thumbnailUrl: true },
        orderBy: { publishedAt: "desc" },
        ...(limit !== undefined ? { take: limit - processed } : {}),
      });
      if (posts.length === 0) continue;

      const token = decryptToken(connection.encryptedToken);
      console.log(`${connection.client.name}: ${posts.length} post(s) missing a stored thumbnail`);

      for (const post of posts) {
        if (limit !== undefined && processed >= limit) break;
        processed++;
        let sourceUrl: string | null = post.thumbnailUrl ?? post.mediaUrl;
        try {
          const fresh = await graph<{ media_url?: string; thumbnail_url?: string }>(post.externalPostId, token, { fields: "media_url,thumbnail_url" });
          sourceUrl = fresh.thumbnail_url ?? fresh.media_url ?? sourceUrl;
        } catch (error) {
          if (isAppRateLimit(error)) {
            const until = await setMetaAppCooldownUntil(error.retryAfterMs);
            console.log(`Meta rate limit hit (${error.message}). Activated the shared app-wide cooldown until ${until.toISOString()} and stopping this run.`);
            stoppedForCooldown = true;
            throw new CooldownStop();
          }
          console.log(`  ${post.externalPostId}: could not refresh URL from Meta (${error instanceof Error ? error.message : error}), trying stored URL`);
        }

        if (!sourceUrl) {
          skipped++;
          continue;
        }

        const key = mediaThumbnailKey(connection.id, post.externalPostId);
        const storedKey = await persistMediaThumbnail(sourceUrl, key);
        if (!storedKey) {
          skipped++;
          console.log(`  ${post.externalPostId}: failed to persist thumbnail`);
          continue;
        }

        await db.socialPost.update({ where: { id: post.id }, data: { thumbnailStorageKey: storedKey } });
        stored++;
      }
    }
  } catch (error) {
    if (!(error instanceof CooldownStop)) throw error;
  }

  console.log();
  console.log(`Processed ${processed} post(s): ${stored} stored, ${skipped} skipped.${stoppedForCooldown ? " Stopped early due to Meta's app-wide rate limit; rerun this script once the cooldown clears." : ""}`);
  await db.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
