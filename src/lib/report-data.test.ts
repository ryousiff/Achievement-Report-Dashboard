import { beforeEach, describe, expect, it, vi } from "vitest";
import { BackfillStatus, MediaSource } from "@prisma/client";
import { completeDailySeries, reportPosts, buildStandardReportBlocks, periodAccountFollowers, periodAccountViews, dailyFollowerMovement, currentFollowersCount, clearReachCache, clearFollowersCache, clearViewsCache, type ReachResult } from "@/lib/report-data";

const mockDb = vi.hoisted(() => ({
  socialPost: { findMany: vi.fn() },
  socialInsightSnapshot: { findMany: vi.fn(), findFirst: vi.fn(), upsert: vi.fn() },
  socialConnection: { findFirst: vi.fn() },
}));

const mockGraph = vi.hoisted(() => vi.fn());
const mockMetaSync = vi.hoisted(() => ({ graph: mockGraph, MetaSyncError: class {} }));

const mockDecryptToken = vi.hoisted(() => vi.fn());
const mockTokenEncryption = vi.hoisted(() => ({ decryptToken: mockDecryptToken }));

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/meta-sync", () => mockMetaSync);
vi.mock("@/lib/token-encryption", () => mockTokenEncryption);

beforeEach(() => {
  clearReachCache();
  clearFollowersCache();
  clearViewsCache();
  mockDb.socialPost.findMany.mockReset();
  mockDb.socialInsightSnapshot.findMany.mockReset();
  mockDb.socialInsightSnapshot.findFirst.mockReset();
  mockDb.socialInsightSnapshot.upsert.mockReset();
  mockDb.socialConnection.findFirst.mockReset();
  mockGraph.mockReset();
  mockDecryptToken.mockReset();
});

function setGraphReachValue(value: number) {
  mockGraph.mockImplementation(async (_path: string, _token: string, parameters: Record<string, string>) => {
    if (parameters.metric === "follows_and_unfollows") {
      return {
        data: [{
          total_value: {
            breakdowns: [{
              dimension_keys: ["follow_type"],
              results: [
                { dimension_values: ["FOLLOWER"], value },
                { dimension_values: ["NON_FOLLOWER"], value: Math.floor(value / 2) },
              ],
            }],
          },
        }],
      };
    }
    return { data: [{ total_value: { value } }] };
  });
}

function setGraphReachValuesByWindow(values: Record<string, { reach?: number; gained?: number; lost?: number }>) {
  mockGraph.mockImplementation(async (_path: string, _token: string, parameters: Record<string, string>) => {
    const key = `${parameters.since}__${parameters.until}`;
    const entry = values[key] ?? null;
    if (entry === null) return { data: [] };
    if (parameters.metric === "follows_and_unfollows") {
      return {
        data: [{
          total_value: {
            breakdowns: [{
              dimension_keys: ["follow_type"],
              results: [
                { dimension_values: ["FOLLOWER"], value: entry.gained ?? 0 },
                { dimension_values: ["NON_FOLLOWER"], value: entry.lost ?? 0 },
              ],
            }],
          },
        }],
      };
    }
    return { data: [{ total_value: { value: entry.reach ?? 0 } }] };
  });
}

function defaultConnection() {
  return { id: "conn-1", clientId: "client-1", externalAccountId: "acc-1", encryptedToken: "enc-token" };
}

describe("completeDailySeries", () => {
  it("includes both report-period boundaries and fills missing dates with zero", () => {
    expect(completeDailySeries(new Date("2026-01-30T00:00:00.000Z"), new Date("2026-02-01T00:00:00.000Z"), [["2026-01-31", 4]])).toEqual([["2026-01-30", 0], ["2026-01-31", 4], ["2026-02-01", 0]]);
  });
});

describe("reportPosts", () => {
  it("includes both owned and collaborative posts and marks collaborative posts", async () => {
    mockDb.socialPost.findMany.mockResolvedValue([
      { id: "p1", externalPostId: "ig-1", caption: "Owned", mediaType: "IMAGE", mediaUrl: null, thumbnailUrl: null, permalink: null, publishedAt: new Date("2026-08-01T00:00:00.000Z"), metrics: { likes: 10, comments: 2 }, metricAvailability: { likes: "returned", comments: "returned" }, metricAvailabilityState: null, mediaSource: MediaSource.OWNED },
      { id: "p2", externalPostId: "ig-2", caption: "Collab", mediaType: "REELS", mediaUrl: null, thumbnailUrl: null, permalink: null, publishedAt: new Date("2026-08-02T00:00:00.000Z"), metrics: { likes: 5, comments: 1 }, metricAvailability: { likes: "returned", comments: "returned" }, metricAvailabilityState: null, mediaSource: MediaSource.COLLABORATIVE },
    ]);

    const posts = await reportPosts("client-1", new Date("2026-08-01T00:00:00.000Z"), new Date("2026-08-31T23:59:59.999Z"));
    expect(posts).toHaveLength(2);
    const collab = posts.find((post) => post.externalPostId === "ig-2");
    const owned = posts.find((post) => post.externalPostId === "ig-1");
    expect(collab?.mediaSource).toBe(MediaSource.COLLABORATIVE);
    expect(collab?.isCollaborative).toBe(true);
    expect(owned?.isCollaborative).toBe(false);
  });
});

describe("buildStandardReportBlocks", () => {
  it("uses exact account-level total_value reach for short periods, never summing post reach", async () => {
    mockDb.socialPost.findMany.mockResolvedValue([
      { id: "p1", externalPostId: "ig-1", caption: "Owned", mediaType: "IMAGE", mediaUrl: null, thumbnailUrl: null, permalink: null, publishedAt: new Date("2026-08-01T00:00:00.000Z"), metrics: { views: 100, total_interactions: 50, follows: 7 }, metricAvailability: { views: "returned", total_interactions: "returned", follows: "returned" }, metricAvailabilityState: { views: "AVAILABLE", total_interactions: "AVAILABLE", follows: "AVAILABLE" }, mediaSource: MediaSource.OWNED },
    ]);
    mockDb.socialInsightSnapshot.findMany.mockImplementation(async ({ where }: { where: { metric: string } }) => {
      if (where.metric === "follower_count") return [{ periodEnd: new Date("2026-08-01T07:00:00.000Z"), value: 42 }];
      if (where.metric === "reach") return [{ periodEnd: new Date("2026-08-01T07:00:00.000Z"), value: 300 }];
      return [];
    });
    mockDb.socialConnection.findFirst.mockResolvedValue(defaultConnection());
    mockDecryptToken.mockReturnValue("token-123");
    setGraphReachValue(300);

    const blocks = await buildStandardReportBlocks("client-1", new Date("2026-08-01T00:00:00.000Z"), new Date("2026-08-01T23:59:59.999Z"));
    const kpiBlock = blocks.find((block) => block.type === "KPI" && block.title === "أهم الإحصائيات");
    expect(kpiBlock).toBeDefined();
    const kpis = (kpiBlock!.content as Record<string, unknown>).kpis as Array<{ id: string; value: string; available: boolean; reachAccuracy?: string; reachMethod?: string }>;
    const reachKpi = kpis.find((kpi) => kpi.id === "reach");
    expect(reachKpi?.value).toBe("300");
    expect(reachKpi?.available).toBe(true);
    expect(reachKpi?.reachAccuracy).toBe("EXACT");
    expect(reachKpi?.reachMethod).toBe("META_TOTAL_VALUE");
  });

  it("estimates 31-day reach using overlapping total_value windows and labels it as estimated", async () => {
    mockDb.socialPost.findMany.mockResolvedValue([
      { id: "p1", externalPostId: "ig-1", caption: "Owned", mediaType: "IMAGE", mediaUrl: null, thumbnailUrl: null, permalink: null, publishedAt: new Date("2026-07-01T00:00:00.000Z"), metrics: { reach: 1234, views: 100, total_interactions: 50, follows: 7 }, metricAvailability: { reach: "returned", views: "returned", total_interactions: "returned", follows: "returned" }, metricAvailabilityState: { reach: "AVAILABLE", views: "AVAILABLE", total_interactions: "AVAILABLE", follows: "AVAILABLE" }, mediaSource: MediaSource.OWNED },
    ]);
    mockDb.socialInsightSnapshot.findMany.mockImplementation(async ({ where }: { where: { metric: string } }) => {
      if (where.metric === "follower_count") return Array.from({ length: 31 }, (_, i) => ({ periodEnd: new Date(`2026-07-${String(i + 1).padStart(2, "0")}T07:00:00.000Z`), value: 1 }));
      if (where.metric === "reach") return [];
      return [];
    });
    mockDb.socialConnection.findFirst.mockResolvedValue(defaultConnection());
    mockDecryptToken.mockReturnValue("token-123");
    // A = D1..D30 = 1000, B = D2..D31 = 1100, C = D2..D30 = 900
    // estimate = 1000 + 1100 - 900 = 1200
    setGraphReachValuesByWindow({
      // A (D1..D30): since 2026-07-01, until 2026-07-31
      "1782864000__1785456000": { reach: 1000, gained: 502, lost: 360 },
      // B (D2..D31): since 2026-07-02, until 2026-08-01
      "1782950400__1785542400": { reach: 1100, gained: 499, lost: 364 },
      // C (D2..D30): since 2026-07-02, until 2026-07-31
      "1782950400__1785456000": { reach: 900, gained: 489, lost: 350 },
    });

    const blocks = await buildStandardReportBlocks("client-1", new Date("2026-07-01T00:00:00.000Z"), new Date("2026-07-31T23:59:59.999Z"));
    const kpiBlock = blocks.find((block) => block.type === "KPI" && block.title === "أهم الإحصائيات");
    expect(kpiBlock).toBeDefined();
    const kpis = (kpiBlock!.content as Record<string, unknown>).kpis as Array<{ id: string; value: string; available: boolean; reachAccuracy?: string; reachMethod?: string; badge?: string; tooltip?: string }>;
    const reachKpi = kpis.find((kpi) => kpi.id === "reach");
    expect(reachKpi?.available).toBe(true);
    expect(reachKpi?.value).toBe("1,200");
    expect(reachKpi?.reachAccuracy).toBe("ESTIMATED");
    expect(reachKpi?.reachMethod).toBe("OVERLAPPING_WINDOWS_ESTIMATE");
    expect(reachKpi?.badge).toBe("تقديري");
    expect(reachKpi?.tooltip).toContain("قيمة تقديرية");
    // Post reach (1234) must not appear as the reach KPI.
    expect(reachKpi?.value).not.toBe("1,234");
  });

  it("keeps SUM(daily reach) as a separate, labelled metric and never uses it as unique reach", async () => {
    mockDb.socialPost.findMany.mockResolvedValue([
      { id: "p1", externalPostId: "ig-1", caption: "Owned", mediaType: "IMAGE", mediaUrl: null, thumbnailUrl: null, permalink: null, publishedAt: new Date("2026-08-01T00:00:00.000Z"), metrics: { views: 100, total_interactions: 50, follows: 7 }, metricAvailability: { views: "returned", total_interactions: "returned", follows: "returned" }, metricAvailabilityState: { views: "AVAILABLE", total_interactions: "AVAILABLE", follows: "AVAILABLE" }, mediaSource: MediaSource.OWNED },
    ]);
    mockDb.socialInsightSnapshot.findMany.mockImplementation(async ({ where }: { where: { metric: string } }) => {
      if (where.metric === "follower_count") return [{ periodEnd: new Date("2026-08-01T07:00:00.000Z"), value: 42 }];
      if (where.metric === "reach") return [{ periodEnd: new Date("2026-08-01T07:00:00.000Z"), value: 300 }];
      return [];
    });
    mockDb.socialConnection.findFirst.mockResolvedValue(defaultConnection());
    mockDecryptToken.mockReturnValue("token-123");
    setGraphReachValue(150);

    const blocks = await buildStandardReportBlocks("client-1", new Date("2026-08-01T00:00:00.000Z"), new Date("2026-08-01T23:59:59.999Z"));
    const kpiBlock = blocks.find((block) => block.type === "KPI" && block.title === "أهم الإحصائيات");
    expect(kpiBlock).toBeDefined();
    const kpis = (kpiBlock!.content as Record<string, unknown>).kpis as Array<{ id: string; value: string }>;
    const reachKpi = kpis.find((kpi) => kpi.id === "reach");
    const dailySumKpi = kpis.find((kpi) => kpi.id === "daily-reach-sum");
    expect(reachKpi?.value).toBe("150");
    expect(dailySumKpi?.value).toBe("300");
  });

  it("exposes gained, lost, and net follower movement from follows_and_unfollows", async () => {
    mockDb.socialPost.findMany.mockResolvedValue([
      { id: "p1", externalPostId: "ig-1", caption: "Owned", mediaType: "IMAGE", mediaUrl: null, thumbnailUrl: null, permalink: null, publishedAt: new Date("2026-07-01T00:00:00.000Z"), metrics: { views: 100, total_interactions: 50, follows: 7 }, metricAvailability: { views: "returned", total_interactions: "returned", follows: "returned" }, metricAvailabilityState: { views: "AVAILABLE", total_interactions: "AVAILABLE", follows: "AVAILABLE" }, mediaSource: MediaSource.OWNED },
    ]);
    mockDb.socialInsightSnapshot.findMany.mockResolvedValue([]);
    mockDb.socialInsightSnapshot.findFirst.mockResolvedValue(null);
    mockDb.socialInsightSnapshot.upsert.mockResolvedValue(null);
    mockDb.socialConnection.findFirst.mockResolvedValue(defaultConnection());
    mockDecryptToken.mockReturnValue("token-123");
    setGraphReachValuesByWindow({
      "1782864000__1785456000": { gained: 502, lost: 360 },
      "1782950400__1785542400": { gained: 499, lost: 364 },
      "1782950400__1785456000": { gained: 489, lost: 350 },
    });

    const blocks = await buildStandardReportBlocks("client-1", new Date("2026-07-01T00:00:00.000Z"), new Date("2026-07-31T23:59:59.999Z"));
    const kpiBlock = blocks.find((block) => block.type === "KPI" && block.title === "أهم الإحصائيات");
    expect(kpiBlock).toBeDefined();
    const kpis = (kpiBlock!.content as Record<string, unknown>).kpis as Array<{ id: string; value: string; available: boolean; followersAccuracy?: string; followersMethod?: string; badge?: string }>;
    const gainedKpi = kpis.find((kpi) => kpi.id === "follows");
    const lostKpi = kpis.find((kpi) => kpi.id === "followers-lost");
    const netKpi = kpis.find((kpi) => kpi.id === "net-follower-growth");
    expect(gainedKpi?.value).toBe("512");
    expect(gainedKpi?.followersMethod).toBe("OVERLAPPING_WINDOWS_COMPOSITION");
    expect(gainedKpi?.badge).toBe("مركّب");
    expect(lostKpi?.value).toBe("374");
    expect(netKpi?.value).toBe("+138");
  });

  it("never presents the daily follower chart's own sum as the period total when it diverges from periodAccountFollowers", async () => {
    mockDb.socialPost.findMany.mockResolvedValue([
      { id: "p1", externalPostId: "ig-1", caption: "Owned", mediaType: "IMAGE", mediaUrl: null, thumbnailUrl: null, permalink: null, publishedAt: new Date("2026-07-01T00:00:00.000Z"), metrics: { views: 100, total_interactions: 50, follows: 7 }, metricAvailability: { views: "returned", total_interactions: "returned", follows: "returned" }, metricAvailabilityState: { views: "AVAILABLE", total_interactions: "AVAILABLE", follows: "AVAILABLE" }, mediaSource: MediaSource.OWNED },
    ]);
    mockDb.socialInsightSnapshot.findMany.mockResolvedValue([]);
    mockDb.socialInsightSnapshot.findFirst.mockResolvedValue(null);
    mockDb.socialInsightSnapshot.upsert.mockResolvedValue(null);
    mockDb.socialConnection.findFirst.mockResolvedValue(defaultConnection());
    mockDecryptToken.mockReturnValue("token-123");
    // The account-level period total (via periodAccountFollowers' A/B/C window composition) resolves to
    // gained=512. The daily "day"-period breakdown call used only by the chart is not mocked for any
    // per-day window, so it returns no data — the chart's own daily sum is 0, deliberately diverging
    // from the validated 512 total to reproduce the real-world mismatch.
    setGraphReachValuesByWindow({
      "1782864000__1785456000": { gained: 502, lost: 360 },
      "1782950400__1785542400": { gained: 499, lost: 364 },
      "1782950400__1785456000": { gained: 489, lost: 350 },
    });

    const blocks = await buildStandardReportBlocks("client-1", new Date("2026-07-01T00:00:00.000Z"), new Date("2026-07-31T23:59:59.999Z"));
    const chartBlock = blocks.find((block) => block.type === "CHART" && block.title === "معدل اكتساب المتابعين اليومي");
    expect(chartBlock).toBeDefined();
    const content = chartBlock!.content as Record<string, unknown>;
    const chart = content.chart as { insight?: string } | undefined;
    expect(chart?.insight).toContain("512");
    expect(chart?.insight).toContain("المصدر المعتمد");
    // The chart's own (diverging) daily sum must never be presented as the period total on its own.
    expect(chart?.insight).not.toBe("إجمالي المتابعين الجدد خلال الأيام المتاحة: 0.");
  });
});

describe("periodAccountFollowers", () => {
  it("maps FOLLOWER to gained and NON_FOLLOWER to lost for <=30 day periods", async () => {
    mockDb.socialConnection.findFirst.mockResolvedValue(defaultConnection());
    mockDecryptToken.mockReturnValue("token-123");
    mockGraph.mockResolvedValue({
      data: [{
        total_value: {
          breakdowns: [{
            dimension_keys: ["follow_type"],
            results: [
              { dimension_values: ["FOLLOWER"], value: 100 },
              { dimension_values: ["NON_FOLLOWER"], value: 30 },
            ],
          }],
        },
      }],
    });

    const result = await periodAccountFollowers("client-1", new Date("2026-08-01T00:00:00.000Z"), new Date("2026-08-07T23:59:59.999Z"));
    expect(result.gained).toBe(100);
    expect(result.lost).toBe(30);
    expect(result.net).toBe(70);
    expect(result.accuracy).toBe("EXACT");
    expect(result.method).toBe("META_TOTAL_VALUE");
    expect(result.raw?.some((r) => r.dimension === "FOLLOWER" && r.value === 100)).toBe(true);
    expect(result.raw?.some((r) => r.dimension === "NON_FOLLOWER" && r.value === 30)).toBe(true);
  });

  it("returns unavailable when the API gives no breakdown", async () => {
    mockDb.socialConnection.findFirst.mockResolvedValue(defaultConnection());
    mockDecryptToken.mockReturnValue("token-123");
    mockGraph.mockResolvedValue({ data: [] });

    const result = await periodAccountFollowers("client-1", new Date("2026-08-01T00:00:00.000Z"), new Date("2026-08-07T23:59:59.999Z"));
    expect(result.gained).toBeNull();
    expect(result.lost).toBeNull();
    expect(result.method).toBe("UNAVAILABLE");
  });

  it("composes 31-day gained and lost using overlapping windows", async () => {
    mockDb.socialConnection.findFirst.mockResolvedValue(defaultConnection());
    mockDecryptToken.mockReturnValue("token-123");
    setGraphReachValuesByWindow({
      "1782864000__1785456000": { gained: 502, lost: 360 },
      "1782950400__1785542400": { gained: 499, lost: 364 },
      "1782950400__1785456000": { gained: 489, lost: 350 },
    });

    const result = await periodAccountFollowers("client-1", new Date("2026-07-01T00:00:00.000Z"), new Date("2026-07-31T23:59:59.999Z"));
    expect(result.gained).toBe(512);
    expect(result.lost).toBe(374);
    expect(result.net).toBe(138);
    expect(result.accuracy).toBe("DERIVED");
    expect(result.method).toBe("OVERLAPPING_WINDOWS_COMPOSITION");
  });
});

describe("dailyFollowerMovement", () => {
  it("fetches and stores one day at a time, exposing gained/lost/net", async () => {
    mockDb.socialConnection.findFirst.mockResolvedValue(defaultConnection());
    mockDecryptToken.mockReturnValue("token-123");
    mockDb.socialInsightSnapshot.findFirst.mockResolvedValue(null);
    mockDb.socialInsightSnapshot.upsert.mockResolvedValue(null);
    mockGraph.mockResolvedValue({
      data: [{
        total_value: {
          breakdowns: [{
            dimension_keys: ["follow_type"],
            results: [
              { dimension_values: ["FOLLOWER"], value: 10 },
              { dimension_values: ["NON_FOLLOWER"], value: 3 },
            ],
          }],
        },
      }],
    });

    const result = await dailyFollowerMovement("client-1", new Date("2026-08-01T00:00:00.000Z"), new Date("2026-08-03T23:59:59.999Z"));
    expect(result.complete).toBe(true);
    expect(result.gainedSeries.map(([, v]) => v)).toEqual([10, 10, 10]);
    expect(result.lostSeries.map(([, v]) => v)).toEqual([3, 3, 3]);
    expect(result.netSeries.map(([, v]) => v)).toEqual([7, 7, 7]);
    expect(mockDb.socialInsightSnapshot.upsert).toHaveBeenCalled();
    const upsertCalls = mockDb.socialInsightSnapshot.upsert.mock.calls as Array<[{ create: { metric: string } }]>;
    const metrics = upsertCalls.map((call) => call[0].create.metric);
    expect(metrics).toContain("followers_gained");
    expect(metrics).toContain("followers_lost");
  });
});

describe("periodAccountViews", () => {
  it("returns exact account-level total_value views for <=30 day periods", async () => {
    mockDb.socialConnection.findFirst.mockResolvedValue(defaultConnection());
    mockDecryptToken.mockReturnValue("token-123");
    mockGraph.mockResolvedValue({ data: [{ total_value: { value: 5000 } }] });

    const result = await periodAccountViews("client-1", new Date("2026-08-01T00:00:00.000Z"), new Date("2026-08-07T23:59:59.999Z"));
    expect(result.value).toBe(5000);
    expect(result.accuracy).toBe("EXACT");
    expect(result.method).toBe("META_TOTAL_VALUE");
  });

  it("composes 31-day total views using overlapping windows", async () => {
    mockDb.socialConnection.findFirst.mockResolvedValue(defaultConnection());
    mockDecryptToken.mockReturnValue("token-123");
    setGraphReachValuesByWindow({
      "1782864000__1785456000": { reach: 1000, gained: 0, lost: 0 },
      "1782950400__1785542400": { reach: 1100, gained: 0, lost: 0 },
      "1782950400__1785456000": { reach: 900, gained: 0, lost: 0 },
    });

    const result = await periodAccountViews("client-1", new Date("2026-07-01T00:00:00.000Z"), new Date("2026-07-31T23:59:59.999Z"));
    expect(result.value).toBe(1200);
    expect(result.accuracy).toBe("DERIVED");
    expect(result.method).toBe("OVERLAPPING_WINDOWS_COMPOSITION");
  });
});

describe("currentFollowersCount", () => {
  it("returns followers_count from the IG User node", async () => {
    mockDb.socialConnection.findFirst.mockResolvedValue(defaultConnection());
    mockDecryptToken.mockReturnValue("token-123");
    mockGraph.mockResolvedValue({ followers_count: 12345 });

    const count = await currentFollowersCount("client-1");
    expect(count).toBe(12345);
  });
});
