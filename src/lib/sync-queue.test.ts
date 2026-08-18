import { beforeEach, describe, expect, it, vi } from "vitest";
import { Platform, SyncJobStatus, SyncJobType } from "@prisma/client";
import { ConnectorError } from "@/lib/connectors";

const mockDb = vi.hoisted(() => ({
  syncJob: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  socialConnection: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    updateMany: vi.fn(),
    update: vi.fn(),
  },
  socialPost: {
    count: vi.fn(),
  },
  syncRun: {
    create: vi.fn(),
    update: vi.fn(),
  },
  setting: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
    deleteMany: vi.fn(),
    createMany: vi.fn(),
    updateMany: vi.fn(),
  },
  $transaction: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));

const mockMediaBackfill = vi.hoisted(() => ({
  runThumbnailBackfillChunk: vi.fn(),
  countPendingThumbnails: vi.fn(),
}));
vi.mock("@/lib/media-backfill", () => mockMediaBackfill);

const mockMetaSync = vi.hoisted(() => ({
  runIncrementalSync: vi.fn(),
  runRecentInsightRefresh: vi.fn(),
  runHistoricalBackfillChunk: vi.fn(),
  runHistoricalCollaborativeBackfillChunk: vi.fn(),
  MetaSyncError: class MetaSyncError extends Error {
    code: string;
    metaCode?: string;
    retryAfterMs?: number;
    constructor(message: string, code: "rate_limited" | "request_failed", metaCode?: string, retryAfterMs?: number) {
      super(message);
      this.code = code;
      this.metaCode = metaCode;
      this.retryAfterMs = retryAfterMs;
    }
  },
}));
vi.mock("@/lib/meta-sync", () => mockMetaSync);

const mockMetaSyncInsights = vi.hoisted(() => ({
  runDailyAccountInsightChunk: vi.fn(),
}));
vi.mock("@/lib/meta-sync-insights", () => mockMetaSyncInsights);

import { processNextSyncJob, runDueThumbnailBackfill } from "@/lib/sync-queue";

function baseJob(overrides: Partial<{ id: string; connectionId: string; type: SyncJobType; attempts: number; maxAttempts: number; runAfter: Date }> = {}) {
  return {
    id: "job-1",
    connectionId: "conn-1",
    type: SyncJobType.INCREMENTAL_MEDIA_SYNC,
    attempts: 0,
    maxAttempts: 5,
    runAfter: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function setupHappyPathMocks(job: ReturnType<typeof baseJob>, connectionOverrides: Record<string, unknown> = {}) {
  mockDb.syncJob.updateMany.mockResolvedValue({ count: 0 }); // recoverStaleJobs, then overridden per-call below
  mockDb.syncJob.findFirst.mockResolvedValue(job);
  mockDb.socialConnection.findUnique.mockResolvedValue({ platform: Platform.INSTAGRAM, ...connectionOverrides });
  mockDb.setting.findUnique.mockResolvedValue(null); // no cooldown, no hold active
  mockDb.socialConnection.updateMany.mockResolvedValue({ count: 1 }); // lock acquired
  mockDb.socialConnection.update.mockResolvedValue({});
  mockDb.syncRun.create.mockResolvedValue({ id: "run-1" });
  mockDb.syncRun.update.mockResolvedValue({});
  mockDb.syncJob.update.mockResolvedValue({});
  mockDb.setting.upsert.mockResolvedValue({});
  mockDb.$transaction.mockImplementation(async (ops: Promise<unknown>[]) => Promise.all(ops));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockMetaSync.runIncrementalSync.mockReset();
  mockMetaSync.runRecentInsightRefresh.mockReset();
  mockMetaSync.runHistoricalBackfillChunk.mockReset();
  mockMetaSync.runHistoricalCollaborativeBackfillChunk.mockReset();
  mockMetaSyncInsights.runDailyAccountInsightChunk.mockReset();
  mockMediaBackfill.runThumbnailBackfillChunk.mockReset();
  mockMediaBackfill.countPendingThumbnails.mockReset();
});

describe("processNextSyncJob retry/maxAttempts behavior", () => {
  it("keeps a historical backfill job retryable beyond 5 attempts on a transient rate-limit failure", async () => {
    const job = baseJob({ type: SyncJobType.HISTORICAL_MEDIA_BACKFILL, attempts: 6, maxAttempts: 5 });
    setupHappyPathMocks(job);
    // First updateMany call is recoverStaleJobs; second is the claim. Return count:1 for the claim specifically.
    mockDb.syncJob.updateMany.mockImplementation(async (args: { data?: Record<string, unknown> }) => {
      if (args?.data?.status === SyncJobStatus.RUNNING) return { count: 1 };
      return { count: 0 };
    });
    mockMetaSync.runHistoricalBackfillChunk.mockRejectedValue(new ConnectorError("rate limited", "rate_limited"));

    const result = await processNextSyncJob();

    expect(result).toEqual({ id: job.id, status: "retrying" });
    const updateArgs = mockDb.syncJob.update.mock.calls.find(([args]) => args.data?.maxAttempts !== undefined)?.[0];
    expect(updateArgs.data.status).toBe(SyncJobStatus.QUEUED);
    expect(updateArgs.data.maxAttempts).toBeGreaterThan(6);
  });

  it("fails INCREMENTAL_MEDIA_SYNC after 5 retryable attempts instead of retrying forever", async () => {
    const job = baseJob({ type: SyncJobType.INCREMENTAL_MEDIA_SYNC, attempts: 4, maxAttempts: 5 });
    setupHappyPathMocks(job);
    mockDb.syncJob.updateMany.mockImplementation(async (args: { data?: Record<string, unknown> }) => {
      if (args?.data?.status === SyncJobStatus.RUNNING) return { count: 1 };
      return { count: 0 };
    });
    mockMetaSync.runIncrementalSync.mockRejectedValue(new ConnectorError("rate limited", "rate_limited"));

    const result = await processNextSyncJob();

    expect(result).toEqual({ id: job.id, status: "failed" });
    const updateArgs = mockDb.syncJob.update.mock.calls.find(([args]) => args.data?.maxAttempts !== undefined)?.[0];
    expect(updateArgs.data.status).toBe(SyncJobStatus.FAILED);
    expect(updateArgs.data.maxAttempts).toBe(5);
  });

  it("fails DAILY_ACCOUNT_INSIGHT_SYNC after 5 retryable attempts instead of retrying forever", async () => {
    const job = baseJob({ type: SyncJobType.DAILY_ACCOUNT_INSIGHT_SYNC, attempts: 4, maxAttempts: 5 });
    setupHappyPathMocks(job);
    mockDb.syncJob.updateMany.mockImplementation(async (args: { data?: Record<string, unknown> }) => {
      if (args?.data?.status === SyncJobStatus.RUNNING) return { count: 1 };
      return { count: 0 };
    });
    mockMetaSyncInsights.runDailyAccountInsightChunk.mockRejectedValue(new ConnectorError("rate limited", "rate_limited"));

    const result = await processNextSyncJob();

    expect(result).toEqual({ id: job.id, status: "failed" });
    const updateArgs = mockDb.syncJob.update.mock.calls.find(([args]) => args.data?.maxAttempts !== undefined)?.[0];
    expect(updateArgs.data.status).toBe(SyncJobStatus.FAILED);
    expect(updateArgs.data.maxAttempts).toBe(5);
  });

  it("does not increase maxAttempts beyond 5 for a rate-limited normal (non-historical) job", async () => {
    const job = baseJob({ type: SyncJobType.INCREMENTAL_MEDIA_SYNC, attempts: 1, maxAttempts: 5 });
    setupHappyPathMocks(job);
    mockDb.syncJob.updateMany.mockImplementation(async (args: { data?: Record<string, unknown> }) => {
      if (args?.data?.status === SyncJobStatus.RUNNING) return { count: 1 };
      return { count: 0 };
    });
    mockMetaSync.runIncrementalSync.mockRejectedValue(new ConnectorError("rate limited", "rate_limited"));

    const result = await processNextSyncJob();

    expect(result).toEqual({ id: job.id, status: "retrying" });
    const updateArgs = mockDb.syncJob.update.mock.calls.find(([args]) => args.data?.maxAttempts !== undefined)?.[0];
    expect(updateArgs.data.maxAttempts).toBe(5);
    expect(updateArgs.data.maxAttempts).toBeLessThanOrEqual(5);
  });

  it("postpones a queued Instagram job while the Meta app cooldown is active, without running it", async () => {
    const job = baseJob({ type: SyncJobType.INCREMENTAL_MEDIA_SYNC, runAfter: new Date("2026-01-01T00:00:00.000Z") });
    mockDb.syncJob.findFirst.mockResolvedValue(job);
    mockDb.socialConnection.findUnique.mockResolvedValue({ platform: Platform.INSTAGRAM });
    const cooldownUntil = new Date("2026-01-01T01:00:00.000Z");
    mockDb.setting.findUnique.mockImplementation(async (args: { where: { moduleId_key: { moduleId: string; key: string } } }) => {
      if (args.where.moduleId_key.moduleId === "meta_cooldown" && args.where.moduleId_key.key === "cooldown_until") {
        return { value: cooldownUntil.toISOString() };
      }
      return null;
    });
    mockDb.syncJob.updateMany.mockResolvedValue({ count: 0 }); // recoverStaleJobs
    mockDb.syncJob.update.mockResolvedValue({});

    const result = await processNextSyncJob();

    expect(result).toBeNull();
    expect(mockDb.syncJob.update).toHaveBeenCalledWith({ where: { id: job.id }, data: { runAfter: cooldownUntil, lockedAt: null } });
    expect(mockMetaSync.runIncrementalSync).not.toHaveBeenCalled();
  });
});

describe("processNextSyncJob THUMBNAIL_BACKFILL handling", () => {
  it("dispatches to runThumbnailBackfillChunk and schedules a delayed continuation when posts remain", async () => {
    const job = baseJob({ type: SyncJobType.THUMBNAIL_BACKFILL, attempts: 0, maxAttempts: 5 });
    setupHappyPathMocks(job);
    mockDb.syncJob.updateMany.mockImplementation(async (args: { data?: Record<string, unknown> }) => {
      if (args?.data?.status === SyncJobStatus.RUNNING) return { count: 1 };
      return { count: 0 };
    });
    // The initial claim query (status: QUEUED) must still resolve to `job`; the later hasActiveJob
    // check for the continuation enqueue (status: QUEUED/RUNNING) must resolve to null (no active job).
    mockDb.syncJob.findFirst.mockImplementation(async ({ where }: { where: { status?: unknown } }) =>
      where.status === SyncJobStatus.QUEUED ? job : null,
    );
    mockDb.syncJob.create.mockResolvedValue({ id: "job-2" });
    mockMediaBackfill.runThumbnailBackfillChunk.mockResolvedValue({ stored: 5, skipped: 0, remaining: 12 });
    mockMediaBackfill.countPendingThumbnails.mockResolvedValue(12);

    const result = await processNextSyncJob();

    expect(mockMediaBackfill.runThumbnailBackfillChunk).toHaveBeenCalledWith("conn-1");
    expect(result).toEqual({ id: job.id, status: "succeeded", posts: 5 });
    // A continuation job is enqueued, delayed rather than immediate, since remaining > 0.
    expect(mockDb.syncJob.create).toHaveBeenCalledTimes(1);
    const createArgs = mockDb.syncJob.create.mock.calls[0][0];
    expect(createArgs.data.connectionId).toBe("conn-1");
    expect(createArgs.data.type).toBe(SyncJobType.THUMBNAIL_BACKFILL);
    expect(createArgs.data.runAfter.valueOf()).toBeGreaterThan(Date.now());
  });

  it("does not enqueue a continuation once no posts remain", async () => {
    const job = baseJob({ type: SyncJobType.THUMBNAIL_BACKFILL, attempts: 0, maxAttempts: 5 });
    setupHappyPathMocks(job);
    mockDb.syncJob.updateMany.mockImplementation(async (args: { data?: Record<string, unknown> }) => {
      if (args?.data?.status === SyncJobStatus.RUNNING) return { count: 1 };
      return { count: 0 };
    });
    mockMediaBackfill.runThumbnailBackfillChunk.mockResolvedValue({ stored: 3, skipped: 0, remaining: 0 });
    mockMediaBackfill.countPendingThumbnails.mockResolvedValue(0);

    const result = await processNextSyncJob();

    expect(result).toEqual({ id: job.id, status: "succeeded", posts: 3 });
    expect(mockDb.syncJob.create).not.toHaveBeenCalled();
  });

  it("activates the shared Meta cooldown and stops (reschedules, doesn't loop) when the chunk hits the app-wide rate limit", async () => {
    const job = baseJob({ type: SyncJobType.THUMBNAIL_BACKFILL, attempts: 0, maxAttempts: 5 });
    setupHappyPathMocks(job);
    mockDb.syncJob.updateMany.mockImplementation(async (args: { data?: Record<string, unknown> }) => {
      if (args?.data?.status === SyncJobStatus.RUNNING) return { count: 1 };
      return { count: 0 };
    });
    mockMediaBackfill.runThumbnailBackfillChunk.mockRejectedValue(new ConnectorError("(#4) Application request limit reached", "rate_limited"));

    const result = await processNextSyncJob();

    expect(result).toEqual({ id: job.id, status: "retrying" });
    // setMetaAppCooldownUntil was invoked (via setSetting -> setting.upsert for the cooldown_until key).
    const cooldownUpsert = mockDb.setting.upsert.mock.calls.find(([args]) => args.where.moduleId_key.key === "cooldown_until");
    expect(cooldownUpsert).toBeTruthy();
    // The failed job itself is rescheduled for later rather than retried immediately in this run.
    const updateArgs = mockDb.syncJob.update.mock.calls.find(([args]) => args.data?.maxAttempts !== undefined)?.[0];
    expect(updateArgs.data.status).toBe(SyncJobStatus.QUEUED);
    expect(updateArgs.data.runAfter.valueOf()).toBeGreaterThan(Date.now());
    expect(mockMediaBackfill.countPendingThumbnails).not.toHaveBeenCalled();
  });
});

describe("runDueThumbnailBackfill", () => {
  it("enqueues a job for every Instagram connection with pending thumbnails, skipping ones already queued or with nothing pending", async () => {
    mockDb.setting.createMany.mockResolvedValue({});
    mockDb.setting.updateMany.mockResolvedValue({ count: 1 }); // claims the periodic check window
    mockDb.socialConnection.findMany.mockResolvedValue([
      { id: "conn-a" }, // has pending thumbnails, no active job -> enqueue
      { id: "conn-b" }, // already has an active job -> skip
      { id: "conn-c" }, // no pending thumbnails -> skip
    ]);
    mockDb.syncJob.findFirst.mockImplementation(async ({ where }: { where: { connectionId: string } }) =>
      where.connectionId === "conn-b" ? { id: "existing-job" } : null,
    );
    mockDb.syncJob.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "new-job", ...data }));
    mockMediaBackfill.countPendingThumbnails.mockImplementation(async (connectionId: string) => (connectionId === "conn-c" ? 0 : 8));

    const jobs = await runDueThumbnailBackfill();

    expect(jobs).toHaveLength(1);
    expect(mockDb.syncJob.create).toHaveBeenCalledTimes(1);
    const createArgs = mockDb.syncJob.create.mock.calls[0][0];
    expect(createArgs.data.connectionId).toBe("conn-a");
    expect(createArgs.data.type).toBe(SyncJobType.THUMBNAIL_BACKFILL);
  });

  it("does nothing when the periodic check window has not been claimed yet", async () => {
    mockDb.setting.createMany.mockResolvedValue({});
    mockDb.setting.updateMany.mockResolvedValue({ count: 0 }); // another worker/tick already claimed it

    const result = await runDueThumbnailBackfill();

    expect(result).toBeNull();
    expect(mockDb.socialConnection.findMany).not.toHaveBeenCalled();
  });
});
