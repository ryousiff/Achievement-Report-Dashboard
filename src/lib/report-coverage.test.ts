import { describe, expect, it, vi } from "vitest";
import { BackfillStatus, SyncJobStatus, SyncJobType } from "@prisma/client";
import { getCoverage, CLOSING_MONTH_MESSAGE, NO_CONNECTION_EMPLOYEE_MESSAGE, PREPARING_MONTH_MESSAGE, READY_FOR_APPROVAL_MESSAGE, STALLED_INCOMPLETE_MESSAGE } from "@/lib/report-coverage";

const mockDb = vi.hoisted(() => ({
  socialConnection: { findUnique: vi.fn() },
  syncJob: { findMany: vi.fn(), create: vi.fn() },
  socialPost: { aggregate: vi.fn(), findMany: vi.fn() },
  socialPostMetricSnapshot: { findMany: vi.fn() },
  socialInsightSnapshot: { findMany: vi.fn() },
}));

const mockLogEvent = vi.hoisted(() => vi.fn());

const mockPeriodAccountReachForRange = vi.hoisted(() => vi.fn());
const mockPeriodAccountFollowersForRange = vi.hoisted(() => vi.fn());

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/observability", () => ({ logEvent: mockLogEvent, logError: vi.fn() }));
vi.mock("@/lib/report-data", () => ({ periodAccountReachForRange: mockPeriodAccountReachForRange, periodAccountFollowersForRange: mockPeriodAccountFollowersForRange }));

function resetMocks() {
  mockDb.socialConnection.findUnique.mockReset();
  mockDb.syncJob.findMany.mockReset();
  mockDb.syncJob.create.mockReset();
  mockDb.socialPost.aggregate.mockReset();
  mockDb.socialPost.findMany.mockReset();
  mockDb.socialPostMetricSnapshot.findMany.mockReset();
  mockDb.socialPostMetricSnapshot.findMany.mockResolvedValue([]);
  mockDb.socialInsightSnapshot.findMany.mockReset();
  mockPeriodAccountReachForRange.mockReset();
  mockPeriodAccountFollowersForRange.mockReset();
  mockPeriodAccountFollowersForRange.mockResolvedValue({ gained: 10, lost: 2, net: 8, accuracy: "EXACT", method: "META_TOTAL_VALUE" });
  mockLogEvent.mockReset();
}

function baseConnection(overrides: Record<string, unknown> = {}) {
  return {
    id: "conn-1",
    clientId: "client-1",
    historicalBackfillStatus: BackfillStatus.COMPLETED,
    historicalBackfillStart: new Date("2026-01-01T00:00:00.000Z"),
    historicalBackfillLastError: null,
    historicalBackfillRetryCount: 0,
    collaborativeBackfillStatus: BackfillStatus.COMPLETED,
    collaborativeBackfillStart: new Date("2026-01-01T00:00:00.000Z"),
    collaborativeBackfillLastError: null,
    collaborativeBackfillRetryCount: 0,
    reachCoverageStart: new Date("2026-08-01T00:00:00.000Z"),
    reachDays28CoverageStart: new Date("2026-08-01T00:00:00.000Z"),
    followerCountCoverageStart: new Date("2026-08-01T00:00:00.000Z"),
    accountInsightsLastSyncedAt: new Date("2026-08-04T00:00:00.000Z"),
    accountInsightsBackfillCompletedAt: new Date("2026-08-04T00:00:00.000Z"),
    accountInsightsLastError: null,
    lastSuccessfulSyncAt: new Date("2026-08-04T00:00:00.000Z"),
    ...overrides,
  };
}

const availablePostMetrics = {
  reach: "AVAILABLE",
  views: "AVAILABLE",
  total_views: "AVAILABLE",
  total_interactions: "AVAILABLE",
  likes: "AVAILABLE",
  comments: "AVAILABLE",
  saved: "AVAILABLE",
  shares: "AVAILABLE",
  follows: "AVAILABLE",
};

function setIncompleteJulyMocks(options: { dailyReachAvailable?: boolean; days28Available?: boolean } = {}) {
  mockDb.socialConnection.findUnique.mockResolvedValue(baseConnection());
  mockDb.socialPost.aggregate
    .mockResolvedValueOnce({ _min: { publishedAt: new Date("2026-07-01T00:00:00.000Z") }, _max: { publishedAt: new Date("2026-07-31T00:00:00.000Z") }, _count: 2 })
    .mockResolvedValueOnce({ _min: { publishedAt: new Date("2026-07-01T00:00:00.000Z") }, _max: { publishedAt: new Date("2026-07-31T00:00:00.000Z") } });
  mockDb.socialPost.findMany.mockResolvedValue([
    { metrics: { reach: 100, views: 200, total_views: 250, total_interactions: 50, likes: 30, comments: 10, saved: 5, shares: 2, follows: 1 }, metricAvailabilityState: { reach: "AVAILABLE", views: "AVAILABLE", total_views: "AVAILABLE", total_interactions: "AVAILABLE", likes: "AVAILABLE", comments: "AVAILABLE", saved: "AVAILABLE", shares: "AVAILABLE", follows: "AVAILABLE" } },
  ]);
  mockDb.socialInsightSnapshot.findMany
    .mockResolvedValueOnce(options.dailyReachAvailable === false ? [] : Array.from({ length: 31 }, (_, i) => ({ periodEnd: new Date(`2026-07-${String(i + 1).padStart(2, "0")}T07:00:00.000Z`) })))
    .mockResolvedValueOnce(options.days28Available ? [{ periodEnd: new Date("2026-07-31T07:00:00.000Z") }] : [])
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce(options.days28Available ? [{ value: 1234 }] : []);
  mockPeriodAccountReachForRange.mockResolvedValue({ value: null, accuracy: null, method: "UNAVAILABLE" });
}

function setReadyJulyWithPosts(posts: Array<{ metrics?: Record<string, unknown>; metricAvailabilityState: Record<string, string> }>) {
  setIncompleteJulyMocks();
  mockDb.syncJob.findMany.mockResolvedValue([]);
  mockDb.socialPost.findMany.mockResolvedValue(posts.map((post) => ({ metrics: post.metrics ?? {}, metricAvailabilityState: post.metricAvailabilityState })));
  mockPeriodAccountReachForRange.mockResolvedValue({ value: 312688, accuracy: "ESTIMATED", method: "OVERLAPPING_WINDOWS_ESTIMATE" });
}

describe("getCoverage", () => {
  it("returns UNAVAILABLE with a friendly message when no connection exists", async () => {
    resetMocks();
    mockDb.socialConnection.findUnique.mockResolvedValue(null);
    const coverage = await getCoverage("conn-1", new Date("2026-08-01T00:00:00.000Z"), new Date("2026-08-03T23:59:59.999Z"));
    expect(coverage.status).toBe("UNAVAILABLE");
    expect(coverage.warnings).toEqual([NO_CONNECTION_EMPLOYEE_MESSAGE]);
  });

  it("returns COMPLETE for an old month with valid follower movement even when follower_count snapshots are missing", async () => {
    resetMocks();
    mockDb.socialConnection.findUnique.mockResolvedValue(baseConnection());
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
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ value: 1234 }]);
    mockPeriodAccountReachForRange.mockResolvedValue({ value: 1234, accuracy: "EXACT", method: "META_TOTAL_VALUE" });

    const coverage = await getCoverage("conn-1", new Date("2026-08-01T00:00:00.000Z"), new Date("2026-08-07T23:59:59.999Z"));
    expect(coverage.status).toBe("COMPLETE");
    expect(coverage.warnings).toEqual([READY_FOR_APPROVAL_MESSAGE]);
    expect(coverage.mediaCoverage.complete).toBe(true);
    expect(coverage.reachStatus).toBe("PERIOD_AVAILABLE");
    expect(coverage.followerCountCoverage.complete).toBe(false);
    expect(coverage.followsCoverage.complete).toBe(true);
    expect(coverage.postInsightCoverage.missingMetrics).toEqual([]);
  });

  it("treats a persisted 31-day estimated Reach as complete without changing its status", async () => {
    resetMocks();
    setIncompleteJulyMocks();
    mockDb.syncJob.findMany.mockResolvedValue([]);
    mockPeriodAccountReachForRange.mockResolvedValue({
      value: 312688,
      accuracy: "ESTIMATED",
      method: "OVERLAPPING_WINDOWS_ESTIMATE",
      tooltip: "قيمة تقديرية محفوظة لفترة 31 يوماً.",
    });

    const coverage = await getCoverage("conn-1", new Date("2026-07-01T00:00:00.000Z"), new Date("2026-07-31T23:59:59.999Z"));

    expect(coverage.reachStatus).toBe("PERIOD_ESTIMATED");
    expect(coverage.status).toBe("COMPLETE");
    expect(coverage.warnings).toEqual([READY_FOR_APPROVAL_MESSAGE]);
  });

  it("keeps exact period Reach complete", async () => {
    resetMocks();
    setIncompleteJulyMocks();
    mockDb.syncJob.findMany.mockResolvedValue([]);
    mockPeriodAccountReachForRange.mockResolvedValue({ value: 312688, accuracy: "EXACT", method: "META_TOTAL_VALUE" });

    const coverage = await getCoverage("conn-1", new Date("2026-07-01T00:00:00.000Z"), new Date("2026-07-31T23:59:59.999Z"));

    expect(coverage.reachStatus).toBe("PERIOD_AVAILABLE");
    expect(coverage.status).toBe("COMPLETE");
  });

  it("does not complete a report when period Reach is unavailable", async () => {
    resetMocks();
    setIncompleteJulyMocks({ dailyReachAvailable: false });
    mockDb.syncJob.findMany.mockResolvedValue([]);

    const coverage = await getCoverage("conn-1", new Date("2026-07-01T00:00:00.000Z"), new Date("2026-07-31T23:59:59.999Z"));

    expect(coverage.reachStatus).toBe("PERIOD_UNAVAILABLE");
    expect(coverage.status).toBe("PARTIAL");
  });

  it("does not treat a 28-day Reach window as complete period Reach", async () => {
    resetMocks();
    setIncompleteJulyMocks({ days28Available: true });
    mockDb.syncJob.findMany.mockResolvedValue([]);

    const coverage = await getCoverage("conn-1", new Date("2026-07-01T00:00:00.000Z"), new Date("2026-07-31T23:59:59.999Z"));

    expect(coverage.reachStatus).toBe("DAYS_28_AVAILABLE");
    expect(coverage.status).toBe("PARTIAL");
  });

  it("does not block collaborative posts whose core metrics are NOT_SUPPORTED", async () => {
    resetMocks();
    setReadyJulyWithPosts([{
      metricAvailabilityState: {
        ...availablePostMetrics,
        views: "NOT_SUPPORTED",
        total_views: "NOT_SUPPORTED",
        total_interactions: "NOT_SUPPORTED",
        follows: "NOT_SUPPORTED",
      },
    }]);

    const coverage = await getCoverage("conn-1", new Date("2026-07-01T00:00:00.000Z"), new Date("2026-07-31T23:59:59.999Z"));

    expect(coverage.status).toBe("COMPLETE");
    expect(coverage.postInsightCoverage.missingMetrics).toEqual([]);
    expect(coverage.postInsightCoverage.unsupportedMetrics).toEqual(expect.arrayContaining(["views", "total_views", "total_interactions", "follows"]));
  });

  it("ignores legacy facebook_views failures in report readiness", async () => {
    resetMocks();
    setReadyJulyWithPosts([{
      metrics: { facebook_views: 0 },
      metricAvailabilityState: { ...availablePostMetrics, facebook_views: "FAILED" },
    }]);

    const coverage = await getCoverage("conn-1", new Date("2026-07-01T00:00:00.000Z"), new Date("2026-07-31T23:59:59.999Z"));

    expect(coverage.status).toBe("COMPLETE");
    expect(coverage.postInsightCoverage.missingMetrics).not.toContain("facebook_views");
    expect(coverage.postInsightCoverage.unsupportedMetrics).not.toContain("facebook_views");
  });

  it("does not block an owned video whose follows metric is NOT_SUPPORTED", async () => {
    resetMocks();
    setReadyJulyWithPosts([{ metricAvailabilityState: { ...availablePostMetrics, follows: "NOT_SUPPORTED" } }]);

    const coverage = await getCoverage("conn-1", new Date("2026-07-01T00:00:00.000Z"), new Date("2026-07-31T23:59:59.999Z"));

    expect(coverage.status).toBe("COMPLETE");
    expect(coverage.postInsightCoverage.missingMetrics).not.toContain("follows");
    expect(coverage.postInsightCoverage.unsupportedMetrics).toContain("follows");
  });

  it("trusts a valid finalized snapshot when a later live follows refresh fails", async () => {
    resetMocks();
    setReadyJulyWithPosts([]);
    mockDb.socialPost.findMany.mockResolvedValue([{
      id: "post-1",
      publishedAt: new Date("2026-07-02T00:00:00.000Z"),
      metrics: {},
      metricAvailabilityState: { ...availablePostMetrics, follows: "FAILED" },
    }]);
    mockDb.socialPostMetricSnapshot.findMany.mockResolvedValue([{
      postId: "post-1",
      views: 100,
      totalViews: 100,
      totalInteractions: 20,
      likes: 10,
      comments: 1,
      saved: 2,
      shares: 3,
      follows: 8,
      validityState: "VALID",
      metricAvailability: Object.fromEntries(Object.keys(availablePostMetrics).filter((metric) => metric !== "reach").map((metric) => [metric, "AVAILABLE"])),
    }]);

    const coverage = await getCoverage("conn-1", new Date("2026-07-01T00:00:00.000Z"), new Date("2026-07-31T23:59:59.999Z"));

    expect(coverage.status).toBe("COMPLETE");
    expect(coverage.postInsightCoverage.missingMetrics).not.toContain("follows");
  });

  it("keeps a repair-needed legacy snapshot incomplete until deliberately repaired", async () => {
    resetMocks();
    setReadyJulyWithPosts([]);
    mockDb.socialPost.findMany.mockResolvedValue([{
      id: "post-1",
      publishedAt: new Date("2026-07-14T00:00:00.000Z"),
      metrics: {},
      metricAvailabilityState: { ...availablePostMetrics, views: "FAILED" },
    }]);
    mockDb.socialPostMetricSnapshot.findMany.mockResolvedValue([]);

    const coverage = await getCoverage("conn-1", new Date("2026-07-01T00:00:00.000Z"), new Date("2026-07-31T23:59:59.999Z"));

    expect(coverage.status).toBe("PARTIAL");
    expect(coverage.postInsightCoverage.missingMetrics).toContain("views");
    expect(mockDb.socialPostMetricSnapshot.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ validityState: { not: "REPAIR_NEEDED" } }),
    }));
  });

  it.each(["FAILED", "PENDING"])("keeps %s post metrics blocking readiness", async (state) => {
    resetMocks();
    setReadyJulyWithPosts([{ metricAvailabilityState: { ...availablePostMetrics, views: state } }]);

    const coverage = await getCoverage("conn-1", new Date("2026-07-01T00:00:00.000Z"), new Date("2026-07-31T23:59:59.999Z"));

    expect(coverage.status).toBe("PARTIAL");
    expect(coverage.postInsightCoverage.missingMetrics).toContain("views");
  });

  it("completes mixed AVAILABLE and NOT_SUPPORTED post metrics", async () => {
    resetMocks();
    setReadyJulyWithPosts([
      { metricAvailabilityState: { ...availablePostMetrics } },
      { metricAvailabilityState: { ...availablePostMetrics, views: "NOT_SUPPORTED", total_interactions: "NOT_SUPPORTED", follows: "NOT_SUPPORTED" } },
    ]);

    const coverage = await getCoverage("conn-1", new Date("2026-07-01T00:00:00.000Z"), new Date("2026-07-31T23:59:59.999Z"));

    expect(coverage.status).toBe("COMPLETE");
    expect(coverage.postInsightCoverage.availableMetrics).toContain("views");
    expect(coverage.postInsightCoverage.unsupportedMetrics).toContain("views");
    expect(coverage.postInsightCoverage.missingMetrics).toEqual([]);
  });

  it("keeps mixed NOT_SUPPORTED metrics with one FAILED metric incomplete", async () => {
    resetMocks();
    setReadyJulyWithPosts([
      { metricAvailabilityState: { ...availablePostMetrics, views: "NOT_SUPPORTED", total_interactions: "NOT_SUPPORTED", follows: "NOT_SUPPORTED" } },
      { metricAvailabilityState: { ...availablePostMetrics, views: "FAILED" } },
    ]);

    const coverage = await getCoverage("conn-1", new Date("2026-07-01T00:00:00.000Z"), new Date("2026-07-31T23:59:59.999Z"));

    expect(coverage.status).toBe("PARTIAL");
    expect(coverage.postInsightCoverage.unsupportedMetrics).toContain("views");
    expect(coverage.postInsightCoverage.missingMetrics).toContain("views");
  });

  it("does not mark July as closing for a generic MONTH_END_CLOSEOUT that may target an older month", async () => {
    resetMocks();
    setIncompleteJulyMocks();
    mockDb.syncJob.findMany.mockResolvedValue([{ type: SyncJobType.MONTH_END_CLOSEOUT, status: SyncJobStatus.QUEUED, payload: null }]);

    const coverage = await getCoverage("conn-1", new Date("2026-07-01T00:00:00.000Z"), new Date("2026-07-31T23:59:59.999Z"));

    expect(coverage.status).toBe("PARTIAL");
    expect(coverage.warnings).toEqual([STALLED_INCOMPLETE_MESSAGE]);
  });

  it("marks July as closing only for an overlapping REPORT_PERIOD_CLOSEOUT payload", async () => {
    resetMocks();
    setIncompleteJulyMocks();
    mockDb.syncJob.findMany.mockResolvedValue([{
      type: SyncJobType.REPORT_PERIOD_CLOSEOUT,
      status: SyncJobStatus.QUEUED,
      payload: { periodStart: "2026-07-01T00:00:00.000Z", periodEnd: "2026-07-31T23:59:59.999Z" },
    }]);

    const coverage = await getCoverage("conn-1", new Date("2026-07-01T00:00:00.000Z"), new Date("2026-07-31T23:59:59.999Z"));

    expect(coverage.status).toBe("SYNCING");
    expect(coverage.warnings).toEqual([CLOSING_MONTH_MESSAGE]);
  });

  it("ignores a REPORT_PERIOD_CLOSEOUT payload that does not overlap July", async () => {
    resetMocks();
    setIncompleteJulyMocks();
    mockDb.syncJob.findMany.mockResolvedValue([{
      type: SyncJobType.REPORT_PERIOD_CLOSEOUT,
      status: SyncJobStatus.RUNNING,
      payload: { periodStart: "2026-06-01T00:00:00.000Z", periodEnd: "2026-06-30T23:59:59.999Z" },
    }]);

    const coverage = await getCoverage("conn-1", new Date("2026-07-01T00:00:00.000Z"), new Date("2026-07-31T23:59:59.999Z"));

    expect(coverage.status).toBe("PARTIAL");
    expect(coverage.warnings).toEqual([STALLED_INCOMPLETE_MESSAGE]);
  });

  it("ignores an unrelated incremental job for an old finalized report", async () => {
    resetMocks();
    setIncompleteJulyMocks();
    mockDb.syncJob.findMany.mockResolvedValue([{ type: SyncJobType.INCREMENTAL_MEDIA_SYNC, status: SyncJobStatus.RUNNING, payload: null }]);

    const coverage = await getCoverage("conn-1", new Date("2026-07-01T00:00:00.000Z"), new Date("2026-07-31T23:59:59.999Z"));

    expect(coverage.status).toBe("PARTIAL");
    expect(coverage.warnings).toEqual([STALLED_INCOMPLETE_MESSAGE]);
  });

  it("returns SYNCING and a friendly message when a real historical backfill job is queued/running", async () => {
    resetMocks();
    mockDb.socialConnection.findUnique.mockResolvedValue(
      baseConnection({
        historicalBackfillStatus: BackfillStatus.PARTIAL,
        collaborativeBackfillStatus: BackfillStatus.COMPLETED,
      }),
    );
    mockDb.syncJob.findMany.mockResolvedValue([{ type: SyncJobType.HISTORICAL_MEDIA_BACKFILL, status: SyncJobStatus.QUEUED }]);
    mockDb.socialPost.aggregate
      .mockResolvedValueOnce({ _min: { publishedAt: new Date("2026-08-01T00:00:00.000Z") }, _max: { publishedAt: new Date("2026-08-07T00:00:00.000Z") }, _count: 2 })
      .mockResolvedValueOnce({ _min: { publishedAt: new Date("2026-08-01T00:00:00.000Z") }, _max: { publishedAt: new Date("2026-08-07T00:00:00.000Z") } });
    mockDb.socialPost.findMany.mockResolvedValue([
      { metrics: { reach: 100 }, metricAvailabilityState: { reach: "AVAILABLE" } },
    ]);
    mockDb.socialInsightSnapshot.findMany.mockResolvedValue([]);
    mockPeriodAccountReachForRange.mockResolvedValue({ value: null, accuracy: null, method: "UNAVAILABLE" });

    const coverage = await getCoverage("conn-1", new Date("2026-08-01T00:00:00.000Z"), new Date("2026-08-07T23:59:59.999Z"));
    expect(coverage.status).toBe("SYNCING");
    expect(coverage.warnings).toEqual([PREPARING_MONTH_MESSAGE]);
  });

  it("does not treat PARTIAL without an active job as SYNCING", async () => {
    resetMocks();
    mockDb.socialConnection.findUnique.mockResolvedValue(
      baseConnection({
        historicalBackfillStatus: BackfillStatus.PARTIAL,
        collaborativeBackfillStatus: BackfillStatus.COMPLETED,
        reachCoverageStart: null,
        reachDays28CoverageStart: null,
        followerCountCoverageStart: null,
        accountInsightsLastSyncedAt: null,
        accountInsightsBackfillCompletedAt: null,
        lastSuccessfulSyncAt: null,
      }),
    );
    mockDb.syncJob.findMany.mockResolvedValue([]);
    mockDb.socialPost.aggregate
      .mockResolvedValueOnce({ _min: { publishedAt: null }, _max: { publishedAt: null }, _count: 0 })
      .mockResolvedValueOnce({ _min: { publishedAt: null }, _max: { publishedAt: null } });
    mockDb.socialPost.findMany.mockResolvedValue([]);
    mockDb.socialInsightSnapshot.findMany.mockResolvedValue([]);
    mockPeriodAccountReachForRange.mockResolvedValue({ value: null, accuracy: null, method: "UNAVAILABLE" });

    const coverage = await getCoverage("conn-1", new Date("2026-08-01T00:00:00.000Z"), new Date("2026-08-03T23:59:59.999Z"));
    expect(coverage.status).not.toBe("SYNCING");
    expect(coverage.status).toBe("UNAVAILABLE");
    expect(coverage.warnings).toEqual([STALLED_INCOMPLETE_MESSAGE]);
    expect(coverage.warnings.some((w) => w.includes("جاري"))).toBe(false);
  });

  it("returns PARTIAL and a friendly message when coverage is incomplete and no sync is active", async () => {
    resetMocks();
    mockDb.socialConnection.findUnique.mockResolvedValue(
      baseConnection({
        historicalBackfillStatus: BackfillStatus.COMPLETED,
        collaborativeBackfillStatus: BackfillStatus.NOT_STARTED,
      }),
    );
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
    expect(coverage.warnings).toEqual([STALLED_INCOMPLETE_MESSAGE]);
    expect(coverage.warnings.every((warning) => !warning.includes("بيانات المنشورات التعاونية"))).toBe(true);
    expect(coverage.warnings.some((w) => w.includes("جاري"))).toBe(false);
  });

  it("never exposes raw backfill errors such as 'fetch failed' in employee-facing warnings", async () => {
    resetMocks();
    mockDb.socialConnection.findUnique.mockResolvedValue(
      baseConnection({
        historicalBackfillStatus: BackfillStatus.FAILED,
        historicalBackfillLastError: "fetch failed",
        collaborativeBackfillStatus: BackfillStatus.FAILED,
        collaborativeBackfillLastError: "Unsupported get request. Object with ID '123' does not exist",
      }),
    );
    mockDb.syncJob.findMany.mockResolvedValue([]);
    mockDb.socialPost.aggregate
      .mockResolvedValueOnce({ _min: { publishedAt: new Date("2026-08-01T00:00:00.000Z") }, _max: { publishedAt: new Date("2026-08-03T00:00:00.000Z") }, _count: 2 })
      .mockResolvedValueOnce({ _min: { publishedAt: new Date("2026-08-01T00:00:00.000Z") }, _max: { publishedAt: new Date("2026-08-03T00:00:00.000Z") } });
    mockDb.socialPost.findMany.mockResolvedValue([
      { metrics: { reach: 100 }, metricAvailabilityState: { reach: "AVAILABLE" } },
    ]);
    mockDb.socialInsightSnapshot.findMany.mockResolvedValue([]);
    mockPeriodAccountReachForRange.mockResolvedValue({ value: null, accuracy: null, method: "UNAVAILABLE" });

    const coverage = await getCoverage("conn-1", new Date("2026-08-01T00:00:00.000Z"), new Date("2026-08-03T23:59:59.999Z"));
    expect(coverage.status).toBe("FAILED");
    expect(coverage.warnings).toEqual([STALLED_INCOMPLETE_MESSAGE]);
    expect(coverage.warnings.some((w) => w.includes("fetch failed"))).toBe(false);
    expect(coverage.warnings.some((w) => w.includes("Unsupported get request"))).toBe(false);
    expect(coverage.warnings.some((w) => w.includes("PARTIAL") || w.includes("FAILED"))).toBe(false);
  });

  it("is a read-only status check: it never creates/enqueues a SyncJob", async () => {
    resetMocks();
    mockDb.socialConnection.findUnique.mockResolvedValue(
      baseConnection({
        historicalBackfillStatus: BackfillStatus.PARTIAL,
        collaborativeBackfillStatus: BackfillStatus.NOT_STARTED,
        reachCoverageStart: null,
        reachDays28CoverageStart: null,
        followerCountCoverageStart: null,
        accountInsightsLastSyncedAt: null,
        accountInsightsBackfillCompletedAt: null,
        lastSuccessfulSyncAt: null,
      }),
    );
    mockDb.syncJob.findMany.mockResolvedValue([]);
    mockDb.socialPost.aggregate
      .mockResolvedValueOnce({ _min: { publishedAt: null }, _max: { publishedAt: null }, _count: 0 })
      .mockResolvedValueOnce({ _min: { publishedAt: null }, _max: { publishedAt: null } });
    mockDb.socialPost.findMany.mockResolvedValue([]);
    mockDb.socialInsightSnapshot.findMany.mockResolvedValue([]);
    mockPeriodAccountReachForRange.mockResolvedValue({ value: null, accuracy: null, method: "UNAVAILABLE" });

    await getCoverage("conn-1", new Date("2026-08-01T00:00:00.000Z"), new Date("2026-08-03T23:59:59.999Z"));

    expect(mockDb.syncJob.create).not.toHaveBeenCalled();
  });

  it("logs technical diagnostics but keeps employee warnings friendly", async () => {
    resetMocks();
    mockDb.socialConnection.findUnique.mockResolvedValue(
      baseConnection({
        historicalBackfillStatus: BackfillStatus.FAILED,
        historicalBackfillLastError: "fetch failed",
        historicalBackfillRetryCount: 3,
        collaborativeBackfillStatus: BackfillStatus.COMPLETED,
      }),
    );
    mockDb.syncJob.findMany.mockResolvedValue([]);
    mockDb.socialPost.aggregate
      .mockResolvedValueOnce({ _min: { publishedAt: null }, _max: { publishedAt: null }, _count: 0 })
      .mockResolvedValueOnce({ _min: { publishedAt: null }, _max: { publishedAt: null } });
    mockDb.socialPost.findMany.mockResolvedValue([]);
    mockDb.socialInsightSnapshot.findMany.mockResolvedValue([]);
    mockPeriodAccountReachForRange.mockResolvedValue({ value: null, accuracy: null, method: "UNAVAILABLE" });

    await getCoverage("conn-1", new Date("2026-08-01T00:00:00.000Z"), new Date("2026-08-03T23:59:59.999Z"));

    const diagnosticsCall = mockLogEvent.mock.calls.find(([event]) => event === "report.coverage.diagnostics");
    expect(diagnosticsCall).toBeTruthy();
    const diagnostics = diagnosticsCall![1] as Record<string, unknown>;
    expect(diagnostics.connectionId).toBe("conn-1");
    expect((diagnostics.lastErrors as Record<string, unknown>).historical).toBe("fetch failed");
    expect(diagnostics.retryAttempts).toEqual({ historical: 3, collaborative: 0 });
  });

  it("keeps approval safety by returning a non-COMPLETE status when data is genuinely incomplete", async () => {
    resetMocks();
    mockDb.socialConnection.findUnique.mockResolvedValue(
      baseConnection({
        historicalBackfillStatus: BackfillStatus.PARTIAL,
        collaborativeBackfillStatus: BackfillStatus.COMPLETED,
      }),
    );
    mockDb.syncJob.findMany.mockResolvedValue([]);
    mockDb.socialPost.aggregate
      .mockResolvedValueOnce({ _min: { publishedAt: null }, _max: { publishedAt: null }, _count: 0 })
      .mockResolvedValueOnce({ _min: { publishedAt: null }, _max: { publishedAt: null } });
    mockDb.socialPost.findMany.mockResolvedValue([]);
    mockDb.socialInsightSnapshot.findMany.mockResolvedValue([]);
    mockPeriodAccountReachForRange.mockResolvedValue({ value: null, accuracy: null, method: "UNAVAILABLE" });

    const coverage = await getCoverage("conn-1", new Date("2026-08-01T00:00:00.000Z"), new Date("2026-08-03T23:59:59.999Z"));
    expect(coverage.status).not.toBe("COMPLETE");
    expect(coverage.warnings).toEqual([STALLED_INCOMPLETE_MESSAGE]);
  });

  it("reports reach status independently of the simplified employee warning", async () => {
    resetMocks();
    mockDb.socialConnection.findUnique.mockResolvedValue(baseConnection());
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
    expect(coverage.status).toBe("PARTIAL");
    expect(coverage.warnings).toEqual([STALLED_INCOMPLETE_MESSAGE]);
  });
});
