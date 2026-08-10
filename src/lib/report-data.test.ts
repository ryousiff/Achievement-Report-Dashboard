import { beforeEach, describe, expect, it, vi } from "vitest";
import { BackfillStatus, MediaSource } from "@prisma/client";
import { completeDailySeries, reportPosts, buildStandardReportBlocks, clearReachCache, type ReachResult } from "@/lib/report-data";

const mockDb = vi.hoisted(() => ({
  socialPost: { findMany: vi.fn() },
  socialInsightSnapshot: { findMany: vi.fn() },
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
  mockDb.socialPost.findMany.mockReset();
  mockDb.socialInsightSnapshot.findMany.mockReset();
  mockDb.socialConnection.findFirst.mockReset();
  mockGraph.mockReset();
  mockDecryptToken.mockReset();
});

function setGraphTotalValue(value: number) {
  mockGraph.mockResolvedValue({ data: [{ total_value: { value } }] });
}

function setGraphTotalValuesByWindow(values: Record<string, number>) {
  mockGraph.mockImplementation(async (_path: string, _token: string, parameters: Record<string, string>) => {
    const key = `${parameters.since}__${parameters.until}`;
    const value = values[key] ?? null;
    if (value === null) return { data: [] };
    return { data: [{ total_value: { value } }] };
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
    setGraphTotalValue(300);

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
    setGraphTotalValuesByWindow({
      // A (D1..D30): since 2026-07-01, until 2026-07-31
      "1782864000__1785456000": 1000,
      // B (D2..D31): since 2026-07-02, until 2026-08-01
      "1782950400__1785542400": 1100,
      // C (D2..D30): since 2026-07-02, until 2026-07-31
      "1782950400__1785456000": 900,
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
    setGraphTotalValue(150);

    const blocks = await buildStandardReportBlocks("client-1", new Date("2026-08-01T00:00:00.000Z"), new Date("2026-08-01T23:59:59.999Z"));
    const kpiBlock = blocks.find((block) => block.type === "KPI" && block.title === "أهم الإحصائيات");
    expect(kpiBlock).toBeDefined();
    const kpis = (kpiBlock!.content as Record<string, unknown>).kpis as Array<{ id: string; value: string }>;
    const reachKpi = kpis.find((kpi) => kpi.id === "reach");
    const dailySumKpi = kpis.find((kpi) => kpi.id === "daily-reach-sum");
    expect(reachKpi?.value).toBe("150");
    expect(dailySumKpi?.value).toBe("300");
  });
});
