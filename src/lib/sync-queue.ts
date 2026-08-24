import { BackfillStatus, Platform, Prisma, SyncJobStatus, SyncJobType, SyncRunStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { ConnectorError, getConnectorForPlatform } from "@/lib/connectors";
import { MetaSyncError, runHistoricalBackfillChunk, runHistoricalCollaborativeBackfillChunk, runIncrementalSync, runRecentInsightRefresh } from "@/lib/meta-sync";
import {
  isLastDaysOfMonth,
  isMonthEndCloseoutDue,
  isReportPeriodCloseoutDue,
  runMonthEndCloseout,
  runReportPeriodCloseout,
} from "@/lib/month-end-closeout";
import { isMonthFinalized, monthPeriodUTC } from "@/lib/post-metric-snapshots";
import { getHistoricalBackfillConfig, getSchedulerConfig, getThumbnailBackfillConfig } from "@/lib/env";
import { logError, logEvent } from "@/lib/observability";

const schedulerModuleId = "scheduler";
const dailyClientSyncKey = "dailyClientSyncNextRunAt";
const monthlyReportPrepKey = "monthlyReportPrepNextRunAt";

const metaCooldownModuleId = "meta_cooldown";

/** Report-first job priorities. Higher numbers run first. */
const JobPriority = {
  MONTH_END_CLOSEOUT: 100,
  MONTH_END_PREPARATION: 80,
  DAILY_SYNC: 50,
  HISTORICAL_BACKFILL: 30,
  THUMBNAIL_BACKFILL: 10,
} as const;
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

async function enqueueJob(
  connectionId: string,
  type: SyncJobType,
  priority: number = 0,
  runAfter?: Date,
  payload?: Prisma.InputJsonValue | null,
) {
  const existing = await hasActiveJob(connectionId, type);
  if (existing) {
    // Boost the priority of an already-active job if the scheduler now considers it more urgent.
    if (existing.priority < priority) {
      await db.syncJob.update({ where: { id: existing.id }, data: { priority } });
      return { ...existing, priority };
    }
    return existing;
  }
  return db.syncJob.create({
    data: { connectionId, type, priority, payload: payload ?? undefined, runAfter: runAfter ?? new Date() },
  });
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

export async function getMetaAppCooldownUntil(): Promise<Date | null> {
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
    if (connection.platform === Platform.INSTAGRAM) await enqueueJob(connection.id, SyncJobType.DAILY_ACCOUNT_INSIGHT_SYNC, JobPriority.DAILY_SYNC, runAfter ?? undefined);
    if (connection.platform === Platform.INSTAGRAM && connection.historicalBackfillStatus === BackfillStatus.NOT_STARTED && connection.collaborativeBackfillStatus === BackfillStatus.NOT_STARTED && !connection.lastSuccessfulSyncAt) {
      await enqueueJob(connection.id, SyncJobType.HISTORICAL_MEDIA_BACKFILL, JobPriority.HISTORICAL_BACKFILL, runAfter ?? undefined);
      return enqueueJob(connection.id, SyncJobType.HISTORICAL_COLLABORATIVE_BACKFILL, JobPriority.HISTORICAL_BACKFILL, runAfter ?? undefined);
    }
    return enqueueJob(connection.id, SyncJobType.INCREMENTAL_MEDIA_SYNC, JobPriority.DAILY_SYNC, runAfter ?? undefined);
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
      else jobs.push(await enqueueJob(connectionId, SyncJobType.HISTORICAL_MEDIA_BACKFILL, JobPriority.HISTORICAL_BACKFILL));
    } else {
      jobs.push(await enqueueJob(connectionId, SyncJobType.HISTORICAL_MEDIA_BACKFILL, JobPriority.HISTORICAL_BACKFILL));
    }
  }

  if (collabIncomplete) {
    if (connection.collaborativeBackfillStatus === BackfillStatus.RUNNING) {
      const active = await hasActiveJob(connectionId, SyncJobType.HISTORICAL_COLLABORATIVE_BACKFILL);
      if (active) jobs.push(active);
      else jobs.push(await enqueueJob(connectionId, SyncJobType.HISTORICAL_COLLABORATIVE_BACKFILL, JobPriority.HISTORICAL_BACKFILL));
    } else {
      jobs.push(await enqueueJob(connectionId, SyncJobType.HISTORICAL_COLLABORATIVE_BACKFILL, JobPriority.HISTORICAL_BACKFILL));
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
    jobs.push(await enqueueJob(connection.id, SyncJobType.HISTORICAL_COLLABORATIVE_BACKFILL, JobPriority.HISTORICAL_BACKFILL));
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

/** Atomically claims the monthly report preparation scheduler window. */
async function claimMonthlyReportPrepWindow(intervalMs: number) {
  const now = new Date();
  await db.setting.createMany({ data: [{ moduleId: schedulerModuleId, key: monthlyReportPrepKey, value: now.toISOString() }], skipDuplicates: true });
  const claimed = await db.setting.updateMany({
    where: { moduleId: schedulerModuleId, key: monthlyReportPrepKey, value: { lte: now.toISOString() } },
    data: { value: new Date(now.getTime() + intervalMs).toISOString() },
  });
  return claimed.count > 0;
}

function isStale(lastAt: Date | null, maxAgeMs: number, now: Date) {
  if (!lastAt) return true;
  return now.valueOf() - lastAt.valueOf() >= maxAgeMs;
}

async function isIncrementalSyncDue(connection: { id: string; lastIncrementalSyncAt: Date | null }, now: Date) {
  const { monthlyPrepIncrementalMinIntervalMs } = getSchedulerConfig();
  const existing = await hasActiveJob(connection.id, SyncJobType.INCREMENTAL_MEDIA_SYNC);
  if (existing) return false;
  return isStale(connection.lastIncrementalSyncAt, monthlyPrepIncrementalMinIntervalMs, now);
}

async function isDailyAccountInsightSyncDue(
  connection: { id: string; accountInsightsLastSyncedAt: Date | null; accountInsightsBackfillCompletedAt: Date | null },
  now: Date,
) {
  const { monthlyPrepAccountInsightsMinIntervalMs } = getSchedulerConfig();
  const existing = await hasActiveJob(connection.id, SyncJobType.DAILY_ACCOUNT_INSIGHT_SYNC);
  if (existing) return false;
  // If the historical backfill has already reached the floor, we still need to refresh today's window,
  // but not more often than the configured minimum interval.
  return isStale(connection.accountInsightsLastSyncedAt, monthlyPrepAccountInsightsMinIntervalMs, now);
}

async function isRecentPostInsightRefreshDue(connectionId: string, now: Date) {
  const { monthlyPrepRecentPostInsightMaxAgeMs } = getSchedulerConfig();
  const { recentPostRefreshDays } = getHistoricalBackfillConfig();
  const existing = await hasActiveJob(connectionId, SyncJobType.RECENT_POST_INSIGHT_REFRESH);
  if (existing) return false;
  const windowStart = new Date(now.valueOf() - recentPostRefreshDays * 24 * 60 * 60 * 1000);
  const staleBefore = new Date(now.valueOf() - monthlyPrepRecentPostInsightMaxAgeMs);
  const staleCount = await db.socialPost.count({
    where: {
      connectionId,
      publishedAt: { gte: windowStart, lte: now },
      OR: [{ lastInsightRefreshAt: null }, { lastInsightRefreshAt: { lt: staleBefore } }],
    },
  });
  return staleCount > 0;
}

/** Continuously prepares the current calendar month and prioritizes the previous month for closeout once
 * the month has ended. Near month-end, current-month jobs are boosted so the report is almost ready
 * before the month closes. The scheduler checks every 15 minutes but only enqueues work that is actually
 * missing or stale; active jobs are deduplicated, and Meta cooldowns/holds are respected. */
export async function runDueMonthlyReportPreparation() {
  const { monthlyReportPrepIntervalMs, monthEndPriorityBoostFinalDays } = getSchedulerConfig();
  if (!(await claimMonthlyReportPrepWindow(monthlyReportPrepIntervalMs))) return null;

  const connections = await db.socialConnection.findMany({
    where: { platform: Platform.INSTAGRAM },
    select: {
      id: true,
      lastIncrementalSyncAt: true,
      accountInsightsLastSyncedAt: true,
      accountInsightsBackfillCompletedAt: true,
    },
  });
  const now = new Date();
  const runAfter = await nextInstagramJobRunAfter();
  const currentMonthPriority = isLastDaysOfMonth(now, monthEndPriorityBoostFinalDays)
    ? JobPriority.MONTH_END_PREPARATION + 10
    : JobPriority.MONTH_END_PREPARATION;

  const jobs = [];
  for (const connection of connections) {
    // P0: close out the previous calendar month once it has ended and only if it still needs work.
    const previousMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    const previousMonth = monthPeriodUTC(previousMonthStart);
    if (isMonthFinalized(previousMonth.periodEnd, now) && (await isMonthEndCloseoutDue(connection.id, now))) {
      jobs.push(await enqueueJob(connection.id, SyncJobType.MONTH_END_CLOSEOUT, JobPriority.MONTH_END_CLOSEOUT, runAfter ?? undefined));
    }

    // P1: keep the current month continuously in sync, but only enqueue each job type when its data is
    // actually stale or missing. This prevents the 15-minute scheduler from creating an endless stream
    // of fresh Meta API calls when the client is already up to date.
    if (await isIncrementalSyncDue(connection, now)) {
      jobs.push(await enqueueJob(connection.id, SyncJobType.INCREMENTAL_MEDIA_SYNC, currentMonthPriority, runAfter ?? undefined));
    }
    if (await isDailyAccountInsightSyncDue(connection, now)) {
      jobs.push(await enqueueJob(connection.id, SyncJobType.DAILY_ACCOUNT_INSIGHT_SYNC, currentMonthPriority, runAfter ?? undefined));
    }
    if (await isRecentPostInsightRefreshDue(connection.id, now)) {
      jobs.push(await enqueueJob(connection.id, SyncJobType.RECENT_POST_INSIGHT_REFRESH, currentMonthPriority, runAfter ?? undefined));
    }
  }

  logEvent("sync.monthly_prep.triggered", { connections: connections.length, jobs: jobs.filter(Boolean).length });
  return jobs.filter(Boolean);
}

async function enqueueReportPeriodCloseout(
  connectionId: string,
  periodStart: Date,
  periodEnd: Date,
  priority: number,
  runAfter?: Date,
) {
  const payload = { periodStart: periodStart.toISOString(), periodEnd: periodEnd.toISOString() };
  const existing = await db.syncJob.findFirst({
    where: {
      connectionId,
      type: SyncJobType.REPORT_PERIOD_CLOSEOUT,
      status: { in: [SyncJobStatus.QUEUED, SyncJobStatus.RUNNING] },
      payload: { equals: payload },
    },
  });
  if (existing) return existing;
  return enqueueJob(connectionId, SyncJobType.REPORT_PERIOD_CLOSEOUT, priority, runAfter, payload);
}

/** P0 enqueue for an explicitly opened report period. Does not run a full historical resync; it only
 * enqueues a targeted closeout job for the requested period if that period still has missing final data.
 * If the period is already complete or an identical job is already queued/running, no new job is created. */
export async function prioritizeReportPeriod(clientId: string, periodStart: Date, periodEnd: Date, now: Date = new Date()) {
  const connections = await db.socialConnection.findMany({
    where: { clientId, platform: Platform.INSTAGRAM },
    select: { id: true },
  });
  const runAfter = await nextInstagramJobRunAfter();
  const jobs = [];
  for (const connection of connections) {
    const due = await isReportPeriodCloseoutDue(connection.id, periodStart, periodEnd, now);
    if (due) {
      jobs.push(
        await enqueueReportPeriodCloseout(connection.id, periodStart, periodEnd, JobPriority.MONTH_END_CLOSEOUT, runAfter ?? undefined),
      );
    }
  }
  return jobs.filter(Boolean);
}

const thumbnailBackfillModuleId = "thumbnail_backfill";
const thumbnailBackfillCheckKey = "nextCheckAt";

/** Atomically claims the periodic "is it time to look for posts missing a stored thumbnail" check,
 * the same optimistic-claim shape as claimDailyClientSyncWindow/processNextSyncJob: only one worker
 * process (and only once per configured interval) ever proceeds past this. */
async function claimThumbnailBackfillCheckWindow(intervalMs: number) {
  const now = new Date();
  await db.setting.createMany({ data: [{ moduleId: thumbnailBackfillModuleId, key: thumbnailBackfillCheckKey, value: now.toISOString() }], skipDuplicates: true });
  const claimed = await db.setting.updateMany({
    where: { moduleId: thumbnailBackfillModuleId, key: thumbnailBackfillCheckKey, value: { lte: now.toISOString() } },
    data: { value: new Date(now.getTime() + intervalMs).toISOString() },
  });
  return claimed.count > 0;
}

/** Periodically (see worker.ts) looks across every Instagram connection for posts still missing a
 * permanently-stored thumbnail (src/lib/media-storage.ts) and enqueues one THUMBNAIL_BACKFILL job per
 * connection that needs it — never more than one at a time per connection (enqueueJob already
 * dedupes), and each job only processes a small batch before rescheduling itself, so this never turns
 * into a large burst of Meta requests. New posts already cache their thumbnail during normal
 * upsertPost(); this only ever picks up old posts left over from before that existed, or ones whose
 * persist attempt failed at the time. */
export async function runDueThumbnailBackfill() {
  const { checkIntervalMs } = getThumbnailBackfillConfig();
  if (!(await claimThumbnailBackfillCheckWindow(checkIntervalMs))) return null;

  const connections = await db.socialConnection.findMany({ where: { platform: Platform.INSTAGRAM }, select: { id: true } });
  const jobs = [];
  for (const connection of connections) {
    if (await hasActiveJob(connection.id, SyncJobType.THUMBNAIL_BACKFILL)) continue;
    const { countPendingThumbnails } = await import("@/lib/media-backfill");
    const pending = await countPendingThumbnails(connection.id);
    if (pending > 0) jobs.push(await enqueueJob(connection.id, SyncJobType.THUMBNAIL_BACKFILL, JobPriority.THUMBNAIL_BACKFILL));
  }
  return jobs;
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

/** Periodically scans Instagram connections whose historical backfill is marked PARTIAL or RUNNING
 * but that have no corresponding queued/running SyncJob, and enqueues exactly one continuation job.
 * Reuses the existing enqueue/deduplication logic so duplicates cannot be created; defers to the
 * Meta cooldown/incremental hold via nextInstagramJobRunAfter; and relies on the existing
 * runHistoricalBackfillForSource to resume from the stored cursor/pageIndex. Completed backfills and
 * terminal FAILED backfills are left for explicit admin recovery. */
export async function recoverStalledHistoricalBackfills() {
  const connections = await db.socialConnection.findMany({
    where: {
      platform: Platform.INSTAGRAM,
      OR: [
        { historicalBackfillStatus: { in: [BackfillStatus.PARTIAL, BackfillStatus.RUNNING] } },
        { collaborativeBackfillStatus: { in: [BackfillStatus.PARTIAL, BackfillStatus.RUNNING] } },
      ],
    },
    select: {
      id: true,
      historicalBackfillStatus: true,
      collaborativeBackfillStatus: true,
    },
  });

  const runAfter = await nextInstagramJobRunAfter();
  const enqueued: { connectionId: string; type: SyncJobType }[] = [];

  for (const connection of connections) {
    // Terminal FAILED backfills are left for explicit admin recovery; never auto-resurrect them.
    const ownedIncomplete =
      connection.historicalBackfillStatus !== BackfillStatus.COMPLETED &&
      connection.historicalBackfillStatus !== BackfillStatus.FAILED;
    const collabIncomplete =
      connection.collaborativeBackfillStatus !== BackfillStatus.COMPLETED &&
      connection.collaborativeBackfillStatus !== BackfillStatus.FAILED;

    if (ownedIncomplete) {
      const hasActive = await hasActiveJob(connection.id, SyncJobType.HISTORICAL_MEDIA_BACKFILL);
      if (!hasActive) {
        await enqueueJob(connection.id, SyncJobType.HISTORICAL_MEDIA_BACKFILL, JobPriority.HISTORICAL_BACKFILL, runAfter ?? undefined);
        enqueued.push({ connectionId: connection.id, type: SyncJobType.HISTORICAL_MEDIA_BACKFILL });
      }
    }

    if (collabIncomplete) {
      const hasActive = await hasActiveJob(connection.id, SyncJobType.HISTORICAL_COLLABORATIVE_BACKFILL);
      if (!hasActive) {
        await enqueueJob(connection.id, SyncJobType.HISTORICAL_COLLABORATIVE_BACKFILL, JobPriority.HISTORICAL_BACKFILL, runAfter ?? undefined);
        enqueued.push({ connectionId: connection.id, type: SyncJobType.HISTORICAL_COLLABORATIVE_BACKFILL });
      }
    }
  }

  if (enqueued.length > 0) {
    logEvent("sync.historical.recovery.enqueued", { count: enqueued.length, jobs: enqueued });
  }

  return enqueued;
}

/** Dispatches a job to the right sync function. Instagram-specific job types bypass the generic
 * SocialConnector.syncConnection() interface entirely (so stub connectors for other platforms are
 * completely unaffected by any of this); everything else still goes through the generic connector. */
async function runJob(
  connectionId: string,
  platform: Platform,
  job: { id: string; type: SyncJobType; payload: Prisma.JsonValue | null },
) {
  const { type } = job;
  if (platform === Platform.INSTAGRAM) {
    if (type === SyncJobType.HISTORICAL_MEDIA_BACKFILL) return runHistoricalBackfillChunk(connectionId);
    if (type === SyncJobType.HISTORICAL_COLLABORATIVE_BACKFILL) return runHistoricalCollaborativeBackfillChunk(connectionId);
    if (type === SyncJobType.RECENT_POST_INSIGHT_REFRESH) return runRecentInsightRefresh(connectionId);
    if (type === SyncJobType.INCREMENTAL_MEDIA_SYNC) return runIncrementalSync(connectionId);
    if (type === SyncJobType.DAILY_ACCOUNT_INSIGHT_SYNC) {
      const { runDailyAccountInsightChunk } = await import("@/lib/meta-sync-insights");
      return runDailyAccountInsightChunk(connectionId);
    }
    if (type === SyncJobType.MONTH_END_CLOSEOUT) {
      const result = await runMonthEndCloseout(connectionId);
      return { posts: result.posts, completed: result.completed };
    }
    if (type === SyncJobType.REPORT_PERIOD_CLOSEOUT) {
      const payload = (job.payload ?? {}) as { periodStart?: string; periodEnd?: string };
      if (!payload.periodStart || !payload.periodEnd) {
        throw new Error("REPORT_PERIOD_CLOSEOUT missing periodStart/periodEnd payload");
      }
      const result = await runReportPeriodCloseout(connectionId, new Date(payload.periodStart), new Date(payload.periodEnd));
      return { posts: result.posts, completed: result.completed };
    }
    if (type === SyncJobType.THUMBNAIL_BACKFILL) {
      const { runThumbnailBackfillChunk } = await import("@/lib/media-backfill");
      const result = await runThumbnailBackfillChunk(connectionId);
      return { posts: result.stored };
    }
  }
  const connector = getConnectorForPlatform(platform);
  if (!connector || !connector.isImplemented) throw new Error(`No implemented connector for platform ${platform}.`);
  return connector.syncConnection(connectionId);
}

export async function processNextSyncJob() {
  await recoverStaleJobs();

  // Highest-priority queued job runs first, then the one waiting longest. This implements the
  // MONTHLY-REPORT-FIRST ordering (P0 closeout > P1 current-month prep > P2 normal sync > P3 old
  // historical backfill > P4 thumbnail/maintenance) without starving any queue forever.
  const job = await db.syncJob.findFirst({
    where: { status: SyncJobStatus.QUEUED, runAfter: { lte: new Date() } },
    orderBy: [{ priority: "desc" }, { runAfter: "asc" }, { createdAt: "asc" }],
  });
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
    const result = await runJob(job.connectionId, connection.platform, job);
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
      if (updated?.historicalBackfillStatus === BackfillStatus.PARTIAL) await enqueueJob(job.connectionId, SyncJobType.HISTORICAL_MEDIA_BACKFILL, JobPriority.HISTORICAL_BACKFILL);
    }
    if (job.type === SyncJobType.HISTORICAL_COLLABORATIVE_BACKFILL) {
      const updated = await db.socialConnection.findUnique({ where: { id: job.connectionId }, select: { collaborativeBackfillStatus: true } });
      if (updated?.collaborativeBackfillStatus === BackfillStatus.PARTIAL) await enqueueJob(job.connectionId, SyncJobType.HISTORICAL_COLLABORATIVE_BACKFILL, JobPriority.HISTORICAL_BACKFILL);
    }
    // Month-end closeout keeps re-enqueuing until the targeted month is fully ready.
    if (job.type === SyncJobType.MONTH_END_CLOSEOUT) {
      if (result && typeof result === "object" && "completed" in result && !result.completed) {
        await enqueueJob(job.connectionId, SyncJobType.MONTH_END_CLOSEOUT, JobPriority.MONTH_END_CLOSEOUT);
      }
    }
    // Explicit report-period closeout behaves the same way: re-enqueue with the same target period until complete.
    if (job.type === SyncJobType.REPORT_PERIOD_CLOSEOUT) {
      if (result && typeof result === "object" && "completed" in result && !result.completed) {
        await enqueueJob(job.connectionId, SyncJobType.REPORT_PERIOD_CLOSEOUT, JobPriority.MONTH_END_CLOSEOUT, undefined, job.payload);
      }
    }
    // Thumbnail backfill is deliberately low priority: unlike historical backfill's immediate
    // continuation, its next batch is spaced out by a delay so it never turns into another tight
    // Meta-request loop competing with normal account-insight/media sync.
    if (job.type === SyncJobType.THUMBNAIL_BACKFILL) {
      const { countPendingThumbnails } = await import("@/lib/media-backfill");
      const remaining = await countPendingThumbnails(job.connectionId);
      if (remaining > 0) {
        const { continuationDelayMs } = getThumbnailBackfillConfig();
        await enqueueJob(job.connectionId, SyncJobType.THUMBNAIL_BACKFILL, JobPriority.THUMBNAIL_BACKFILL, new Date(Date.now() + continuationDelayMs));
      }
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
    const maxAttempts = transientHistoricalFailure
      ? Math.max(job.maxAttempts, attempts + 10)
      : Math.min(job.maxAttempts, 5);
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
