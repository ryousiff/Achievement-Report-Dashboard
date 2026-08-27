import { beforeEach, describe, expect, it, vi } from "vitest";
import { BackfillStatus, MediaSource } from "@prisma/client";
import { completeDailySeries, reportPosts, buildStandardReportBlocks, periodAccountFollowers, periodAccountViews, dailyFollowerMovement, dailyFollowerMovementFromDatabase, currentFollowersCount, clearReachCache, clearFollowersCache, clearViewsCache, type ReachResult } from "@/lib/report-data";

const mockDb = vi.hoisted(() => ({
  socialPost: { findMany: vi.fn() },
  socialPostMetricSnapshot: { findMany: vi.fn(async (): Promise<Array<Record<string, unknown>>> => []), findUnique: vi.fn(async () => null), upsert: vi.fn() },
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
  mockDb.socialPostMetricSnapshot.findMany.mockReset();
  mockDb.socialPostMetricSnapshot.findMany.mockResolvedValue([]);
  mockDb.socialPostMetricSnapshot.findUnique.mockReset();
  mockDb.socialPostMetricSnapshot.findUnique.mockResolvedValue(null);
  mockDb.socialPostMetricSnapshot.upsert.mockReset();
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

describe("reportPosts — historical metric snapshot drift regression", () => {
  function julyPost(liveViews: number) {
    return {
      id: "p1",
      externalPostId: "ig-1",
      caption: "July post",
      mediaType: "IMAGE",
      mediaUrl: null,
      thumbnailUrl: null,
      permalink: null,
      publishedAt: new Date("2026-07-15T00:00:00.000Z"),
      metrics: { views: liveViews, total_interactions: 10, likes: 5, comments: 1, saved: 1, shares: 1, follows: 1 },
      metricAvailability: { views: "returned" },
      metricAvailabilityState: { views: "AVAILABLE" },
      mediaSource: MediaSource.OWNED,
    };
  }

  it("does not let a July post's August view growth change an already-finalized July report", async () => {
    // A finalized snapshot was captured for July at 714,848 views before the post kept gaining views in August.
    mockDb.socialPostMetricSnapshot.findMany.mockResolvedValue([{
      postId: "p1",
      views: 714848,
      totalViews: null,
      totalInteractions: 10,
      likes: 5,
      comments: 1,
      saved: 1,
      shares: 1,
      follows: 8,
      metricAvailability: { views: "AVAILABLE", total_views: "NOT_SUPPORTED", total_interactions: "AVAILABLE", likes: "AVAILABLE", comments: "AVAILABLE", saved: "AVAILABLE", shares: "AVAILABLE", follows: "AVAILABLE" },
    }]);
    // SocialPost.metrics has since drifted upward because the post is still within the recent-refresh window.
    mockDb.socialPost.findMany.mockResolvedValue([{
      ...julyPost(724692),
      metricAvailabilityState: { views: "AVAILABLE", follows: "FAILED" },
    }]);

    const now = new Date("2026-08-23T00:00:00.000Z");
    const posts = await reportPosts("client-1", new Date("2026-07-01T00:00:00.000Z"), new Date("2026-07-31T23:59:59.999Z"), now);

    expect(posts[0].metrics.views).toBe(714848);
    expect(posts[0].metrics.follows).toBe(8);
    expect(posts[0].metricAvailabilityState?.follows).toBe("AVAILABLE");
    expect(posts[0].metricsSource).toBe("SNAPSHOT");
  });

  it("current SocialPost.metrics keeps updating, and a report for the still-open month sees the newer value", async () => {
    mockDb.socialPost.findMany.mockResolvedValue([{
      ...julyPost(500),
      publishedAt: new Date("2026-08-05T00:00:00.000Z"),
      metricAvailabilityState: { views: "AVAILABLE", follows: "FAILED" },
    }]);

    const now = new Date("2026-08-23T00:00:00.000Z"); // August has not ended yet
    const posts = await reportPosts("client-1", new Date("2026-08-01T00:00:00.000Z"), new Date("2026-08-31T23:59:59.999Z"), now);

    expect(mockDb.socialPostMetricSnapshot.findMany).not.toHaveBeenCalled();
    expect(posts[0].metrics.views).toBe(500); // live value used as-is for the open month
    expect(posts[0].metricAvailabilityState?.follows).toBe("FAILED");
    expect(posts[0].metricsSource).toBe("LIVE");
  });

  it("uses the current lifetime value (flagged) for a finalized month with no captured snapshot yet, instead of pretending it is authoritative", async () => {
    mockDb.socialPostMetricSnapshot.findMany.mockResolvedValue([]);
    mockDb.socialPost.findMany.mockResolvedValue([julyPost(714848)]);

    const now = new Date("2026-08-23T00:00:00.000Z");
    const posts = await reportPosts("client-1", new Date("2026-07-01T00:00:00.000Z"), new Date("2026-07-31T23:59:59.999Z"), now);

    expect(posts[0].metrics.views).toBe(714848);
    expect(posts[0].metricsSource).toBe("LIFETIME_FALLBACK");
  });
});

describe("buildStandardReportBlocks — historical metric snapshot drift regression", () => {
  function postWithViews(id: string, publishedAt: string, liveViews: number, follows = 0) {
    return {
      id,
      externalPostId: `ig-${id}`,
      caption: `Post ${id}`,
      mediaType: "IMAGE",
      mediaUrl: null,
      thumbnailUrl: null,
      permalink: null,
      publishedAt: new Date(publishedAt),
      metrics: { views: liveViews, total_interactions: liveViews, likes: 0, comments: 0, saved: 0, shares: 0, follows },
      metricAvailability: { views: "returned", total_interactions: "returned" },
      metricAvailabilityState: { views: "AVAILABLE", total_interactions: "AVAILABLE" },
      mediaSource: MediaSource.OWNED,
    };
  }

  it("keeps top-post rankings for a finalized month based on the July snapshot, not the drifted live metrics", async () => {
    // Live data (as of August) makes p2 look bigger than p1 — but the July snapshot says the opposite.
    mockDb.socialPost.findMany.mockResolvedValue([
      postWithViews("p1", "2026-07-05T00:00:00.000Z", 500), // drifted-up live value
      postWithViews("p2", "2026-07-10T00:00:00.000Z", 300),
    ]);
    mockDb.socialPostMetricSnapshot.findMany.mockResolvedValue([
      { postId: "p1", views: 200, totalViews: null, totalInteractions: 200, likes: 0, comments: 0, saved: 0, shares: 0, follows: 0 },
      { postId: "p2", views: 900, totalViews: null, totalInteractions: 900, likes: 0, comments: 0, saved: 0, shares: 0, follows: 0 },
    ]);
    mockDb.socialInsightSnapshot.findMany.mockResolvedValue([]);
    mockDb.socialConnection.findFirst.mockResolvedValue(defaultConnection());
    mockDecryptToken.mockReturnValue("token-123");
    setGraphReachValue(0);

    const now = new Date("2026-08-23T00:00:00.000Z");
    const blocks = await buildStandardReportBlocks("client-1", new Date("2026-07-01T00:00:00.000Z"), new Date("2026-07-31T23:59:59.999Z"), {}, now);

    const topViewsBlock = blocks.find((block) => block.title === "أعلى المنشورات من حيث المشاهدات العضوية");
    const mediaItems = (topViewsBlock!.content as Record<string, unknown>).mediaItems as Array<{ id: string; metrics: { views: number } }>;
    expect(mediaItems[0].id).toBe("p2"); // 900 (snapshot) beats 200 (snapshot), even though live views say the opposite
    expect(mediaItems[0].metrics.views).toBe(900);

    const overviewKpi = blocks.find((block) => block.title === "أهم الإحصائيات");
    const overviewKpis = (overviewKpi!.content as Record<string, unknown>).kpis as Array<{ id: string; value: string }>;
    expect(overviewKpis.find((k) => k.id === "views")?.value).toBe("1,100"); // 200 + 900 from snapshots, not 500 + 300 live
  });

  it("leaves account-level TOTAL_VALUE reach/views/follower resolvers untouched by post-level snapshot logic", async () => {
    mockDb.socialPost.findMany.mockResolvedValue([postWithViews("p1", "2026-07-05T00:00:00.000Z", 100)]);
    mockDb.socialPostMetricSnapshot.findMany.mockResolvedValue([
      { postId: "p1", views: 50, totalViews: null, totalInteractions: 50, likes: 0, comments: 0, saved: 0, shares: 0, follows: 0 },
    ]);
    mockDb.socialInsightSnapshot.findMany.mockImplementation(async ({ where }: { where: { metric: string } }) => {
      if (where.metric === "reach") return [{ periodEnd: new Date("2026-07-31T07:00:00.000Z"), value: 300 }];
      return [];
    });
    mockDb.socialConnection.findFirst.mockResolvedValue(defaultConnection());
    mockDecryptToken.mockReturnValue("token-123");
    setGraphReachValue(300);

    const now = new Date("2026-08-23T00:00:00.000Z");
    const blocks = await buildStandardReportBlocks("client-1", new Date("2026-07-31T00:00:00.000Z"), new Date("2026-07-31T23:59:59.999Z"), {}, now);
    const overviewKpi = blocks.find((block) => block.title === "أهم الإحصائيات");
    const kpis = (overviewKpi!.content as Record<string, unknown>).kpis as Array<{ id: string; value: string; available: boolean }>;
    // Account-level reach still comes from the (unchanged) account TOTAL_VALUE resolver, unaffected by
    // the post-level snapshot mechanism above.
    expect(kpis.find((k) => k.id === "reach")?.value).toBe("300");
    expect(kpis.find((k) => k.id === "reach")?.available).toBe(true);
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
    mockDb.socialInsightSnapshot.findMany.mockResolvedValue([]);
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

  it("performance: uses a single pair of bulk queries (not one query per day) when every day is already stored, and never calls Meta", async () => {
    mockDb.socialConnection.findFirst.mockResolvedValue(defaultConnection());
    mockDecryptToken.mockReturnValue("token-123");
    mockDb.socialInsightSnapshot.findMany.mockImplementation(async ({ where }: { where: { metric: string } }) => {
      if (where.metric === "followers_gained") {
        return [
          { periodStart: new Date("2026-08-01T07:00:00.000Z"), value: 10 },
          { periodStart: new Date("2026-08-02T07:00:00.000Z"), value: 11 },
          { periodStart: new Date("2026-08-03T07:00:00.000Z"), value: 12 },
        ];
      }
      if (where.metric === "followers_lost") {
        return [
          { periodStart: new Date("2026-08-01T07:00:00.000Z"), value: 3 },
          { periodStart: new Date("2026-08-02T07:00:00.000Z"), value: 4 },
          { periodStart: new Date("2026-08-03T07:00:00.000Z"), value: 5 },
        ];
      }
      return [];
    });

    const result = await dailyFollowerMovement("client-1", new Date("2026-08-01T00:00:00.000Z"), new Date("2026-08-03T23:59:59.999Z"));

    expect(result.complete).toBe(true);
    expect(result.gainedSeries.map(([, v]) => v)).toEqual([10, 11, 12]);
    expect(result.lostSeries.map(([, v]) => v)).toEqual([3, 4, 5]);
    expect(result.netSeries.map(([, v]) => v)).toEqual([7, 7, 7]);
    // Exactly one findMany call per metric (gained, lost) — not one per day of the period.
    expect(mockDb.socialInsightSnapshot.findMany).toHaveBeenCalledTimes(2);
    expect(mockGraph).not.toHaveBeenCalled();
    expect(mockDb.socialInsightSnapshot.upsert).not.toHaveBeenCalled();
  });
});

describe("dailyFollowerMovementFromDatabase", () => {
  it("performance: reads a 31-day period using exactly two bulk queries instead of two queries per day", async () => {
    mockDb.socialConnection.findFirst.mockResolvedValue(defaultConnection());
    const days = Array.from({ length: 31 }, (_, i) => i + 1);
    mockDb.socialInsightSnapshot.findMany.mockImplementation(async ({ where }: { where: { metric: string } }) => {
      const value = where.metric === "followers_gained" ? 2 : 1;
      return days.map((day) => ({ periodStart: new Date(`2026-07-${String(day).padStart(2, "0")}T07:00:00.000Z`), value }));
    });

    const result = await dailyFollowerMovementFromDatabase("client-1", new Date("2026-07-01T00:00:00.000Z"), new Date("2026-07-31T23:59:59.999Z"));

    expect(result.complete).toBe(true);
    expect(result.gainedSeries).toHaveLength(31);
    expect(result.gainedSeries.every(([, v]) => v === 2)).toBe(true);
    expect(result.lostSeries.every(([, v]) => v === 1)).toBe(true);
    // Exactly one findMany call per metric for the whole 31-day range — not 62 (2 per day).
    expect(mockDb.socialInsightSnapshot.findMany).toHaveBeenCalledTimes(2);
  });

  it("only counts a day as present when both gained and lost snapshots exist for it, matching the previous per-day matching semantics", async () => {
    mockDb.socialConnection.findFirst.mockResolvedValue(defaultConnection());
    mockDb.socialInsightSnapshot.findMany.mockImplementation(async ({ where }: { where: { metric: string } }) => {
      if (where.metric === "followers_gained") {
        return [
          { periodStart: new Date("2026-08-01T07:00:00.000Z"), value: 5 },
          { periodStart: new Date("2026-08-02T07:00:00.000Z"), value: 6 },
        ];
      }
      // Day 2's "lost" snapshot is missing, so day 2 must be excluded even though "gained" exists.
      return [{ periodStart: new Date("2026-08-01T07:00:00.000Z"), value: 1 }];
    });

    const result = await dailyFollowerMovementFromDatabase("client-1", new Date("2026-08-01T00:00:00.000Z"), new Date("2026-08-02T23:59:59.999Z"));

    expect(result.complete).toBe(false);
    expect(result.gainedSeries).toEqual([["2026-08-01", 5], ["2026-08-02", 0]]);
    expect(result.lostSeries).toEqual([["2026-08-01", 1], ["2026-08-02", 0]]);
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
