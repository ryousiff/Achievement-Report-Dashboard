import { describe, expect, it, vi } from "vitest";
import { BackfillStatus } from "@prisma/client";
import { getCoverage } from "@/lib/report-coverage";

const mockDb = vi.hoisted(() => ({
  socialConnection: { findUnique: vi.fn() },
  syncJob: { findMany: vi.fn() },
  socialPost: { aggregate: vi.fn(), findMany: vi.fn() },
  socialInsightSnapshot: { findMany: vi.fn() },
}));

const mockPeriodAccountReachForRange = vi.hoisted(() => vi.fn());
const mockPeriodAccountFollowersForRange = vi.hoisted(() => vi.fn());

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/report-data", () => ({ periodAccountReachForRange: mockPeriodAccountReachForRange, periodAccountFollowersForRange: mockPeriodAccountFollowersForRange }));

function resetMocks() {
  mockDb.socialConnection.findUnique.mockReset();
  mockDb.syncJob.findMany.mockReset();
  mockDb.socialPost.aggregate.mockReset();
  mockDb.socialPost.findMany.mockReset();
  mockDb.socialInsightSnapshot.findMany.mockReset();
  mockPeriodAccountReachForRange.mockReset();
  mockPeriodAccountFollowersForRange.mockReset();
  mockPeriodAccountFollowersForRange.mockResolvedValue({ gained: 10, lost: 2, net: 8, accuracy: "EXACT", method: "META_TOTAL_VALUE" });
}

describe("getCoverage", () => {
  it("returns UNAVAILABLE when no connection exists", async () => {
    resetMocks();
    mockDb.socialConnection.findUnique.mockResolvedValue(null);
    const coverage = await getCoverage("conn-1", new Date("2026-08-01T00:00:00.000Z"), new Date("2026-08-03T23:59:59.999Z"));
    expect(coverage.status).toBe("UNAVAILABLE");
  });

  it("returns COMPLETE when media, exact period reach, follower count, and insights all cover the period", async () => {
    resetMocks();
    mockDb.socialConnection.findUnique.mockResolvedValue({
      id: "conn-1",
      clientId: "client-1",
      historicalBackfillStatus: BackfillStatus.COMPLETED,
      historicalBackfillStart: new Date("2026-01-01T00:00:00.000Z"),
      historicalBackfillLastError: null,
      collaborativeBackfillStatus: BackfillStatus.COMPLETED,
      collaborativeBackfillStart: new Date("2026-01-01T00:00:00.000Z"),
      collaborativeBackfillLastError: null,
      reachCoverageStart: new Date("2026-08-01T00:00:00.000Z"),
      reachDays28CoverageStart: new Date("2026-08-01T00:00:00.000Z"),
      followerCountCoverageStart: new Date("2026-08-01T00:00:00.000Z"),
      accountInsightsLastSyncedAt: new Date("2026-08-04T00:00:00.000Z"),
      accountInsightsBackfillCompletedAt: new Date("2026-08-04T00:00:00.000Z"),
      accountInsightsLastError: null,
      lastSuccessfulSyncAt: new Date("2026-08-04T00:00:00.000Z"),
    });
    mockDb.syncJob.findMany.mockResolvedValue([]);
    mockDb.socialPost.aggregate
      .mockResolvedValueOnce({ _min: { publishedAt: new Date("2026-08-01T00:00:00.000Z") }, _max: { publishedAt: new Date("2026-08-07T00:00:00.000Z") }, _count: 2 })
      .mockResolvedValueOnce({ _min: { publishedAt: new Date("2026-08-01T00:00:00.000Z") }, _max: { publishedAt: new Date("2026-08-07T00:00:00.000Z") } });
    mockDb.socialPost.findMany.mockResolvedValue([
      { metrics: { reach: 100, views: 200, total_views: 250, total_interactions: 50, likes: 30, comments: 10, saved: 5, shares: 2, follows: 1 }, metricAvailabilityState: { reach: "AVAILABLE", views: "AVAILABLE", total_views: "AVAILABLE", total_interactions: "AVAILABLE", likes: "AVAILABLE", comments: "AVAILABLE", saved: "AVAILABLE", shares: "AVAILABLE", follows: "AVAILABLE" } },
    ]);
    mockDb.socialInsightSnapshot.findMany
      .mockResolvedValueOnce([
        { periodEnd: new Date("2026-08-01T07:00:00.000Z") },
        { periodEnd: new Date("2026-08-02T07:00:00.000Z") },
        { periodEnd: new Date("2026-08-03T07:00:00.000Z") },
        { periodEnd: new Date("2026-08-04T07:00:00.000Z") },
        { periodEnd: new Date("2026-08-05T07:00:00.000Z") },
        { periodEnd: new Date("2026-08-06T07:00:00.000Z") },
        { periodEnd: new Date("2026-08-07T07:00:00.000Z") },
      ])
      .mockResolvedValueOnce([{ periodEnd: new Date("2026-08-07T07:00:00.000Z") }])
      .mockResolvedValueOnce([
        { periodEnd: new Date("2026-08-01T07:00:00.000Z") },
        { periodEnd: new Date("2026-08-02T07:00:00.000Z") },
        { periodEnd: new Date("2026-08-03T07:00:00.000Z") },
        { periodEnd: new Date("2026-08-04T07:00:00.000Z") },
        { periodEnd: new Date("2026-08-05T07:00:00.000Z") },
        { periodEnd: new Date("2026-08-06T07:00:00.000Z") },
        { periodEnd: new Date("2026-08-07T07:00:00.000Z") },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ value: 1234 }]);
    mockPeriodAccountReachForRange.mockResolvedValue({ value: 1234, accuracy: "EXACT", method: "META_TOTAL_VALUE" });

    const coverage = await getCoverage("conn-1", new Date("2026-08-01T00:00:00.000Z"), new Date("2026-08-07T23:59:59.999Z"));
    expect(coverage.status).toBe("COMPLETE");
    expect(coverage.mediaCoverage.complete).toBe(true);
    expect(coverage.reachStatus).toBe("PERIOD_AVAILABLE");
    expect(coverage.followerCountCoverage.complete).toBe(true);
    expect(coverage.followsCoverage.complete).toBe(true);
    expect(coverage.postInsightCoverage.missingMetrics).toEqual([]);
  });

  it("returns SYNCING when the backfill is still running", async () => {
    resetMocks();
    mockDb.socialConnection.findUnique.mockResolvedValue({
      id: "conn-1",
      clientId: "client-1",
      historicalBackfillStatus: BackfillStatus.RUNNING,
      historicalBackfillStart: new Date("2026-01-01T00:00:00.000Z"),
      historicalBackfillLastError: null,
      collaborativeBackfillStatus: BackfillStatus.RUNNING,
      collaborativeBackfillStart: new Date("2026-01-01T00:00:00.000Z"),
      collaborativeBackfillLastError: null,
      reachCoverageStart: null,
      reachDays28CoverageStart: null,
      followerCountCoverageStart: null,
      accountInsightsLastSyncedAt: null,
      accountInsightsBackfillCompletedAt: null,
      accountInsightsLastError: null,
      lastSuccessfulSyncAt: null,
    });
    mockDb.syncJob.findMany.mockResolvedValue([]);
    mockDb.socialPost.aggregate
      .mockResolvedValueOnce({ _min: { publishedAt: null }, _max: { publishedAt: null }, _count: 0 })
      .mockResolvedValueOnce({ _min: { publishedAt: null }, _max: { publishedAt: null } });
    mockDb.socialPost.findMany.mockResolvedValue([]);
    mockDb.socialInsightSnapshot.findMany.mockResolvedValue([]);
    mockPeriodAccountReachForRange.mockResolvedValue({ value: null, accuracy: null, method: "UNAVAILABLE" });

    const coverage = await getCoverage("conn-1", new Date("2026-08-01T00:00:00.000Z"), new Date("2026-08-03T23:59:59.999Z"));
    expect(coverage.status).toBe("SYNCING");
  });

  it("reports PARTIAL when owned backfill is complete but collaborative backfill is not", async () => {
    resetMocks();
    mockDb.socialConnection.findUnique.mockResolvedValue({
      id: "conn-1",
      clientId: "client-1",
      historicalBackfillStatus: BackfillStatus.COMPLETED,
      historicalBackfillStart: new Date("2026-01-01T00:00:00.000Z"),
      historicalBackfillLastError: null,
      collaborativeBackfillStatus: BackfillStatus.NOT_STARTED,
      collaborativeBackfillStart: null,
      collaborativeBackfillLastError: null,
      reachCoverageStart: new Date("2026-08-01T00:00:00.000Z"),
      reachDays28CoverageStart: new Date("2026-08-01T00:00:00.000Z"),
      followerCountCoverageStart: new Date("2026-08-01T00:00:00.000Z"),
      accountInsightsLastSyncedAt: new Date("2026-08-04T00:00:00.000Z"),
      accountInsightsBackfillCompletedAt: new Date("2026-08-04T00:00:00.000Z"),
      accountInsightsLastError: null,
      lastSuccessfulSyncAt: new Date("2026-08-04T00:00:00.000Z"),
    });
    mockDb.syncJob.findMany.mockResolvedValue([]);
    mockDb.socialPost.aggregate
      .mockResolvedValueOnce({ _min: { publishedAt: new Date("2026-08-01T00:00:00.000Z") }, _max: { publishedAt: new Date("2026-08-03T00:00:00.000Z") }, _count: 2 })
      .mockResolvedValueOnce({ _min: { publishedAt: new Date("2026-08-01T00:00:00.000Z") }, _max: { publishedAt: new Date("2026-08-03T00:00:00.000Z") } });
    mockDb.socialPost.findMany.mockResolvedValue([
      { metrics: { reach: 100, views: 200, total_views: 250, total_interactions: 50, likes: 30, comments: 10, saved: 5, shares: 2, follows: 1 }, metricAvailabilityState: { reach: "AVAILABLE", views: "AVAILABLE", total_views: "AVAILABLE", total_interactions: "AVAILABLE", likes: "AVAILABLE", comments: "AVAILABLE", saved: "AVAILABLE", shares: "AVAILABLE", follows: "AVAILABLE" } },
    ]);
    mockDb.socialInsightSnapshot.findMany
      .mockResolvedValueOnce([
        { periodEnd: new Date("2026-08-01T07:00:00.000Z") },
        { periodEnd: new Date("2026-08-02T07:00:00.000Z") },
        { periodEnd: new Date("2026-08-03T07:00:00.000Z") },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { periodEnd: new Date("2026-08-01T07:00:00.000Z") },
        { periodEnd: new Date("2026-08-02T07:00:00.000Z") },
        { periodEnd: new Date("2026-08-03T07:00:00.000Z") },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    mockPeriodAccountReachForRange.mockResolvedValue({ value: null, accuracy: null, method: "UNAVAILABLE" });

    const coverage = await getCoverage("conn-1", new Date("2026-08-01T00:00:00.000Z"), new Date("2026-08-03T23:59:59.999Z"));
    expect(coverage.status).toBe("PARTIAL");
    expect(coverage.collaborativeBackfillStatus).toBe(BackfillStatus.NOT_STARTED);
    expect(coverage.warnings.some((w) => w.includes("تعاونية"))).toBe(true);
    expect(coverage.reachStatus).toBe("DAILY_COMPLETE");
  });

  it("marks reach PERIOD_UNAVAILABLE for a 31-day month even when daily snapshots are present", async () => {
    resetMocks();
    mockDb.socialConnection.findUnique.mockResolvedValue({
      id: "conn-1",
      clientId: "client-1",
      historicalBackfillStatus: BackfillStatus.COMPLETED,
      historicalBackfillStart: new Date("2026-01-01T00:00:00.000Z"),
      historicalBackfillLastError: null,
      collaborativeBackfillStatus: BackfillStatus.COMPLETED,
      collaborativeBackfillStart: new Date("2026-01-01T00:00:00.000Z"),
      collaborativeBackfillLastError: null,
      reachCoverageStart: new Date("2026-07-01T00:00:00.000Z"),
      reachDays28CoverageStart: new Date("2026-07-04T00:00:00.000Z"),
      followerCountCoverageStart: new Date("2026-07-01T00:00:00.000Z"),
      accountInsightsLastSyncedAt: new Date("2026-08-04T00:00:00.000Z"),
      accountInsightsBackfillCompletedAt: new Date("2026-08-04T00:00:00.000Z"),
      accountInsightsLastError: null,
      lastSuccessfulSyncAt: new Date("2026-08-04T00:00:00.000Z"),
    });
    mockDb.syncJob.findMany.mockResolvedValue([]);
    mockDb.socialPost.aggregate
      .mockResolvedValueOnce({ _min: { publishedAt: new Date("2026-07-01T00:00:00.000Z") }, _max: { publishedAt: new Date("2026-07-31T00:00:00.000Z") }, _count: 2 })
      .mockResolvedValueOnce({ _min: { publishedAt: new Date("2026-07-01T00:00:00.000Z") }, _max: { publishedAt: new Date("2026-07-31T00:00:00.000Z") } });
    mockDb.socialPost.findMany.mockResolvedValue([
      { metrics: { reach: 100, views: 200, total_views: 250, total_interactions: 50, likes: 30, comments: 10, saved: 5, shares: 2, follows: 1 }, metricAvailabilityState: { reach: "AVAILABLE", views: "AVAILABLE", total_views: "AVAILABLE", total_interactions: "AVAILABLE", likes: "AVAILABLE", comments: "AVAILABLE", saved: "AVAILABLE", shares: "AVAILABLE", follows: "AVAILABLE" } },
    ]);
    mockDb.socialInsightSnapshot.findMany
      .mockResolvedValueOnce(Array.from({ length: 31 }, (_, i) => ({ periodEnd: new Date(`2026-07-${String(i + 1).padStart(2, "0")}T07:00:00.000Z`) })))
      .mockResolvedValueOnce([{ periodEnd: new Date("2026-07-31T07:00:00.000Z") }])
      .mockResolvedValueOnce(Array.from({ length: 31 }, (_, i) => ({ periodEnd: new Date(`2026-07-${String(i + 1).padStart(2, "0")}T07:00:00.000Z`) })))
      .mockResolvedValueOnce([{ periodEnd: new Date("2026-07-31T07:00:00.000Z") }])
      .mockResolvedValueOnce([]);
    mockPeriodAccountReachForRange.mockResolvedValue({ value: null, accuracy: null, method: "UNAVAILABLE" });

    const coverage = await getCoverage("conn-1", new Date("2026-07-01T00:00:00.000Z"), new Date("2026-07-31T23:59:59.999Z"));
    expect(coverage.reachStatus).toBe("DAYS_28_AVAILABLE");
    expect(coverage.warnings.some((w) => w.includes("متاح Reach لآخر 28 يوم فقط"))).toBe(true);
  });
});
