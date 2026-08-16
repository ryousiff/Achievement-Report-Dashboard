import { BackfillStatus, Platform, SyncJobStatus, SyncJobType, SyncRunStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { ConnectorError, getConnectorForPlatform } from "@/lib/connectors";
import { MetaSyncError, runHistoricalBackfillChunk, runHistoricalCollaborativeBackfillChunk, runIncrementalSync, runRecentInsightRefresh } from "@/lib/meta-sync";
import { getHistoricalBackfillConfig, getSchedulerConfig } from "@/lib/env";
import { logError, logEvent } from "@/lib/observability";

const schedulerModuleId = "scheduler";
const dailyClientSyncKey = "dailyClientSyncNextRunAt";

const metaCooldownModuleId = "meta_cooldown";
const metaCooldownUntilKey = "cooldown_until";
const metaCooldownAttemptsKey = "consecutive_rate_limits";

const metaIncrementalHoldModuleId = "meta_incremental_hold";
const metaIncrementalHoldUntilKey = "hold_until";

const lockMs = 15 * 60 * 1000;

/** Per-(connection, job type) lock key, so a HISTORICAL_MEDIA_BACKFILL job and an INCREMENTAL_MEDIA_SYNC
 * job for the *same* connection can run independently, while two jobs of the *same* type for the same
 * connection never run concurrently. */
function lockKey(connectionId: string, type: SyncJobType) {
  return `${connectionId}:${type}`;
}

function isHistoricalJob(type: SyncJobType) {
  return type === SyncJobType.HISTORICAL_MEDIA_BACKFILL || type === SyncJobType.HISTORICAL_COLLABORATIVE_BACKFILL;
}

async function hasActiveJob(connectionId: string, type: SyncJobType) {
  return db.syncJob.findFirst({ where: { connectionId, type, status: { in: [SyncJobStatus.QUEUED, SyncJobStatus.RUNNING] } } });
}

async function enqueueJob(connectionId: string, type: SyncJobType, runAfter?: Date) {
  const existing = await hasActiveJob(connectionId, type);
  if (existing) return existing;
  return db.syncJob.create({ data: { connectionId, type, runAfter: runAfter ?? new Date() } });
}

async function getSetting(moduleId: string, key: string): Promise<string | null> {
  const setting = await db.setting.findUnique({ where: { moduleId_key: { moduleId, key } } });
  return setting?.value ?? null;
}

async function setSetting(moduleId: string, key: string, value: string) {
  await db.setting.upsert({
    where: { moduleId_key: { moduleId, key } },
    create: { moduleId, key, value },
    update: { value },
  });
}

async function deleteSetting(moduleId: string, key: string) {
  await db.setting.deleteMany({ where: { moduleId, key } });
}

async function getMetaAppCooldownUntil(): Promise<Date | null> {
  const value = await getSetting(metaCooldownModuleId, metaCooldownUntilKey);
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

async function getMetaRateLimitAttempts(): Promise<number> {
  const value = await getSetting(metaCooldownModuleId, metaCooldownAttemptsKey);
  return value ? Number(value) || 0 : 0;
}

async function incrementMetaRateLimitAttempts(): Promise<number> {
  const current = await getMetaRateLimitAttempts();
  const next = current + 1;
  await setSetting(metaCooldownModuleId, metaCooldownAttemptsKey, String(next));
  return next;
}

async function resetMetaRateLimitAttempts() {
  await setSetting(metaCooldownModuleId, metaCooldownAttemptsKey, "0");
}

function computeCooldownMs(attempts: number, retryAfterMs?: number): number {
  const base = retryAfterMs ?? 5 * 60 * 1000;
  const ms = Math.min(60 * 60 * 1000, base * 2 ** Math.max(0, attempts - 1));
  const jitter = ms * (Math.random() * 0.4 - 0.2); // +/-20%
  return Math.max(1000, Math.round(ms + jitter));
}

/** Pause all Instagram jobs until the calculated cooldown expires, and push every other queued
 *  Instagram job back to that same time. This treats Meta code #4 as an application-wide rate limit
 *  rather than a per-client failure. */
export async function setMetaAppCooldownUntil(retryAfterMs?: number): Promise<Date> {
  const attempts = await incrementMetaRateLimitAttempts();
  const delayMs = computeCooldownMs(attempts, retryAfterMs);
  const until = new Date(Date.now() + delayMs);
  await setSetting(metaCooldownModuleId, metaCooldownUntilKey, until.toISOString());

  await db.syncJob.updateMany({
    where: {
      status: SyncJobStatus.QUEUED,
      runAfter: { lt: until },
      connection: { platform: Platform.INSTAGRAM },
    },
    data: { runAfter: until },
  });

  return until;
}

export async function clearMetaAppCooldown() {
  await deleteSetting(metaCooldownModuleId, metaCooldownUntilKey);
  await resetMetaRateLimitAttempts();
}

export async function isMetaAppCooldownActive(): Promise<boolean> {
  const until = await getMetaAppCooldownUntil();
  return !!until && until > new Date();
}

/** Push all INCREMENTAL_MEDIA_SYNC jobs (existing and newly enqueued) into the future so they do not
 *  consume the Meta app-level budget while required historical backfills are finishing. */
export async function holdIncrementalMediaSyncJobs(holdUntil?: Date) {
  const until = holdUntil ?? new Date(Date.now() + 6 * 60 * 60 * 1000); // default 6h
  await setSetting(metaIncrementalHoldModuleId, metaIncrementalHoldUntilKey, until.toISOString());
  await db.syncJob.updateMany({
    where: { type: SyncJobType.INCREMENTAL_MEDIA_SYNC, status: SyncJobStatus.QUEUED, runAfter: { lt: until } },
    data: { runAfter: until },
  });
  return until;
}

export async function releaseIncrementalMediaSyncJobs() {
  const holdValue = await getSetting(metaIncrementalHoldModuleId, metaIncrementalHoldUntilKey);
  const now = new Date();
  if (holdValue) {
    const holdUntil = new Date(holdValue);
    if (!Number.isNaN(holdUntil.getTime())) {
      await db.syncJob.updateMany({
        where: {
          type: SyncJobType.INCREMENTAL_MEDIA_SYNC,
          status: SyncJobStatus.QUEUED,
          runAfter: { gte: holdUntil },
        },
        data: { runAfter: now },
      });
    }
  }
  await deleteSetting(metaIncrementalHoldModuleId, metaIncrementalHoldUntilKey);
}

async function getIncrementalHoldUntil(): Promise<Date | null> {
  const value = await getSetting(metaIncrementalHoldModuleId, metaIncrementalHoldUntilKey);
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

async function nextInstagramJobRunAfter(): Promise<Date | null> {
  const [cooldownUntil, holdUntil] = await Promise.all([getMetaAppCooldownUntil(), getIncrementalHoldUntil()]);
  if (!cooldownUntil && !holdUntil) return null;
  const candidates = [cooldownUntil, holdUntil].filter((d): d is Date => d !== null);
  return new Date(Math.max(...candidates.map((d) => d.getTime())));
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
    select: { id: true, platform: true, lastSuccessfulSyncAt: true, historicalBackfillStatus: true, collaborativeBackfillStatus: true },
  });

  // If a Meta cooldown or incremental hold is active, new Instagram jobs should not be immediately due.
  const runAfter = await nextInstagramJobRunAfter();

  const jobs = await Promise.all(connections.map(async (connection) => {
    const connector = getConnectorForPlatform(connection.platform);
    if (!connector || !connector.isImplemented) return null;
    if (connection.platform === Platform.INSTAGRAM) await enqueueJob(connection.id, SyncJobType.DAILY_ACCOUNT_INSIGHT_SYNC, runAfter ?? undefined);
    if (connection.platform === Platform.INSTAGRAM && connection.historicalBackfillStatus === BackfillStatus.NOT_STARTED && connection.collaborativeBackfillStatus === BackfillStatus.NOT_STARTED && !connection.lastSuccessfulSyncAt) {
      await enqueueJob(connection.id, SyncJobType.HISTORICAL_MEDIA_BACKFILL, runAfter ?? undefined);
      return enqueueJob(connection.id, SyncJobType.HISTORICAL_COLLABORATIVE_BACKFILL, runAfter ?? undefined);
    }
    return enqueueJob(connection.id, SyncJobType.INCREMENTAL_MEDIA_SYNC, runAfter ?? undefined);
  }));
  return jobs.filter((job) => job !== null);
}

/** The admin-triggered "تشغيل المزامنة التاريخية" action — starts (or resumes) the deep historical
 * backfill for a connection regardless of whether it already has data from the old 90-day sync. Safe to
 * call repeatedly: a job already QUEUED/RUNNING for this connection+type is reused, not duplicated.
 * Enqueues both owned and collaborative historical backfills if either is incomplete. */
export async function enqueueHistoricalBackfill(connectionId: string) {
  const connection = await db.socialConnection.findUnique({
    where: { id: connectionId },
    select: { historicalBackfillStatus: true, collaborativeBackfillStatus: true },
  });
  if (!connection) throw new Error("Connection not found.");

  const ownedIncomplete = connection.historicalBackfillStatus !== BackfillStatus.COMPLETED;
  const collabIncomplete = connection.collaborativeBackfillStatus !== BackfillStatus.COMPLETED;
  if (!ownedIncomplete && !collabIncomplete) throw new Error("Historical sync has already completed for this connection.");

  // A previous transient failure may have left the connection itself marked FAILED even though a new
  // resumable job is about to be queued. Reset that stale terminal state immediately so coverage/UI does
  // not keep surfacing an old "fetch failed" while the retry is queued or running.
  if (connection.historicalBackfillStatus === BackfillStatus.FAILED || connection.collaborativeBackfillStatus === BackfillStatus.FAILED) {
    await db.socialConnection.update({
      where: { id: connectionId },
      data: {
        ...(connection.historicalBackfillStatus === BackfillStatus.FAILED
          ? { historicalBackfillStatus: BackfillStatus.PARTIAL, historicalBackfillLastError: null }
          : {}),
        ...(connection.collaborativeBackfillStatus === BackfillStatus.FAILED
          ? { collaborativeBackfillStatus: BackfillStatus.PARTIAL, collaborativeBackfillLastError: null }
          : {}),
      },
    });
  }

  const jobs: Awaited<ReturnType<typeof enqueueJob>>[] = [];

  if (ownedIncomplete) {
    if (connection.historicalBackfillStatus === BackfillStatus.RUNNING) {
      const active = await hasActiveJob(connectionId, SyncJobType.HISTORICAL_MEDIA_BACKFILL);
      if (active) jobs.push(active);
      else jobs.push(await enqueueJob(connectionId, SyncJobType.HISTORICAL_MEDIA_BACKFILL));
    } else {
      jobs.push(await enqueueJob(connectionId, SyncJobType.HISTORICAL_MEDIA_BACKFILL));
    }
  }

  if (collabIncomplete) {
    if (connection.collaborativeBackfillStatus === BackfillStatus.RUNNING) {
      const active = await hasActiveJob(connectionId, SyncJobType.HISTORICAL_COLLABORATIVE_BACKFILL);
      if (active) jobs.push(active);
      else jobs.push(await enqueueJob(connectionId, SyncJobType.HISTORICAL_COLLABORATIVE_BACKFILL));
    } else {
      jobs.push(await enqueueJob(connectionId, SyncJobType.HISTORICAL_COLLABORATIVE_BACKFILL));
    }
  }

  return jobs;
}

/** One-time migration helper for all existing Instagram connections: any connection whose owned backfill
 * already finished but that has not yet completed a collaborative backfill becomes eligible for one without
 * requiring an admin to disconnect and reconnect the account. */
export async function reconcileAllHistoricalCollaborativeBackfills() {
  const connections = await db.socialConnection.findMany({
    where: { platform: Platform.INSTAGRAM, historicalBackfillStatus: BackfillStatus.COMPLETED, collaborativeBackfillStatus: { not: BackfillStatus.COMPLETED } },
    select: { id: true, historicalBackfillStart: true },
  });
  const jobs = [];
  for (const connection of connections) {
    await db.socialConnection.update({
      where: { id: connection.id },
      data: { collaborativeBackfillStatus: BackfillStatus.NOT_STARTED, collaborativeBackfillStart: connection.historicalBackfillStart },
    });
    jobs.push(await enqueueJob(connection.id, SyncJobType.HISTORICAL_COLLABORATIVE_BACKFILL));
  }
  return jobs;
}

/** Atomically claims the daily-auto-sync "slot" using the Setting table as a distributed lock, the same
 * optimistic-claim shape as processNextSyncJob below: the WHERE guard (value <= now) is re-checked per-transaction
 * by Postgres's row-level locking, so if multiple worker processes (or a restarted worker racing its own
 * previous instance) call this around the same time, only one of them ever sees count > 0 — the rest simply
 * skip this cycle and try again on their next check. */
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
 * enqueueClientSync, whose own per-(connection,type) hasActiveJob check already prevents duplicate SyncJob
 * rows even if this were ever triggered more than once concurrently. */
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
 * is called. While the incremental-media hold is active, no new incremental jobs are enqueued so the worker
 * can focus on required historical backfills. */
export async function runDueDailyClientSync() {
  const holdUntil = await getIncrementalHoldUntil();
  if (holdUntil && holdUntil > new Date()) return null;

  const { dailyClientSyncIntervalMs } = getSchedulerConfig();
  if (await claimDailyClientSyncWindow(dailyClientSyncIntervalMs)) return triggerDailyClientSync();
  return null;
}

function delayFor(attempts: number, retryAfterMs?: number) {
  const config = getHistoricalBackfillConfig();
  const base = retryAfterMs !== undefined
    ? Math.min(60 * 60 * 1000, retryAfterMs * 2 ** Math.max(0, attempts - 1))
    : Math.min(60 * 60 * 1000, config.syncRetryBaseDelayMs * 2 ** Math.max(0, attempts - 1));
  const jitter = base * (Math.random() * 0.4 - 0.2); // +/-20%
  return Math.max(1000, Math.round(base + jitter));
}

function isRetryable(error: unknown): error is ConnectorError {
  if (!(error instanceof ConnectorError)) return false;
  if ("permanent" in error && (error as { permanent?: boolean }).permanent) return false;
  return error.code === "rate_limited" || error.code === "request_failed";
}

function isMetaRateLimitError(error: unknown): error is MetaSyncError {
  return error instanceof MetaSyncError && error.metaCode === "rate_limited";
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
    if (type === SyncJobType.HISTORICAL_COLLABORATIVE_BACKFILL) return runHistoricalCollaborativeBackfillChunk(connectionId);
    if (type === SyncJobType.RECENT_POST_INSIGHT_REFRESH) return runRecentInsightRefresh(connectionId);
    if (type === SyncJobType.INCREMENTAL_MEDIA_SYNC) return runIncrementalSync(connectionId);
    if (type === SyncJobType.DAILY_ACCOUNT_INSIGHT_SYNC) {
      const { runDailyAccountInsightChunk } = await import("@/lib/meta-sync-insights");
      return runDailyAccountInsightChunk(connectionId);
    }
  }
  const connector = getConnectorForPlatform(platform);
  if (!connector || !connector.isImplemented) throw new Error(`No implemented connector for platform ${platform}.`);
  return connector.syncConnection(connectionId);
}

export async function processNextSyncJob() {
  await recoverStaleJobs();

  const job = await db.syncJob.findFirst({ where: { status: SyncJobStatus.QUEUED, runAfter: { lte: new Date() } }, orderBy: { createdAt: "asc" } });
  if (!job) return null;

  const connection = await db.socialConnection.findUnique({ where: { id: job.connectionId }, select: { platform: true } });
  if (!connection) {
    await db.syncJob.update({ where: { id: job.id }, data: { status: SyncJobStatus.FAILED, lockedAt: null, lastError: "Connection no longer exists." } });
    await db.socialConnection.updateMany({ where: { id: job.connectionId }, data: { syncLockedUntil: null } });
    return null;
  }

  // Application-wide Meta cooldown: do not even claim the lock if Meta is rate-limited.
  const cooldownUntil = connection.platform === Platform.INSTAGRAM ? await getMetaAppCooldownUntil() : null;
  if (cooldownUntil && job.runAfter < cooldownUntil) {
    await db.syncJob.update({ where: { id: job.id }, data: { runAfter: cooldownUntil, lockedAt: null } });
    return null;
  }

  // Incremental-media hold: keep those jobs out of the way while required historical backfills finish.
  if (connection.platform === Platform.INSTAGRAM && job.type === SyncJobType.INCREMENTAL_MEDIA_SYNC) {
    const holdUntil = await getIncrementalHoldUntil();
    if (holdUntil && job.runAfter < holdUntil) {
      await db.syncJob.update({ where: { id: job.id }, data: { runAfter: holdUntil, lockedAt: null } });
      return null;
    }
  }

  const claimed = await db.syncJob.updateMany({ where: { id: job.id, status: SyncJobStatus.QUEUED }, data: { status: SyncJobStatus.RUNNING, lockedAt: new Date(), startedAt: new Date(), attempts: { increment: 1 } } });
  if (!claimed.count) return null;

  const key = lockKey(job.connectionId, job.type);
  const lock = await db.socialConnection.updateMany({ where: { id: job.connectionId, OR: [{ syncLockedUntil: null }, { syncLockedUntil: { lt: new Date() } }] }, data: { syncLockedUntil: new Date(Date.now() + lockMs) } });
  if (!lock.count) { await db.syncJob.update({ where: { id: job.id }, data: { status: SyncJobStatus.QUEUED, lockedAt: null, runAfter: new Date(Date.now() + 10_000) } }); return null; }

  // Once a historical retry is actually claimed, the connection must reflect that it is running and
  // must not keep exposing a stale terminal error from an earlier attempt.
  if (job.type === SyncJobType.HISTORICAL_MEDIA_BACKFILL) {
    await db.socialConnection.update({
      where: { id: job.connectionId },
      data: { historicalBackfillStatus: BackfillStatus.RUNNING, historicalBackfillLastError: null },
    });
  } else if (job.type === SyncJobType.HISTORICAL_COLLABORATIVE_BACKFILL) {
    await db.socialConnection.update({
      where: { id: job.connectionId },
      data: { collaborativeBackfillStatus: BackfillStatus.RUNNING, collaborativeBackfillLastError: null },
    });
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

    // A successful Instagram call means the app-level rate limit has (at least temporarily) cleared.
    if (connection.platform === Platform.INSTAGRAM) {
      await clearMetaAppCooldown();
    }

    // Historical backfill schedules its own continuation job once it knows whether it finished or hit budget.
    if (job.type === SyncJobType.HISTORICAL_MEDIA_BACKFILL) {
      const updated = await db.socialConnection.findUnique({ where: { id: job.connectionId }, select: { historicalBackfillStatus: true } });
      if (updated?.historicalBackfillStatus === BackfillStatus.PARTIAL) await enqueueJob(job.connectionId, SyncJobType.HISTORICAL_MEDIA_BACKFILL);
    }
    if (job.type === SyncJobType.HISTORICAL_COLLABORATIVE_BACKFILL) {
      const updated = await db.socialConnection.findUnique({ where: { id: job.connectionId }, select: { collaborativeBackfillStatus: true } });
      if (updated?.collaborativeBackfillStatus === BackfillStatus.PARTIAL) await enqueueJob(job.connectionId, SyncJobType.HISTORICAL_COLLABORATIVE_BACKFILL);
    }
    return { id: job.id, status: "succeeded", posts: result.posts };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Sync failed.";
    logError("sync.job.failed", error, { jobId: job.id, connectionId: job.connectionId, type: job.type, durationMs: Date.now() - startedAt });
    const retryable = isRetryable(error);
    const attempts = job.attempts + 1;
    const errorCode = error instanceof ConnectorError ? error.code : "sync_failed";
    const isRateLimited = errorCode === "rate_limited";
    const isMetaRateLimit = isRateLimited && connection.platform === Platform.INSTAGRAM;
    const transientHistoricalFailure = connection.platform === Platform.INSTAGRAM && isHistoricalJob(job.type) && retryable;

    let cooldownUntil: Date | null = null;
    if (isMetaRateLimit) {
      const retryAfter = error instanceof ConnectorError ? error.retryAfterMs : undefined;
      cooldownUntil = await setMetaAppCooldownUntil(retryAfter);
    }

    // Historical jobs are resumable and must not become terminally FAILED because of transient network
    // failures such as Node's "fetch failed" or Meta application rate limits. Permanent permission/object
    // errors remain non-retryable and can still fail normally.
    const maxAttempts = transientHistoricalFailure || (isRateLimited && retryable)
      ? Math.max(job.maxAttempts, attempts + 10)
      : job.maxAttempts;
    let failed = !retryable || attempts >= maxAttempts;
    if (failed && transientHistoricalFailure) failed = false;

    const retryAfter = error instanceof ConnectorError ? error.retryAfterMs : undefined;
    const now = new Date();
    const connectionUpdate: Record<string, unknown> = { syncLockedUntil: null };
    if (job.type === SyncJobType.INCREMENTAL_MEDIA_SYNC) { connectionUpdate.lastFailedSyncAt = now; connectionUpdate.lastFailureReason = message; connectionUpdate.lastIncrementalSyncError = message; }
    if (job.type === SyncJobType.HISTORICAL_MEDIA_BACKFILL) {
      if (failed) {
        connectionUpdate.historicalBackfillStatus = BackfillStatus.FAILED;
        connectionUpdate.historicalBackfillLastError = message;
        connectionUpdate.historicalBackfillRetryCount = { increment: 1 };
      } else {
        connectionUpdate.historicalBackfillStatus = BackfillStatus.PARTIAL;
        connectionUpdate.historicalBackfillLastError = message;
      }
    }
    if (job.type === SyncJobType.HISTORICAL_COLLABORATIVE_BACKFILL) {
      if (failed) {
        connectionUpdate.collaborativeBackfillStatus = BackfillStatus.FAILED;
        connectionUpdate.collaborativeBackfillLastError = message;
        connectionUpdate.collaborativeBackfillRetryCount = { increment: 1 };
      } else {
        connectionUpdate.collaborativeBackfillStatus = BackfillStatus.PARTIAL;
        connectionUpdate.collaborativeBackfillLastError = message;
      }
    }
    if (job.type === SyncJobType.DAILY_ACCOUNT_INSIGHT_SYNC) connectionUpdate.accountInsightsLastError = message;

    const runAfter = isMetaRateLimit && cooldownUntil
      ? cooldownUntil
      : new Date(Date.now() + delayFor(attempts, retryAfter));

    const jobUpdate = failed
      ? { status: SyncJobStatus.FAILED, finishedAt: now, lockedAt: null, lastError: message }
      : { status: SyncJobStatus.QUEUED, lockedAt: null, lastError: message, runAfter };

    // The currently failing job was already pushed back by setMetaAppCooldownUntil; make sure its own
    // runAfter matches the cooldown so it does not leap ahead of other Instagram jobs.
    await db.$transaction([
      db.syncRun.update({ where: { id: run.id }, data: { status: SyncRunStatus.FAILED, finishedAt: now, durationMs: Date.now() - startedAt, errorCode, errorMessage: message } }),
      db.syncJob.update({ where: { id: job.id }, data: { ...jobUpdate, maxAttempts } }),
      db.socialConnection.update({ where: { id: job.connectionId }, data: connectionUpdate }),
    ]);
    return { id: job.id, status: failed ? "failed" : "retrying" };
  }
}
