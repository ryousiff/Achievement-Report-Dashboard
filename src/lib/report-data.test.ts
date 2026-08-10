import { beforeEach, describe, expect, it, vi } from "vitest";
import { BackfillStatus, MediaSource } from "@prisma/client";
import { completeDailySeries, reportPosts, buildStandardReportBlocks } from "@/lib/report-data";

const mockDb = vi.hoisted(() => ({
  socialPost: { findMany: vi.fn() },
  socialInsightSnapshot: { findMany: vi.fn() },
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));

beforeEach(() => {
  mockDb.socialPost.findMany.mockReset();
  mockDb.socialInsightSnapshot.findMany.mockReset();
});

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
  it("uses account-level follows snapshots instead of summing post follows", async () => {
    mockDb.socialPost.findMany.mockResolvedValue([
      { id: "p1", externalPostId: "ig-1", caption: "Owned", mediaType: "IMAGE", mediaUrl: null, thumbnailUrl: null, permalink: null, publishedAt: new Date("2026-08-01T00:00:00.000Z"), metrics: { views: 100, total_interactions: 50, follows: 7 }, metricAvailability: { views: "returned", total_interactions: "returned", follows: "returned" }, metricAvailabilityState: { views: "AVAILABLE", total_interactions: "AVAILABLE", follows: "AVAILABLE" }, mediaSource: MediaSource.OWNED },
    ]);
    mockDb.socialInsightSnapshot.findMany.mockImplementation(async ({ where }: { where: { metric: string } }) => {
      if (where.metric === "follows") return [{ periodEnd: new Date("2026-08-01T00:00:00.000Z"), value: 42 }];
      return [{ periodEnd: new Date("2026-08-01T00:00:00.000Z"), value: 300 }];
    });

    const blocks = await buildStandardReportBlocks("client-1", new Date("2026-08-01T00:00:00.000Z"), new Date("2026-08-01T23:59:59.999Z"));
    const kpiBlock = blocks.find((block) => block.type === "KPI" && block.title === "أهم الإحصائيات");
    expect(kpiBlock).toBeDefined();
    const followsKpi = (kpiBlock!.content as Record<string, unknown>).kpis as Array<{ id: string; value: string }>;
    expect(followsKpi.find((kpi) => kpi.id === "follows")?.value).toBe("42");
    expect(followsKpi.find((kpi) => kpi.id === "reach")?.value).toBe("300");
  });
});
