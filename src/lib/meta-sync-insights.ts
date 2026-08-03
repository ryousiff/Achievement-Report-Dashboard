import { db } from "@/lib/db";
import { Platform } from "@prisma/client";
import { decryptToken } from "@/lib/token-encryption";
import { calculateBackfillStart } from "@/lib/backfill-window";
import { getHistoricalBackfillConfig } from "@/lib/env";
import { MetaSyncError } from "@/lib/meta-sync";

const graphUrl = "https://graph.facebook.com/v23.0";
type MetaInsight = { name?: string; values?: Array<{ value?: number; end_time?: string }> };
type MetaErrorResponse = { error?: { code?: number; message?: string } };

async function graph<T>(path: string, token: string, parameters: Record<string, string>) {
  const url = new URL(`${graphUrl}/${path}`);
  Object.entries({ ...parameters, access_token: token }).forEach(([key, value]) => url.searchParams.set(key, value));
  const response = await fetch(url, { cache: "no-store" });
  if (response.ok) return response.json() as Promise<T>;
  const body = await response.json().catch(() => ({})) as MetaErrorResponse;
  const code = body.error?.code;
  const rateLimited = response.status === 429 || code === 4 || code === 17 || code === 32 || code === 613;
  throw new MetaSyncError(body.error?.message ?? "Meta insight request failed.", rateLimited ? "rate_limited" : "request_failed", undefined, !rateLimited);
}

/** Splits [from, to] into consecutive, non-overlapping, gap-free UTC-day windows of at most `chunkDays`
 * days each. Windows are built oldest-first so callers can stop cleanly at the first chunk that fails
 * (rather than an arbitrary one in the middle), and each window's `until` is exactly one day before the
 * next window's `since` — never duplicated, never skipped. */
export function buildDailyInsightChunks(from: Date, to: Date, chunkDays: number): Array<{ since: Date; until: Date }> {
  const chunks: Array<{ since: Date; until: Date }> = [];
  let cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  const end = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate()));
  while (cursor <= end) {
    const until = new Date(cursor);
    until.setUTCDate(until.getUTCDate() + chunkDays - 1);
    if (until > end) until.setTime(end.getTime());
    chunks.push({ since: new Date(cursor), until: new Date(until) });
    cursor = new Date(until);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return chunks;
}

async function fetchAndStoreDailyMetric(connectionId: string, accountId: string, token: string, metric: "follows" | "reach", since: Date, until: Date) {
  const insights = await graph<{ data?: MetaInsight[] }>(`${accountId}/insights`, token, { metric, period: "day", since: String(Math.floor(since.valueOf() / 1000)), until: String(Math.floor(until.valueOf() / 1000)) });
  let earliestStored: Date | null = null;
  for (const insight of insights.data ?? []) for (const item of insight.values ?? []) {
    if (typeof item.value !== "number" || !item.end_time) continue; // never overwrite a stored value with a missing/null one
    const periodEnd = new Date(item.end_time);
    const periodStart = new Date(periodEnd);
    periodStart.setUTCDate(periodStart.getUTCDate() - 1);
    await db.socialInsightSnapshot.upsert({ where: { connectionId_metric_periodStart_periodEnd: { connectionId, metric, periodStart, periodEnd } }, create: { connectionId, metric, periodStart, periodEnd, value: item.value }, update: { value: item.value } });
    if (!earliestStored || periodStart < earliestStored) earliestStored = periodStart;
  }
  return earliestStored;
}

/** One bounded unit of daily reach/follows sync: chunks the configured lookback into <=`chunkDays` windows
 * and works backward from the most recent window, recording the earliest date data was *actually*
 * successfully returned (reachCoverageStart/followsCoverageStart) rather than assuming Meta's retention
 * window in advance — a chunk that comes back empty/erroring simply isn't retried further back than that,
 * and the last-known coverage boundary stays intact (see report-coverage.ts for how this is surfaced). */
export async function runDailyAccountInsightChunk(connectionId: string) {
  const connection = await db.socialConnection.findUnique({ where: { id: connectionId }, select: { id: true, platform: true, externalAccountId: true, encryptedToken: true, reachCoverageStart: true, followsCoverageStart: true } });
  if (!connection || connection.platform !== Platform.INSTAGRAM) throw new Error("Instagram connection not found.");
  const token = decryptToken(connection.encryptedToken);
  const config = getHistoricalBackfillConfig();
  const overallStart = calculateBackfillStart(new Date(), config.months);
  const lookbackFloor = new Date(Date.now() - config.accountInsightMaxLookbackDays * 24 * 60 * 60 * 1000);
  const from = overallStart > lookbackFloor ? overallStart : lookbackFloor;
  const now = new Date();

  const metrics: Array<{ metric: "follows" | "reach"; coverageStart: Date | null }> = [
    { metric: "follows", coverageStart: connection.followsCoverageStart },
    { metric: "reach", coverageStart: connection.reachCoverageStart },
  ];

  let lastError: string | null = null;
  let allMetricsReachedFloor = true;
  for (const { metric, coverageStart } of metrics) {
    // Resume just before whatever we already have coverage for; otherwise cover the full configured window.
    const rangeEnd = coverageStart ? new Date(coverageStart.valueOf() - 24 * 60 * 60 * 1000) : now;
    if (rangeEnd < from) continue; // already covered back to (or past) our target window for this metric
    const chunks = buildDailyInsightChunks(from, rangeEnd, config.accountInsightChunkDays).reverse(); // newest-first: stop at first failure
    let reachedFloor = true;
    for (const chunk of chunks) {
      try {
        const earliest = await fetchAndStoreDailyMetric(connectionId, connection.externalAccountId, token, metric, chunk.since, chunk.until);
        if (earliest) {
          const field = metric === "reach" ? "reachCoverageStart" : "followsCoverageStart";
          await db.socialConnection.update({ where: { id: connectionId }, data: { [field]: earliest, accountInsightsLastSyncedAt: new Date() } });
        }
      } catch (error) {
        // A rate limit should bubble up so the job-level retry/backoff in sync-queue.ts handles it; anything
        // else (e.g. Meta no longer has data this far back) just stops walking further back for this metric —
        // the coverage-start we've already recorded becomes the honest boundary rather than a hard failure.
        if (error instanceof MetaSyncError && error.code === "rate_limited") throw error;
        lastError = error instanceof Error ? error.message : "Daily insight request failed.";
        reachedFloor = false;
        break;
      }
    }
    if (!reachedFloor) allMetricsReachedFloor = false;
  }

  await db.socialConnection.update({
    where: { id: connectionId },
    data: { accountInsightsLastError: lastError, ...(allMetricsReachedFloor ? { accountInsightsBackfillCompletedAt: new Date() } : {}) },
  });
  return { posts: 0 };
}
