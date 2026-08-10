import { describe, expect, it, vi } from "vitest";
import { BackfillStatus } from "@prisma/client";
import { getCoverage } from "@/lib/report-coverage";

const mockDb = vi.hoisted(() => ({
  socialConnection: { findUnique: vi.fn() },
  syncJob: { findMany: vi.fn() },
  socialPost: { aggregate: vi.fn(), findMany: vi.fn() },
  socialInsightSnapshot: { findMany: vi.fn() },
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));

function resetMocks() {
  mockDb.socialConnection.findUnique.mockReset();
  mockDb.syncJob.findMany.mockReset();
  mockDb.socialPost.aggregate.mockReset();
  mockDb.socialPost.findMany.mockReset();
  mockDb.socialInsightSnapshot.findMany.mockReset();
}

describe("getCoverage", () => {
  it("returns UNAVAILABLE when no connection exists", async () => {
    resetMocks();
    mockDb.socialConnection.findUnique.mockResolvedValue(null);
    const coverage = await getCoverage("conn-1", new Date("2026-08-01T00:00:00.000Z"), new Date("2026-08-03T23:59:59.999Z"));
    expect(coverage.status).toBe("UNAVAILABLE");
  });

  it("returns COMPLETE when media, reach, follows, and insights all cover the period", async () => {
    resetMocks();
    mockDb.socialConnection.findUnique.mockResolvedValue({
      id: "conn-1",
      historicalBackfillStatus: BackfillStatus.COMPLETED,
      historicalBackfillStart: new Date("2026-01-01T00:00:00.000Z"),
      historicalBackfillLastError: null,
      collaborativeBackfillStatus: BackfillStatus.COMPLETED,
      collaborativeBackfillStart: new Date("2026-01-01T00:00:00.000Z"),
      collaborativeBackfillLastError: null,
      reachCoverageStart: new Date("2026-08-01T00:00:00.000Z"),
      followsCoverageStart: new Date("2026-08-01T00:00:00.000Z"),
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
      { metrics: { reach: 100, views: 200, total_interactions: 50, likes: 30, comments: 10, saved: 5, shares: 2, follows: 1 }, metricAvailabilityState: { reach: "AVAILABLE", views: "AVAILABLE", total_interactions: "AVAILABLE", likes: "AVAILABLE", comments: "AVAILABLE", saved: "AVAILABLE", shares: "AVAILABLE", follows: "AVAILABLE" } },
    ]);
    mockDb.socialInsightSnapshot.findMany
      .mockResolvedValueOnce([
        { periodEnd: new Date("2026-08-01T00:00:00.000Z") },
        { periodEnd: new Date("2026-08-02T00:00:00.000Z") },
        { periodEnd: new Date("2026-08-03T00:00:00.000Z") },
      ])
      .mockResolvedValueOnce([
        { periodEnd: new Date("2026-08-01T00:00:00.000Z") },
        { periodEnd: new Date("2026-08-02T00:00:00.000Z") },
        { periodEnd: new Date("2026-08-03T00:00:00.000Z") },
      ]);

    const coverage = await getCoverage("conn-1", new Date("2026-08-01T00:00:00.000Z"), new Date("2026-08-03T23:59:59.999Z"));
    expect(coverage.status).toBe("COMPLETE");
    expect(coverage.mediaCoverage.complete).toBe(true);
    expect(coverage.reachCoverage.complete).toBe(true);
    expect(coverage.followsCoverage.complete).toBe(true);
    expect(coverage.postInsightCoverage.missingMetrics).toEqual([]);
  });

  it("returns SYNCING when the backfill is still running", async () => {
    resetMocks();
    mockDb.socialConnection.findUnique.mockResolvedValue({
      id: "conn-1",
      historicalBackfillStatus: BackfillStatus.RUNNING,
      historicalBackfillStart: new Date("2026-01-01T00:00:00.000Z"),
      historicalBackfillLastError: null,
      collaborativeBackfillStatus: BackfillStatus.RUNNING,
      collaborativeBackfillStart: new Date("2026-01-01T00:00:00.000Z"),
      collaborativeBackfillLastError: null,
      reachCoverageStart: null,
      followsCoverageStart: null,
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

    const coverage = await getCoverage("conn-1", new Date("2026-08-01T00:00:00.000Z"), new Date("2026-08-03T23:59:59.999Z"));
    expect(coverage.status).toBe("SYNCING");
  });

  it("reports PARTIAL when owned backfill is complete but collaborative backfill is not", async () => {
    resetMocks();
    mockDb.socialConnection.findUnique.mockResolvedValue({
      id: "conn-1",
      historicalBackfillStatus: BackfillStatus.COMPLETED,
      historicalBackfillStart: new Date("2026-01-01T00:00:00.000Z"),
      historicalBackfillLastError: null,
      collaborativeBackfillStatus: BackfillStatus.NOT_STARTED,
      collaborativeBackfillStart: null,
      collaborativeBackfillLastError: null,
      reachCoverageStart: new Date("2026-08-01T00:00:00.000Z"),
      followsCoverageStart: new Date("2026-08-01T00:00:00.000Z"),
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
      { metrics: { reach: 100, views: 200, total_interactions: 50, likes: 30, comments: 10, saved: 5, shares: 2, follows: 1 }, metricAvailabilityState: { reach: "AVAILABLE", views: "AVAILABLE", total_interactions: "AVAILABLE", likes: "AVAILABLE", comments: "AVAILABLE", saved: "AVAILABLE", shares: "AVAILABLE", follows: "AVAILABLE" } },
    ]);
    mockDb.socialInsightSnapshot.findMany
      .mockResolvedValueOnce([
        { periodEnd: new Date("2026-08-01T00:00:00.000Z") },
        { periodEnd: new Date("2026-08-02T00:00:00.000Z") },
        { periodEnd: new Date("2026-08-03T00:00:00.000Z") },
      ])
      .mockResolvedValueOnce([
        { periodEnd: new Date("2026-08-01T00:00:00.000Z") },
        { periodEnd: new Date("2026-08-02T00:00:00.000Z") },
        { periodEnd: new Date("2026-08-03T00:00:00.000Z") },
      ]);

    const coverage = await getCoverage("conn-1", new Date("2026-08-01T00:00:00.000Z"), new Date("2026-08-03T23:59:59.999Z"));
    expect(coverage.status).toBe("PARTIAL");
    expect(coverage.collaborativeBackfillStatus).toBe(BackfillStatus.NOT_STARTED);
    expect(coverage.warnings.some((w) => w.includes("تعاونية"))).toBe(true);
  });
});
