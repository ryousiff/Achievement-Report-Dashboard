import { BackfillStatus, Platform, SyncJobStatus, SyncJobType, SyncRunStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { ConnectorError, getConnectorForPlatform } from "@/lib/connectors";
import { runHistoricalBackfillChunk, runIncrementalSync, runRecentInsightRefresh } from "@/lib/meta-sync";
import { getHistoricalBackfillConfig, getSchedulerConfig } from "@/lib/env";
import { logError, logEvent } from "@/lib/observability";

const schedulerModuleId = "scheduler";
const dailyClientSyncKey = "dailyClientSyncNextRunAt";

const lockMs = 15 * 60 * 1000;

/** Per-(connection, job type) lock key, so a HISTORICAL_MEDIA_BACKFILL job and an INCREMENTAL_MEDIA_SYNC
 * job for the *same* connection can run independently, while two jobs of the *same* type for the same
 * connection never run concurrently. */
function lockKey(connectionId: string, type: SyncJobType) {
  return `${connectionId}:${type}`;
}

async function hasActiveJob(connectionId: string, type: SyncJobType) {
  return db.syncJob.findFirst({ where: { connectionId, type, status: { in: [SyncJobStatus.QUEUED, SyncJobStatus.RUNNING] } } });
}

async function enqueueJob(connectionId: string, type: SyncJobType, runAfter?: Date) {
  const existing = await hasActiveJob(connectionId, type);
  if (existing) return existing;
  return db.syncJob.create({ data: { connectionId, type, runAfter: runAfter ?? new Date() } });
}

/** Enqueues sync for every connection of a client. Existing connections keep their current incremental
 * behavior unchanged; a brand-new connection (never synced under the old or new system) automatically
 * starts its one-time historical backfill, matching the previous "sync everything on first connect"
 * behavior — just resumable now instead of one blocking call. Connections that already completed the old
 * 90-day sync are NOT auto-upgraded to the deeper backfill here; that requires the explicit admin action
 * (see enqueueHistoricalBackfill / POST /api/clients/:clientId/backfill). */
export async function enqueueClientSync(clientId: string) {
  const connections = await db.socialConnection.findMany({
    where: { clientId },
    select: { id: true, platform: true, lastSuccessfulSyncAt: true, historicalBackfillStatus: true },
  });
  const jobs = await Promise.all(connections.map(async (connection) => {
    const connector = getConnectorForPlatform(connection.platform);
    if (!connector || !connector.isImplemented) return null;
    if (connection.platform === Platform.INSTAGRAM) await enqueueJob(connection.id, SyncJobType.DAILY_ACCOUNT_INSIGHT_SYNC);
    if (connection.platform === Platform.INSTAGRAM && connection.historicalBackfillStatus === BackfillStatus.NOT_STARTED && !connection.lastSuccessfulSyncAt) {
      return enqueueJob(connection.id, SyncJobType.HISTORICAL_MEDIA_BACKFILL);
    }
    return enqueueJob(connection.id, SyncJobType.INCREMENTAL_MEDIA_SYNC);
  }));
  return jobs.filter((job) => job !== null);
}

/** The admin-triggered "تشغيل المزامنة التاريخية" action — starts (or resumes) the deep historical
 * backfill for a connection regardless of whether it already has data from the old 90-day sync. Safe to
 * call repeatedly: a job already QUEUED/RUNNING for this connection+type is reused, not duplicated. */
export async function enqueueHistoricalBackfill(connectionId: string) {
  const connection = await db.socialConnection.findUnique({ where: { id: connectionId }, select: { historicalBackfillStatus: true } });
  if (!connection) throw new Error("Connection not found.");
  if (connection.historicalBackfillStatus === BackfillStatus.RUNNING) {
    const active = await hasActiveJob(connectionId, SyncJobType.HISTORICAL_MEDIA_BACKFILL);
    if (active) return active;
  }
  if (connection.historicalBackfillStatus === BackfillStatus.COMPLETED) throw new Error("Historical sync has already completed for this connection.");
  return enqueueJob(connectionId, SyncJobType.HISTORICAL_MEDIA_BACKFILL);
}

/** Atomically claims the daily-auto-sync "slot" using the Setting table as a distributed lock, the same
 * optimistic-claim shape as syncLockedUntil in processNextSyncJob below: the WHERE guard (value <= now) is
 * re-checked per-transaction by Postgres's row-level locking, so if multiple worker processes (or a
 * restarted worker racing its own previous instance) call this around the same time, only one of them
 * ever sees count > 0 — the rest simply skip this cycle and try again on their next check. */
async function claimDailyClientSyncWindow(intervalMs: number) {
  const now = new Date();
  await db.setting.createMany({ data: [{ moduleId: schedulerModuleId, key: dailyClientSyncKey, value: now.toISOString() }], skipDuplicates: true });
  const claimed = await db.setting.updateMany({
    where: { moduleId: schedulerModuleId, key: dailyClientSyncKey, value: { lte: now.toISOString() } },
    data: { value: new Date(now.getTime() + intervalMs).toISOString() },
  });
  return claimed.count > 0;
}

/** Queues a normal incremental sync (never the deep historical backfill) for every active client — reuses
 * enqueueClientSync, whose own per-(connection,type) hasActiveJob check already prevents duplicate
 * SyncJob rows even if this were ever triggered more than once concurrently. */
async function triggerDailyClientSync() {
  const clients = await db.client.findMany({ where: { active: true }, select: { id: true } });
  const results = await Promise.allSettled(clients.map((client) => enqueueClientSync(client.id)));
  const failed = results.filter((result) => result.status === "rejected").length;
  logEvent("sync.daily.triggered", { clients: clients.length, failed });
  if (failed) logError("sync.daily.partial_failure", new Error(`${failed} of ${clients.length} clients failed to enqueue daily sync.`));
  return results;
}

/** Called by the worker on a periodic check (see worker.ts); only actually enqueues jobs once per
 * configured interval (default 24h), regardless of how often — or from how many worker processes — this
 * is called. */
export async function runDueDailyClientSync() {
  const { dailyClientSyncIntervalMs } = getSchedulerConfig();
  if (await claimDailyClientSyncWindow(dailyClientSyncIntervalMs)) return triggerDailyClientSync();
  return null;
}

function delayFor(attempts: number, retryAfterMs?: number) {
  const config = getHistoricalBackfillConfig();
  const base = retryAfterMs ?? Math.min(60 * 60 * 1000, config.syncRetryBaseDelayMs * 2 ** Math.max(0, attempts - 1));
  const jitter = base * (Math.random() * 0.4 - 0.2); // +/-20%
  return Math.max(1000, Math.round(base + jitter));
}

function isRetryable(error: unknown): error is ConnectorError {
  if (!(error instanceof ConnectorError)) return false;
  if ("permanent" in error && (error as { permanent?: boolean }).permanent) return false;
  return error.code === "rate_limited" || error.code === "request_failed";
}

async function recoverStaleJobs() {
  const staleAt = new Date(Date.now() - lockMs);
  await db.syncJob.updateMany({ where: { status: SyncJobStatus.RUNNING, lockedAt: { lt: staleAt } }, data: { status: SyncJobStatus.QUEUED, lockedAt: null, runAfter: new Date() } });
}

/** Dispatches a job to the right sync function. Instagram-specific job types bypass the generic
 * SocialConnector.syncConnection() interface entirely (so stub connectors for other platforms are
 * completely unaffected by any of this); everything else still goes through the generic connector. */
async function runJob(connectionId: string, platform: Platform, type: SyncJobType) {
  if (platform === Platform.INSTAGRAM) {
    if (type === SyncJobType.HISTORICAL_MEDIA_BACKFILL) return runHistoricalBackfillChunk(connectionId);
    if (type === SyncJobType.RECENT_POST_INSIGHT_REFRESH) return runRecentInsightRefresh(connectionId);
    if (type === SyncJobType.INCREMENTAL_MEDIA_SYNC) return runIncrementalSync(connectionId);
    if (type === SyncJobType.DAILY_ACCOUNT_INSIGHT_SYNC) {
      const { runDailyAccountInsightChunk } = await import("@/lib/meta-sync-insights");
      return runDailyAccountInsightChunk(connectionId);
    }
    if (type === SyncJobType.STORY_SYNC) return { posts: 0 }; // no Story sync pipeline exists yet (Part 4)
  }
  const connector = getConnectorForPlatform(platform);
  if (!connector || !connector.isImplemented) throw new Error(`No implemented connector for platform ${platform}.`);
  return connector.syncConnection(connectionId);
}

export async function processNextSyncJob() {
  await recoverStaleJobs();
  const job = await db.syncJob.findFirst({ where: { status: SyncJobStatus.QUEUED, runAfter: { lte: new Date() } }, orderBy: { createdAt: "asc" } });
  if (!job) return null;
  const claimed = await db.syncJob.updateMany({ where: { id: job.id, status: SyncJobStatus.QUEUED }, data: { status: SyncJobStatus.RUNNING, lockedAt: new Date(), startedAt: new Date(), attempts: { increment: 1 } } });
  if (!claimed.count) return null;

  const key = lockKey(job.connectionId, job.type);
  const lock = await db.socialConnection.updateMany({ where: { id: job.connectionId, OR: [{ syncLockedUntil: null }, { syncLockedUntil: { lt: new Date() } }] }, data: { syncLockedUntil: new Date(Date.now() + lockMs) } });
  if (!lock.count) { await db.syncJob.update({ where: { id: job.id }, data: { status: SyncJobStatus.QUEUED, lockedAt: null, runAfter: new Date(Date.now() + 10_000) } }); return null; }

  const connection = await db.socialConnection.findUnique({ where: { id: job.connectionId }, select: { platform: true } });
  if (!connection) {
    await db.syncJob.update({ where: { id: job.id }, data: { status: SyncJobStatus.FAILED, lockedAt: null, lastError: "Connection no longer exists." } });
    await db.socialConnection.updateMany({ where: { id: job.connectionId }, data: { syncLockedUntil: null } });
    return null;
  }

  const run = await db.syncRun.create({ data: { jobId: job.id, connectionId: job.connectionId } });
  const startedAt = Date.now();
  logEvent("sync.job.started", { jobId: job.id, connectionId: job.connectionId, type: job.type, lockKey: key, platform: connection.platform, attempt: job.attempts + 1 });
  try {
    const result = await runJob(job.connectionId, connection.platform, job.type);
    const now = new Date();
    const connectionUpdate: Record<string, unknown> = { syncLockedUntil: null };
    // Only the legacy generic fields (read by existing UI/readiness checks) get updated here for
    // incremental-style jobs. Historical backfill manages its own dedicated fields directly (see
    // runHistoricalBackfillChunk) so a slow, still-in-progress backfill is never mistaken for "synced".
    if (job.type === SyncJobType.INCREMENTAL_MEDIA_SYNC || job.type === SyncJobType.RECENT_POST_INSIGHT_REFRESH) {
      connectionUpdate.lastSyncedAt = now;
      connectionUpdate.lastSuccessfulSyncAt = now;
      connectionUpdate.lastFailureReason = null;
    }
    await db.$transaction([
      db.syncRun.update({ where: { id: run.id }, data: { status: SyncRunStatus.SUCCEEDED, finishedAt: now, durationMs: Date.now() - startedAt, postsSynced: result.posts } }),
      db.syncJob.update({ where: { id: job.id }, data: { status: SyncJobStatus.SUCCEEDED, finishedAt: now, lockedAt: null, lastError: null } }),
      db.socialConnection.update({ where: { id: job.connectionId }, data: connectionUpdate }),
    ]);
    logEvent("sync.job.succeeded", { jobId: job.id, connectionId: job.connectionId, type: job.type, posts: result.posts, durationMs: Date.now() - startedAt });
    // Historical backfill schedules its own continuation job once it knows whether it finished or hit budget.
    if (job.type === SyncJobType.HISTORICAL_MEDIA_BACKFILL) {
      const updated = await db.socialConnection.findUnique({ where: { id: job.connectionId }, select: { historicalBackfillStatus: true } });
      if (updated?.historicalBackfillStatus === BackfillStatus.PARTIAL) await enqueueJob(job.connectionId, SyncJobType.HISTORICAL_MEDIA_BACKFILL);
    }
    return { id: job.id, status: "succeeded", posts: result.posts };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Sync failed.";
    logError("sync.job.failed", error, { jobId: job.id, connectionId: job.connectionId, type: job.type, durationMs: Date.now() - startedAt });
    const retryable = isRetryable(error);
    const attempts = job.attempts + 1;
    const failed = !retryable || attempts >= job.maxAttempts;
    const errorCode = error instanceof ConnectorError ? error.code : "sync_failed";
    const retryAfter = error instanceof ConnectorError ? error.retryAfterMs : undefined;
    const now = new Date();
    const connectionUpdate: Record<string, unknown> = { syncLockedUntil: null };
    if (job.type === SyncJobType.INCREMENTAL_MEDIA_SYNC) { connectionUpdate.lastFailedSyncAt = now; connectionUpdate.lastFailureReason = message; connectionUpdate.lastIncrementalSyncError = message; }
    if (job.type === SyncJobType.HISTORICAL_MEDIA_BACKFILL && failed) { connectionUpdate.historicalBackfillStatus = BackfillStatus.FAILED; connectionUpdate.historicalBackfillLastError = message; connectionUpdate.historicalBackfillRetryCount = { increment: 1 }; }
    if (job.type === SyncJobType.DAILY_ACCOUNT_INSIGHT_SYNC) connectionUpdate.accountInsightsLastError = message;
    await db.$transaction([
      db.syncRun.update({ where: { id: run.id }, data: { status: SyncRunStatus.FAILED, finishedAt: now, durationMs: Date.now() - startedAt, errorCode, errorMessage: message } }),
      db.syncJob.update({ where: { id: job.id }, data: failed ? { status: SyncJobStatus.FAILED, finishedAt: now, lockedAt: null, lastError: message } : { status: SyncJobStatus.QUEUED, lockedAt: null, lastError: message, runAfter: new Date(Date.now() + delayFor(attempts, retryAfter)) } }),
      db.socialConnection.update({ where: { id: job.connectionId }, data: connectionUpdate }),
    ]);
    return { id: job.id, status: failed ? "failed" : "retrying" };
  }
}
