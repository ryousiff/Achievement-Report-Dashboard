import { beforeEach, describe, expect, it, vi } from "vitest";
import { Platform, SyncJobStatus, SyncJobType } from "@prisma/client";
import { ConnectorError } from "@/lib/connectors";

const mockDb = vi.hoisted(() => ({
  syncJob: {
    findFirst: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  socialConnection: {
    findUnique: vi.fn(),
    updateMany: vi.fn(),
    update: vi.fn(),
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

import { processNextSyncJob } from "@/lib/sync-queue";

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
