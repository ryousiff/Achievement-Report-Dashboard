import { SyncJobStatus, SyncRunStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { ConnectorError, getConnectorForPlatform } from "@/lib/connectors";
import { logError, logEvent } from "@/lib/observability";

const lockMs = 15 * 60 * 1000;

export async function enqueueClientSync(clientId: string) {
  const connections = await db.socialConnection.findMany({
    where: { clientId },
    select: { id: true, platform: true },
  });
  const jobs = await Promise.all(connections.map(async (connection) => {
    const connector = getConnectorForPlatform(connection.platform);
    if (!connector || !connector.isImplemented) return null;
    const existing = await db.syncJob.findFirst({
      where: { connectionId: connection.id, status: { in: [SyncJobStatus.QUEUED, SyncJobStatus.RUNNING] } },
      orderBy: { createdAt: "desc" },
    });
    return existing ?? db.syncJob.create({ data: { connectionId: connection.id } });
  }));
  return jobs.filter((job) => job !== null);
}

function delayFor(attempts: number, retryAfterMs?: number) {
  return retryAfterMs ?? Math.min(60 * 60 * 1000, 30_000 * 2 ** Math.max(0, attempts - 1));
}

function isRetryable(error: unknown): error is ConnectorError {
  return error instanceof ConnectorError && (error.code === "rate_limited" || error.code === "request_failed");
}

async function recoverStaleJobs() {
  const staleAt = new Date(Date.now() - lockMs);
  await db.syncJob.updateMany({ where: { status: SyncJobStatus.RUNNING, lockedAt: { lt: staleAt } }, data: { status: SyncJobStatus.QUEUED, lockedAt: null, runAfter: new Date() } });
}

export async function processNextSyncJob() {
  await recoverStaleJobs();
  const job = await db.syncJob.findFirst({ where: { status: SyncJobStatus.QUEUED, runAfter: { lte: new Date() } }, orderBy: { createdAt: "asc" } });
  if (!job) return null;
  const claimed = await db.syncJob.updateMany({ where: { id: job.id, status: SyncJobStatus.QUEUED }, data: { status: SyncJobStatus.RUNNING, lockedAt: new Date(), startedAt: new Date(), attempts: { increment: 1 } } });
  if (!claimed.count) return null;
  const lock = await db.socialConnection.updateMany({ where: { id: job.connectionId, OR: [{ syncLockedUntil: null }, { syncLockedUntil: { lt: new Date() } }] }, data: { syncLockedUntil: new Date(Date.now() + lockMs) } });
  if (!lock.count) { await db.syncJob.update({ where: { id: job.id }, data: { status: SyncJobStatus.QUEUED, lockedAt: null, runAfter: new Date(Date.now() + 10_000) } }); return null; }

  const connection = await db.socialConnection.findUnique({
    where: { id: job.connectionId },
    select: { platform: true },
  });
  if (!connection) {
    await db.syncJob.update({ where: { id: job.id }, data: { status: SyncJobStatus.FAILED, lockedAt: null, lastError: "Connection no longer exists." } });
    return null;
  }

  const connector = getConnectorForPlatform(connection.platform);
  if (!connector || !connector.isImplemented) {
    await db.syncJob.update({ where: { id: job.id }, data: { status: SyncJobStatus.FAILED, lockedAt: null, lastError: `No implemented connector for platform ${connection.platform}.` } });
    return null;
  }

  const run = await db.syncRun.create({ data: { jobId: job.id, connectionId: job.connectionId } });
  const startedAt = Date.now();
  logEvent("sync.job.started", { jobId: job.id, connectionId: job.connectionId, platform: connection.platform, attempt: job.attempts + 1 });
  try {
    const result = await connector.syncConnection(job.connectionId);
    const now = new Date();
    await db.$transaction([
      db.syncRun.update({ where: { id: run.id }, data: { status: SyncRunStatus.SUCCEEDED, finishedAt: now, durationMs: Date.now() - startedAt, postsSynced: result.posts } }),
      db.syncJob.update({ where: { id: job.id }, data: { status: SyncJobStatus.SUCCEEDED, finishedAt: now, lockedAt: null, lastError: null } }),
      db.socialConnection.update({ where: { id: job.connectionId }, data: { lastSyncedAt: now, lastSuccessfulSyncAt: now, lastFailureReason: null, syncLockedUntil: null } }),
    ]);
    logEvent("sync.job.succeeded", { jobId: job.id, connectionId: job.connectionId, posts: result.posts, durationMs: Date.now() - startedAt });
    return { id: job.id, status: "succeeded", posts: result.posts };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Sync failed.";
    logError("sync.job.failed", error, { jobId: job.id, connectionId: job.connectionId, durationMs: Date.now() - startedAt });
    const retryable = isRetryable(error);
    const attempts = job.attempts + 1;
    const failed = !retryable || attempts >= job.maxAttempts;
    const errorCode = error instanceof ConnectorError ? error.code : "sync_failed";
    const retryAfter = error instanceof ConnectorError ? error.retryAfterMs : undefined;
    const now = new Date();
    await db.$transaction([
      db.syncRun.update({ where: { id: run.id }, data: { status: SyncRunStatus.FAILED, finishedAt: now, durationMs: Date.now() - startedAt, errorCode, errorMessage: message } }),
      db.syncJob.update({ where: { id: job.id }, data: failed ? { status: SyncJobStatus.FAILED, finishedAt: now, lockedAt: null, lastError: message } : { status: SyncJobStatus.QUEUED, lockedAt: null, lastError: message, runAfter: new Date(Date.now() + delayFor(attempts, retryAfter)) } }),
      db.socialConnection.update({ where: { id: job.connectionId }, data: { lastFailedSyncAt: now, lastFailureReason: message, syncLockedUntil: null } }),
    ]);
    return { id: job.id, status: failed ? "failed" : "retrying" };
  }
}
