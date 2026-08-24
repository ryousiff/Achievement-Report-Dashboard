import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InsightPeriodType, Platform } from "@prisma/client";
import { runMonthEndCloseout, isLastDaysOfMonth } from "@/lib/month-end-closeout";

const mockDb = vi.hoisted(() => ({
  socialConnection: { findUnique: vi.fn() },
  socialInsightSnapshot: { findMany: vi.fn(), count: vi.fn() },
  socialPost: { findMany: vi.fn(), count: vi.fn() },
}));

const mockMetaSync = vi.hoisted(() => ({
  postInsights: vi.fn(),
  upsertPost: vi.fn(),
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
    if (args.where.periodType === InsightPeriodType.DAY && args.where.metric === "follower_count") {
      return dailySnapshotRows(followerDays);
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

  it("fetches only missing account totals for a finalized month", async () => {
    mockDb.socialConnection.findUnique.mockResolvedValue(baseConnection());
    // Missing reach initially, then present after the fetch.
    mockDb.socialInsightSnapshot.findMany
      .mockResolvedValueOnce(totalValueRows(["views", "followers_gained", "followers_lost"]))
      .mockImplementation(async (args: { where: { periodType: InsightPeriodType } }) => {
        if (args.where.periodType === InsightPeriodType.TOTAL_VALUE) {
          return totalValueRows(["reach", "views", "followers_gained", "followers_lost"]);
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
    const followerFetches = mockMetaSyncInsights.fetchAndStoreAccountInsight.mock.calls.filter(([_, __, ___, metric]) => metric === "follower_count");
    expect(reachFetches.length).toBeGreaterThan(0);
    expect(followerFetches.length).toBeGreaterThan(0);
  });

  it("refreshes insights for stale posts and finalizes their snapshots", async () => {
    mockDb.socialConnection.findUnique.mockResolvedValue(baseConnection());
    setSnapshotMocks();
    mockDb.socialPost.count.mockResolvedValue(1);
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

    await runMonthEndCloseout("conn-1", new Date("2026-09-02T00:00:00.000Z"));

    expect(mockMetaSync.postInsights).toHaveBeenCalledWith("ig-1", "token");
    expect(mockMetaSync.upsertPost).toHaveBeenCalled();
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

  it("respects Meta API cooldown by letting fetch errors bubble to the job retry logic", async () => {
    mockDb.socialConnection.findUnique.mockResolvedValue(baseConnection());
    setSnapshotMocks({ reachDays: 29 });
    mockDb.socialPost.findMany.mockResolvedValue([]);
    mockMetaSyncInsights.fetchAndStoreAccountInsight.mockRejectedValue(new Error("rate limited"));

    await expect(runMonthEndCloseout("conn-1", new Date("2026-09-02T00:00:00.000Z"))).rejects.toThrow("rate limited");
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
