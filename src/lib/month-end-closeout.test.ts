import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InsightPeriodType, Platform } from "@prisma/client";
import { runMonthEndCloseout, runReportPeriodCloseout, isLastDaysOfMonth } from "@/lib/month-end-closeout";

const mockDb = vi.hoisted(() => ({
  socialConnection: { findUnique: vi.fn() },
  socialInsightSnapshot: { findMany: vi.fn(), count: vi.fn() },
  socialPost: { findMany: vi.fn(), count: vi.fn() },
}));

const mockMetaSync = vi.hoisted(() => ({
  postInsights: vi.fn(),
  upsertPost: vi.fn(),
}));

const mockReportData = vi.hoisted(() => ({
  fetchAndStoreDailyFollowerMovement: vi.fn(),
}));

const mockMetaSyncInsights = vi.hoisted(() => ({
  fetchCompletedMonthTotals: vi.fn(),
  storeCompletedMonthTotals: vi.fn(),
  fetchAndStoreAccountInsight: vi.fn(),
  completedMonthsWithinLookback: vi.fn(),
}));

const mockTokenEncryption = vi.hoisted(() => ({
  decryptToken: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/meta-sync", () => mockMetaSync);
vi.mock("@/lib/meta-sync-insights", () => mockMetaSyncInsights);
vi.mock("@/lib/report-data", () => mockReportData);
vi.mock("@/lib/token-encryption", () => mockTokenEncryption);
vi.mock("@/lib/observability", () => ({ logEvent: vi.fn(), logError: vi.fn() }));
vi.mock("@/lib/post-metric-snapshots", () => ({
  monthPeriodUTC: (date: Date) => {
    const periodStart = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
    const periodEnd = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) - 1);
    return { periodStart, periodEnd };
  },
  isMonthFinalized: (periodEnd: Date, now: Date) => periodEnd.valueOf() < now.valueOf(),
  persistPostMetricSnapshot: vi.fn(),
}));
vi.mock("@/lib/env", () => ({
  getHistoricalBackfillConfig: () => ({
    months: 15,
    accountInsightMaxLookbackDays: 450,
    accountInsightChunkDays: 30,
  }),
}));
vi.mock("@/lib/backfill-window", () => ({
  calculateBackfillStart: () => new Date("2025-01-01T00:00:00.000Z"),
}));

function baseConnection(overrides: Record<string, unknown> = {}) {
  return {
    id: "conn-1",
    platform: Platform.INSTAGRAM,
    externalAccountId: "acc-1",
    encryptedToken: "encrypted",
    ...overrides,
  };
}

function dailySnapshotRows(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    periodEnd: new Date(`2026-08-${String(i + 1).padStart(2, "0")}T07:00:00.000Z`),
  }));
}

function totalValueRows(metrics: string[]) {
  return metrics.map((metric) => ({ metric }));
}

function setSnapshotMocks(options: {
  totalMetrics?: string[];
  reachDays?: number;
  followerDays?: number;
} = {}) {
  const { totalMetrics = ["reach", "views", "followers_gained", "followers_lost"], reachDays = 31, followerDays = 31 } = options;
  mockDb.socialInsightSnapshot.findMany.mockImplementation(async (args: { where: { periodType: InsightPeriodType; metric?: string } }) => {
    if (args.where.periodType === InsightPeriodType.TOTAL_VALUE) {
      return totalMetrics.map((metric) => ({ metric }));
    }
    if (args.where.periodType === InsightPeriodType.DAY && args.where.metric === "reach") {
      return dailySnapshotRows(reachDays);
    }
    if (args.where.periodType === InsightPeriodType.DAY && typeof args.where.metric === "object") {
      return dailySnapshotRows(followerDays).flatMap(({ periodEnd }) => [
        { metric: "followers_gained", periodStart: periodEnd },
        { metric: "followers_lost", periodStart: periodEnd },
      ]);
    }
    return [];
  });
  mockDb.socialInsightSnapshot.count.mockImplementation(async (args: { where: { metric: string } }) => {
    if (args.where.metric === "reach") return reachDays;
    return followerDays;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockTokenEncryption.decryptToken.mockReturnValue("token");
  mockMetaSyncInsights.completedMonthsWithinLookback.mockReturnValue([
    { start: new Date("2026-08-01T00:00:00.000Z"), end: new Date("2026-08-31T23:59:59.999Z") },
  ]);
  mockMetaSync.postInsights.mockResolvedValue({ metrics: {}, availability: {} });
  mockMetaSync.upsertPost.mockResolvedValue({ id: "post-1" });
  mockMetaSyncInsights.fetchCompletedMonthTotals.mockResolvedValue({
    reach: 1000,
    views: 2000,
    gained: 50,
    lost: 10,
  });
  mockMetaSyncInsights.fetchAndStoreAccountInsight.mockResolvedValue({ earliestPeriodEnd: new Date("2026-08-31T07:00:00.000Z") });
  mockReportData.fetchAndStoreDailyFollowerMovement.mockResolvedValue({ gained: 1, lost: 0 });
  mockDb.socialPost.count.mockResolvedValue(0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("runMonthEndCloseout", () => {
  it("completes immediately when no finalized month needs work", async () => {
    mockDb.socialConnection.findUnique.mockResolvedValue(baseConnection());
    setSnapshotMocks();
    mockDb.socialPost.findMany.mockResolvedValue([]);

    const result = await runMonthEndCloseout("conn-1", new Date("2026-09-02T00:00:00.000Z"));

    expect(result.completed).toBe(true);
    expect(result.posts).toBe(0);
    expect(mockMetaSyncInsights.fetchCompletedMonthTotals).not.toHaveBeenCalled();
    expect(mockMetaSyncInsights.fetchAndStoreAccountInsight).not.toHaveBeenCalled();
  });

  it("keeps a finalized month ready permanently when all post snapshots are finalized", async () => {
    mockDb.socialConnection.findUnique.mockResolvedValue(baseConnection());
    setSnapshotMocks();
    mockDb.socialPost.count.mockResolvedValue(0);
    mockDb.socialPost.findMany.mockResolvedValue([]);

    const first = await runMonthEndCloseout("conn-1", new Date("2026-09-02T00:00:00.000Z"));
    const later = await runMonthEndCloseout("conn-1", new Date("2026-09-10T00:00:00.000Z"));

    expect(first.completed).toBe(true);
    expect(later.completed).toBe(true);
    expect(mockMetaSync.postInsights).not.toHaveBeenCalled();
    expect(mockDb.socialPost.count).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        metricSnapshots: { none: expect.objectContaining({ finalizedAt: { not: null } }) },
      }),
    }));
    expect(mockDb.socialPost.count.mock.calls.some(([args]) => "OR" in args.where)).toBe(false);
  });

  it("fetches only missing account totals for a finalized month", async () => {
    mockDb.socialConnection.findUnique.mockResolvedValue(baseConnection());
    // Missing reach initially, then present after the fetch.
    mockDb.socialInsightSnapshot.findMany
      .mockResolvedValueOnce(totalValueRows(["views", "followers_gained", "followers_lost"]))
      .mockImplementation(async (args: { where: { periodType: InsightPeriodType; metric?: unknown } }) => {
        if (args.where.periodType === InsightPeriodType.TOTAL_VALUE) {
          return totalValueRows(["reach", "views", "followers_gained", "followers_lost"]);
        }
        if (typeof args.where.metric === "object") {
          return dailySnapshotRows(31).flatMap(({ periodEnd }) => [
            { metric: "followers_gained", periodStart: periodEnd },
            { metric: "followers_lost", periodStart: periodEnd },
          ]);
        }
        return [];
      });
    mockDb.socialInsightSnapshot.count.mockResolvedValue(31);
    mockDb.socialPost.findMany.mockResolvedValue([]);

    const result = await runMonthEndCloseout("conn-1", new Date("2026-09-02T00:00:00.000Z"));

    expect(mockMetaSyncInsights.fetchCompletedMonthTotals).toHaveBeenCalledTimes(1);
    expect(mockMetaSyncInsights.storeCompletedMonthTotals).toHaveBeenCalledTimes(1);
    expect(result.completed).toBe(true);
  });

  it("fetches only missing daily snapshots for a finalized month", async () => {
    mockDb.socialConnection.findUnique.mockResolvedValue(baseConnection());
    setSnapshotMocks({ reachDays: 29, followerDays: 30 });
    mockDb.socialPost.findMany.mockResolvedValue([]);

    await runMonthEndCloseout("conn-1", new Date("2026-09-02T00:00:00.000Z"));

    expect(mockMetaSyncInsights.fetchAndStoreAccountInsight).toHaveBeenCalled();
    const reachFetches = mockMetaSyncInsights.fetchAndStoreAccountInsight.mock.calls.filter(([_, __, ___, metric]) => metric === "reach");
    expect(reachFetches.length).toBeGreaterThan(0);
    expect(mockReportData.fetchAndStoreDailyFollowerMovement).toHaveBeenCalled();
    expect(mockMetaSyncInsights.fetchAndStoreAccountInsight.mock.calls.some(([_, __, ___, metric]) => metric === "follower_count")).toBe(false);
  });

  it("refreshes only a finalized-month post whose finalized snapshot is missing", async () => {
    mockDb.socialConnection.findUnique.mockResolvedValue(baseConnection());
    setSnapshotMocks();
    mockDb.socialPost.count.mockResolvedValueOnce(1).mockResolvedValue(0);
    mockDb.socialPost.findMany.mockResolvedValue([
      {
        id: "post-1",
        externalPostId: "ig-1",
        publishedAt: new Date("2026-08-15T00:00:00.000Z"),
        caption: "Caption",
        mediaType: "IMAGE",
        mediaUrl: "http://media",
        thumbnailUrl: null,
        permalink: "http://permalink",
        mediaSource: "OWNED",
        mediaMetadata: null,
        metrics: { likes: 5, comments: 1 },
        metricAvailabilityState: null,
        lastInsightRefreshAt: null,
      },
    ]);
    mockMetaSync.postInsights.mockResolvedValue({
      metrics: { reach: 100, views: 200 },
      availability: { reach: "returned", views: "returned" },
    });

    const result = await runMonthEndCloseout("conn-1", new Date("2026-09-02T00:00:00.000Z"));

    expect(mockMetaSync.postInsights).toHaveBeenCalledTimes(1);
    expect(mockMetaSync.postInsights).toHaveBeenCalledWith("ig-1", "token");
    expect(mockMetaSync.upsertPost).toHaveBeenCalledTimes(1);
    expect(mockDb.socialPost.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        metricSnapshots: { none: expect.objectContaining({ finalizedAt: { not: null } }) },
      }),
    }));
    expect(result.completed).toBe(true);
  });

  it("re-enqueues itself while post work remains", async () => {
    mockDb.socialConnection.findUnique.mockResolvedValue(baseConnection());
    setSnapshotMocks();
    mockDb.socialPost.count.mockResolvedValue(20);
    mockDb.socialPost.findMany.mockResolvedValue(
      Array.from({ length: 20 }, (_, i) => ({
        id: `post-${i}`,
        externalPostId: `ig-${i}`,
        publishedAt: new Date("2026-08-15T00:00:00.000Z"),
        caption: "Caption",
        mediaType: "IMAGE",
        mediaUrl: "http://media",
        thumbnailUrl: null,
        permalink: "http://permalink",
        mediaSource: "OWNED",
        mediaMetadata: null,
        metrics: {},
        metricAvailabilityState: null,
        lastInsightRefreshAt: null,
      })),
    );

    const result = await runMonthEndCloseout("conn-1", new Date("2026-09-02T00:00:00.000Z"));

    expect(result.posts).toBe(20);
    expect(result.completed).toBe(false);
  });

  it("skips months that are not yet finalized", async () => {
    mockDb.socialConnection.findUnique.mockResolvedValue(baseConnection());
    mockMetaSyncInsights.completedMonthsWithinLookback.mockReturnValue([
      { start: new Date("2026-09-01T00:00:00.000Z"), end: new Date("2026-09-30T23:59:59.999Z") },
    ]);

    const result = await runMonthEndCloseout("conn-1", new Date("2026-09-15T00:00:00.000Z"));

    expect(result.completed).toBe(true);
    expect(mockMetaSyncInsights.fetchCompletedMonthTotals).not.toHaveBeenCalled();
  });

  it("does not refetch a month once all required data is already present", async () => {
    mockDb.socialConnection.findUnique.mockResolvedValue(baseConnection());
    setSnapshotMocks();
    mockDb.socialPost.findMany.mockResolvedValue([]);

    await runMonthEndCloseout("conn-1", new Date("2026-09-02T00:00:00.000Z"));
    await runMonthEndCloseout("conn-1", new Date("2026-09-02T00:00:00.000Z"));

    expect(mockMetaSyncInsights.fetchCompletedMonthTotals).not.toHaveBeenCalled();
    expect(mockMetaSyncInsights.fetchAndStoreAccountInsight).not.toHaveBeenCalled();
  });

  it("does not crash when a daily follower response is malformed; preserves completed work and marks the job incomplete", async () => {
    mockDb.socialConnection.findUnique.mockResolvedValue(baseConnection());
    // Start with one missing total metric and one missing reach day so we can prove the closeout
    // preserved the work it *could* do (totals + reach) while only the unavailable follower day
    // remains incomplete.
    mockDb.socialInsightSnapshot.findMany
      .mockResolvedValueOnce(totalValueRows(["views", "followers_gained", "followers_lost"]))
      .mockImplementation(async (args: { where: { periodType: InsightPeriodType; metric?: unknown } }) => {
        if (args.where.periodType === InsightPeriodType.TOTAL_VALUE) {
          return totalValueRows(["reach", "views", "followers_gained", "followers_lost"]);
        }
        if (args.where.periodType === InsightPeriodType.DAY && args.where.metric === "reach") {
          return dailySnapshotRows(30);
        }
        if (args.where.periodType === InsightPeriodType.DAY && typeof args.where.metric === "object") {
          return dailySnapshotRows(30).flatMap(({ periodEnd }) => [
            { metric: "followers_gained", periodStart: periodEnd },
            { metric: "followers_lost", periodStart: periodEnd },
          ]);
        }
        return [];
      });
    mockDb.socialInsightSnapshot.count.mockImplementation(async (args: { where: { metric: string } }) => {
      if (args.where.metric === "reach") return 30;
      return 30;
    });
    mockDb.socialPost.findMany.mockResolvedValue([]);
    mockMetaSyncInsights.fetchCompletedMonthTotals.mockResolvedValue({
      reach: 1000,
      views: 2000,
      gained: 50,
      lost: 10,
    });
    mockMetaSyncInsights.fetchAndStoreAccountInsight.mockResolvedValue({ earliestPeriodEnd: new Date("2026-08-31T07:00:00.000Z") });
    // A malformed/unavailable follower response now safely returns null instead of throwing.
    mockReportData.fetchAndStoreDailyFollowerMovement.mockResolvedValue(null);

    const result = await runMonthEndCloseout("conn-1", new Date("2026-09-02T00:00:00.000Z"));

    expect(result.completed).toBe(false);
    expect(mockMetaSyncInsights.fetchCompletedMonthTotals).toHaveBeenCalledTimes(1);
    expect(mockMetaSyncInsights.storeCompletedMonthTotals).toHaveBeenCalledTimes(1);
    expect(mockMetaSyncInsights.fetchAndStoreAccountInsight).toHaveBeenCalled();
    expect(mockReportData.fetchAndStoreDailyFollowerMovement).toHaveBeenCalled();
  });

  it("respects Meta API cooldown by letting fetch errors bubble to the job retry logic", async () => {
    mockDb.socialConnection.findUnique.mockResolvedValue(baseConnection());
    setSnapshotMocks({ reachDays: 29 });
    mockDb.socialPost.findMany.mockResolvedValue([]);
    mockMetaSyncInsights.fetchAndStoreAccountInsight.mockRejectedValue(new Error("rate limited"));

    await expect(runMonthEndCloseout("conn-1", new Date("2026-09-02T00:00:00.000Z"))).rejects.toThrow("rate limited");
  });

  it("targets an explicitly requested older report period without resyncing the entire history", async () => {
    mockDb.socialConnection.findUnique.mockResolvedValue(baseConnection());
    setSnapshotMocks({ reachDays: 29 });
    mockDb.socialPost.count.mockResolvedValue(0);

    const result = await runReportPeriodCloseout("conn-1", new Date("2026-08-01"), new Date("2026-08-31"), new Date("2026-09-15"));

    expect(result.completed).toBe(false);
    expect(mockMetaSyncInsights.fetchAndStoreAccountInsight).toHaveBeenCalled();
  });

  it("returns completed when the explicitly requested older report period is already complete", async () => {
    mockDb.socialConnection.findUnique.mockResolvedValue(baseConnection());
    setSnapshotMocks();
    mockDb.socialPost.count.mockResolvedValue(0);

    const result = await runReportPeriodCloseout("conn-1", new Date("2026-08-01"), new Date("2026-08-31"), new Date("2026-09-15"));

    expect(result.completed).toBe(true);
    expect(mockMetaSyncInsights.fetchCompletedMonthTotals).not.toHaveBeenCalled();
    expect(mockMetaSyncInsights.fetchAndStoreAccountInsight).not.toHaveBeenCalled();
  });
});

describe("isLastDaysOfMonth", () => {
  it("returns true during the final days of a month", () => {
    expect(isLastDaysOfMonth(new Date("2026-08-30T00:00:00.000Z"), 3)).toBe(true);
    expect(isLastDaysOfMonth(new Date("2026-08-31T00:00:00.000Z"), 3)).toBe(true);
  });

  it("returns false earlier in the month", () => {
    expect(isLastDaysOfMonth(new Date("2026-08-27T00:00:00.000Z"), 3)).toBe(false);
  });
});
