import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BackfillStatus, Platform, Prisma, SyncJobStatus, SyncJobType } from "@prisma/client";
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

const mockMonthEndCloseout = vi.hoisted(() => ({
  runMonthEndCloseout: vi.fn(),
  runReportPeriodCloseout: vi.fn(),
  isLastDaysOfMonth: vi.fn(),
  isMonthEndCloseoutDue: vi.fn(),
  isReportPeriodCloseoutDue: vi.fn(),
}));
vi.mock("@/lib/month-end-closeout", () => mockMonthEndCloseout);

import { prioritizeReportPeriod, processNextSyncJob, recoverStalledHistoricalBackfills, runDueMonthlyReportPreparation, runDueThumbnailBackfill } from "@/lib/sync-queue";

function baseJob(overrides: Partial<{ id: string; connectionId: string; type: SyncJobType; attempts: number; maxAttempts: number; runAfter: Date; priority: number; payload: Prisma.JsonValue }> = {}) {
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
  mockMonthEndCloseout.runMonthEndCloseout.mockReset();
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

describe("recoverStalledHistoricalBackfills", () => {
  it("enqueues exactly one continuation job for a stalled PARTIAL owned backfill", async () => {
    mockDb.socialConnection.findMany.mockResolvedValue([
      { id: "conn-a", historicalBackfillStatus: BackfillStatus.PARTIAL, collaborativeBackfillStatus: BackfillStatus.COMPLETED },
    ]);
    mockDb.syncJob.findFirst.mockResolvedValue(null); // no active historical job
    mockDb.syncJob.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "new-job", ...data }));
    mockDb.setting.findUnique.mockResolvedValue(null);

    const jobs = await recoverStalledHistoricalBackfills();

    expect(jobs).toHaveLength(1);
    expect(mockDb.syncJob.create).toHaveBeenCalledTimes(1);
    const createArgs = mockDb.syncJob.create.mock.calls[0][0];
    expect(createArgs.data.connectionId).toBe("conn-a");
    expect(createArgs.data.type).toBe(SyncJobType.HISTORICAL_MEDIA_BACKFILL);
  });

  it("enqueues exactly one continuation job for a stalled RUNNING owned backfill with no active job", async () => {
    mockDb.socialConnection.findMany.mockResolvedValue([
      { id: "conn-b", historicalBackfillStatus: BackfillStatus.RUNNING, collaborativeBackfillStatus: BackfillStatus.COMPLETED },
    ]);
    mockDb.syncJob.findFirst.mockResolvedValue(null);
    mockDb.syncJob.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "new-job", ...data }));
    mockDb.setting.findUnique.mockResolvedValue(null);

    const jobs = await recoverStalledHistoricalBackfills();

    expect(jobs).toHaveLength(1);
    const createArgs = mockDb.syncJob.create.mock.calls[0][0];
    expect(createArgs.data.connectionId).toBe("conn-b");
    expect(createArgs.data.type).toBe(SyncJobType.HISTORICAL_MEDIA_BACKFILL);
  });

  it("enqueues a continuation job for a stalled PARTIAL collaborative backfill", async () => {
    mockDb.socialConnection.findMany.mockResolvedValue([
      { id: "conn-c", historicalBackfillStatus: BackfillStatus.COMPLETED, collaborativeBackfillStatus: BackfillStatus.PARTIAL },
    ]);
    mockDb.syncJob.findFirst.mockResolvedValue(null);
    mockDb.syncJob.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "new-job", ...data }));
    mockDb.setting.findUnique.mockResolvedValue(null);

    const jobs = await recoverStalledHistoricalBackfills();

    expect(jobs).toHaveLength(1);
    const createArgs = mockDb.syncJob.create.mock.calls[0][0];
    expect(createArgs.data.connectionId).toBe("conn-c");
    expect(createArgs.data.type).toBe(SyncJobType.HISTORICAL_COLLABORATIVE_BACKFILL);
  });

  it("does not create duplicate jobs when an active job already exists", async () => {
    mockDb.socialConnection.findMany.mockResolvedValue([
      { id: "conn-d", historicalBackfillStatus: BackfillStatus.PARTIAL, collaborativeBackfillStatus: BackfillStatus.PARTIAL },
    ]);
    // hasActiveJob returns truthy for every call, so both sources see an existing job.
    mockDb.syncJob.findFirst.mockResolvedValue({ id: "existing-job" });

    const jobs = await recoverStalledHistoricalBackfills();

    expect(jobs).toHaveLength(0);
    expect(mockDb.syncJob.create).not.toHaveBeenCalled();
  });

  it("does not re-enqueue completed backfills", async () => {
    mockDb.socialConnection.findMany.mockResolvedValue([
      { id: "conn-e", historicalBackfillStatus: BackfillStatus.COMPLETED, collaborativeBackfillStatus: BackfillStatus.COMPLETED },
    ]);

    const jobs = await recoverStalledHistoricalBackfills();

    expect(jobs).toHaveLength(0);
    expect(mockDb.syncJob.create).not.toHaveBeenCalled();
    expect(mockDb.syncJob.findFirst).not.toHaveBeenCalled();
  });

  it("does not re-enqueue terminal FAILED backfills", async () => {
    mockDb.socialConnection.findMany.mockResolvedValue([
      { id: "conn-f", historicalBackfillStatus: BackfillStatus.FAILED, collaborativeBackfillStatus: BackfillStatus.FAILED },
    ]);

    const jobs = await recoverStalledHistoricalBackfills();

    expect(jobs).toHaveLength(0);
    expect(mockDb.syncJob.create).not.toHaveBeenCalled();
    expect(mockDb.syncJob.findFirst).not.toHaveBeenCalled();
  });

  it("defers recovered jobs until the Meta app cooldown expires", async () => {
    const cooldownUntil = new Date("2026-08-24T12:00:00.000Z");
    mockDb.socialConnection.findMany.mockResolvedValue([
      { id: "conn-g", historicalBackfillStatus: BackfillStatus.PARTIAL, collaborativeBackfillStatus: BackfillStatus.COMPLETED },
    ]);
    mockDb.syncJob.findFirst.mockResolvedValue(null);
    mockDb.syncJob.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "new-job", ...data }));
    mockDb.setting.findUnique.mockImplementation(async (args: { where: { moduleId_key: { moduleId: string; key: string } } }) => {
      if (args.where.moduleId_key.moduleId === "meta_cooldown" && args.where.moduleId_key.key === "cooldown_until") {
        return { value: cooldownUntil.toISOString() };
      }
      return null;
    });

    const jobs = await recoverStalledHistoricalBackfills();

    expect(jobs).toHaveLength(1);
    const createArgs = mockDb.syncJob.create.mock.calls[0][0];
    expect(createArgs.data.runAfter).toEqual(cooldownUntil);
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

describe("runDueMonthlyReportPreparation", () => {
  beforeEach(() => {
    mockDb.setting.createMany.mockResolvedValue({});
    mockDb.setting.updateMany.mockResolvedValue({ count: 1 });
    mockDb.syncJob.findFirst.mockResolvedValue(null);
    mockDb.syncJob.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "new-job", ...data }));
    mockDb.setting.findUnique.mockResolvedValue(null);
    mockDb.socialPost.count.mockResolvedValue(0);
    mockMonthEndCloseout.isLastDaysOfMonth.mockReturnValue(false);
    mockMonthEndCloseout.isMonthEndCloseoutDue.mockResolvedValue(false);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("enqueues current-month sync jobs for every Instagram connection", async () => {
    mockDb.socialConnection.findMany.mockResolvedValue([{ id: "conn-a" }, { id: "conn-b" }]);
    mockDb.socialPost.count.mockResolvedValue(5);

    const jobs = await runDueMonthlyReportPreparation();
    expect(jobs).not.toBeNull();

    expect(jobs!.length).toBeGreaterThan(0);
    const types = jobs!.map((job: { type: SyncJobType }) => job.type);
    expect(types).toContain(SyncJobType.DAILY_ACCOUNT_INSIGHT_SYNC);
    expect(types).toContain(SyncJobType.INCREMENTAL_MEDIA_SYNC);
    expect(types).toContain(SyncJobType.RECENT_POST_INSIGHT_REFRESH);
  });

  it("enqueues a month-end closeout job for the previous finalized month", async () => {
    mockMonthEndCloseout.isMonthEndCloseoutDue.mockResolvedValue(true);
    mockDb.socialConnection.findMany.mockResolvedValue([{ id: "conn-a" }]);

    const jobs = await runDueMonthlyReportPreparation();
    expect(jobs).not.toBeNull();

    expect(jobs!.some((job: { type: SyncJobType }) => job.type === SyncJobType.MONTH_END_CLOSEOUT)).toBe(true);
  });

  it("boosts current-month job priority during the final days of the month", async () => {
    mockMonthEndCloseout.isLastDaysOfMonth.mockReturnValue(true);
    mockDb.socialConnection.findMany.mockResolvedValue([{ id: "conn-a" }]);

    await runDueMonthlyReportPreparation();

    const created = mockDb.syncJob.create.mock.calls.map((call) => (call[0] as { data: { type: SyncJobType; priority: number } }).data);
    const daily = created.find((job) => job.type === SyncJobType.DAILY_ACCOUNT_INSIGHT_SYNC);
    expect(daily?.priority).toBeGreaterThan(80);
  });

  it("does nothing when the periodic check window is already claimed", async () => {
    mockDb.setting.updateMany.mockResolvedValue({ count: 0 });
    mockDb.socialConnection.findMany.mockResolvedValue([{ id: "conn-a" }]);

    const result = await runDueMonthlyReportPreparation();

    expect(result).toBeNull();
    expect(mockDb.syncJob.create).not.toHaveBeenCalled();
  });

  it("does not enqueue fresh Meta work when current-month data is already sufficiently fresh", async () => {
    const now = new Date();
    mockDb.socialConnection.findMany.mockResolvedValue([
      {
        id: "conn-a",
        lastIncrementalSyncAt: new Date(now.valueOf() - 30 * 60 * 1000),
        accountInsightsLastSyncedAt: new Date(now.valueOf() - 3 * 60 * 60 * 1000),
        accountInsightsBackfillCompletedAt: new Date("2025-01-01T00:00:00.000Z"),
      },
    ]);
    mockDb.socialPost.count.mockResolvedValue(0);

    await runDueMonthlyReportPreparation();

    expect(mockDb.syncJob.create).not.toHaveBeenCalled();
  });
});

describe("prioritizeReportPeriod", () => {
  beforeEach(() => {
    mockDb.socialConnection.findMany.mockResolvedValue([{ id: "conn-a" }]);
    mockDb.syncJob.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "new-job", ...data }));
    mockMonthEndCloseout.isReportPeriodCloseoutDue.mockResolvedValue(true);
  });

  it("enqueues a REPORT_PERIOD_CLOSEOUT job at P0 for an explicitly selected older period", async () => {
    await prioritizeReportPeriod("client-1", new Date("2026-06-01T00:00:00.000Z"), new Date("2026-06-30T00:00:00.000Z"));

    expect(mockDb.syncJob.create).toHaveBeenCalledTimes(1);
    const createArgs = mockDb.syncJob.create.mock.calls[0][0];
    expect(createArgs.data.type).toBe(SyncJobType.REPORT_PERIOD_CLOSEOUT);
    expect(createArgs.data.priority).toBeGreaterThanOrEqual(100);
    expect(createArgs.data.payload).toEqual({
      periodStart: "2026-06-01T00:00:00.000Z",
      periodEnd: "2026-06-30T00:00:00.000Z",
    });
  });

  it("does not enqueue a duplicate job for the same period", async () => {
    mockDb.syncJob.findFirst.mockResolvedValue({ id: "existing-period-job" });

    await prioritizeReportPeriod("client-1", new Date("2026-06-01T00:00:00.000Z"), new Date("2026-06-30T00:00:00.000Z"));

    expect(mockDb.syncJob.create).not.toHaveBeenCalled();
  });

  it("does nothing when the period is already complete", async () => {
    mockMonthEndCloseout.isReportPeriodCloseoutDue.mockResolvedValue(false);

    await prioritizeReportPeriod("client-1", new Date("2026-06-01T00:00:00.000Z"), new Date("2026-06-30T00:00:00.000Z"));

    expect(mockDb.syncJob.create).not.toHaveBeenCalled();
  });
});

describe("processNextSyncJob priority ordering", () => {
  it("selects queued jobs by descending priority", async () => {
    setupHappyPathMocks(baseJob({ id: "job-low", type: SyncJobType.THUMBNAIL_BACKFILL, priority: 10 }));
    mockDb.syncJob.updateMany.mockImplementation(async (args: { data?: Record<string, unknown> }) => {
      if (args?.data?.status === SyncJobStatus.RUNNING) return { count: 1 };
      return { count: 0 };
    });
    mockMediaBackfill.runThumbnailBackfillChunk.mockResolvedValue({ stored: 1, skipped: 0, remaining: 0 });

    await processNextSyncJob();

    const findArgs = mockDb.syncJob.findFirst.mock.calls[0]?.[0];
    expect(findArgs.orderBy).toEqual([
      { priority: "desc" },
      { runAfter: "asc" },
      { createdAt: "asc" },
    ]);
  });

  it("runs a MONTH_END_CLOSEOUT job before a THUMBNAIL_BACKFILL job", async () => {
    const closeoutJob = baseJob({ id: "job-closeout", type: SyncJobType.MONTH_END_CLOSEOUT, priority: 100 });
    const thumbnailJob = baseJob({ id: "job-thumb", type: SyncJobType.THUMBNAIL_BACKFILL, priority: 10 });
    // Return the closeout job first, simulating the priority ordering.
    let callIndex = 0;
    mockDb.syncJob.findFirst.mockImplementation(() => {
      callIndex += 1;
      return callIndex === 1 ? closeoutJob : thumbnailJob;
    });
    setupHappyPathMocks(closeoutJob);
    mockDb.syncJob.updateMany.mockImplementation(async (args: { data?: Record<string, unknown> }) => {
      if (args?.data?.status === SyncJobStatus.RUNNING) return { count: 1 };
      return { count: 0 };
    });
    mockMonthEndCloseout.runMonthEndCloseout.mockResolvedValue({ posts: 0, completed: true });

    const result = await processNextSyncJob();

    expect(mockMonthEndCloseout.runMonthEndCloseout).toHaveBeenCalledWith("conn-1");
    expect(result).toEqual({ id: "job-closeout", status: "succeeded", posts: 0 });
  });

  it("re-enqueues an incomplete MONTH_END_CLOSEOUT with a delay instead of looping immediately", async () => {
    const closeoutJob = baseJob({ id: "job-closeout", type: SyncJobType.MONTH_END_CLOSEOUT, priority: 100 });
    setupHappyPathMocks(closeoutJob);
    // The "has active job" dedupe check must see no active job before creating the continuation.
    mockDb.syncJob.findFirst.mockImplementation(async ({ where }: { where: { status?: unknown } }) =>
      where.status === SyncJobStatus.QUEUED ? closeoutJob : null,
    );
    mockDb.syncJob.updateMany.mockImplementation(async (args: { data?: Record<string, unknown> }) => {
      if (args?.data?.status === SyncJobStatus.RUNNING) return { count: 1 };
      return { count: 0 };
    });
    mockDb.syncJob.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "job-closeout-2", ...data }));
    mockMonthEndCloseout.runMonthEndCloseout.mockResolvedValue({ posts: 15, completed: false });

    const result = await processNextSyncJob();

    expect(result).toEqual({ id: "job-closeout", status: "succeeded", posts: 15 });
    expect(mockDb.syncJob.create).toHaveBeenCalledTimes(1);
    const createArgs = mockDb.syncJob.create.mock.calls[0][0];
    expect(createArgs.data.type).toBe(SyncJobType.MONTH_END_CLOSEOUT);
    expect(createArgs.data.priority).toBeGreaterThanOrEqual(100);
    expect(createArgs.data.runAfter.valueOf()).toBeGreaterThan(Date.now());
  });

  it("preserves P0 priority and respects Meta cooldown when re-enqueueing an incomplete REPORT_PERIOD_CLOSEOUT", async () => {
    const cooldownUntil = new Date(Date.now() + 10 * 60 * 1000);
    const closeoutJob = baseJob({
      id: "job-closeout",
      type: SyncJobType.REPORT_PERIOD_CLOSEOUT,
      priority: 100,
      runAfter: cooldownUntil, // already past the active cooldown so the job can run
      payload: { periodStart: "2026-06-01T00:00:00.000Z", periodEnd: "2026-06-30T23:59:59.999Z" },
    });
    setupHappyPathMocks(closeoutJob);
    // The "has active job" dedupe check must see no active job before creating the continuation.
    mockDb.syncJob.findFirst.mockImplementation(async ({ where }: { where: { status?: unknown } }) =>
      where.status === SyncJobStatus.QUEUED ? closeoutJob : null,
    );
    mockDb.syncJob.updateMany.mockImplementation(async (args: { data?: Record<string, unknown> }) => {
      if (args?.data?.status === SyncJobStatus.RUNNING) return { count: 1 };
      return { count: 0 };
    });
    mockDb.syncJob.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "job-closeout-2", ...data }));
    mockDb.setting.findUnique.mockImplementation(async (args: { where: { moduleId_key: { moduleId: string; key: string } } }) => {
      if (args.where.moduleId_key.moduleId === "meta_cooldown" && args.where.moduleId_key.key === "cooldown_until") {
        return { value: cooldownUntil.toISOString() };
      }
      return null;
    });
    mockMonthEndCloseout.runReportPeriodCloseout.mockResolvedValue({ posts: 0, completed: false });

    const result = await processNextSyncJob();

    expect(result).toEqual({ id: "job-closeout", status: "succeeded", posts: 0 });
    expect(mockDb.syncJob.create).toHaveBeenCalledTimes(1);
    const createArgs = mockDb.syncJob.create.mock.calls[0][0];
    expect(createArgs.data.type).toBe(SyncJobType.REPORT_PERIOD_CLOSEOUT);
    expect(createArgs.data.priority).toBeGreaterThanOrEqual(100);
    expect(createArgs.data.runAfter.valueOf()).toBeGreaterThanOrEqual(cooldownUntil.valueOf());
  });
});
