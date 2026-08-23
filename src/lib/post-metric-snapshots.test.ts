import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  isMonthFinalized,
  monthPeriodUTC,
  persistPostMetricSnapshot,
  resolveReportPostMetrics,
  snapshotFieldsFromMetrics,
  summarizePostMetricsAccuracy,
} from "@/lib/post-metric-snapshots";

const mockDb = vi.hoisted(() => ({
  socialPostMetricSnapshot: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
    findMany: vi.fn(),
  },
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));

beforeEach(() => {
  mockDb.socialPostMetricSnapshot.findUnique.mockReset();
  mockDb.socialPostMetricSnapshot.upsert.mockReset();
  mockDb.socialPostMetricSnapshot.findMany.mockReset();
});

describe("monthPeriodUTC / isMonthFinalized", () => {
  it("returns the first and last instant of the UTC calendar month containing the date", () => {
    const { periodStart, periodEnd } = monthPeriodUTC(new Date("2026-07-15T12:00:00.000Z"));
    expect(periodStart.toISOString()).toBe("2026-07-01T00:00:00.000Z");
    expect(periodEnd.toISOString()).toBe("2026-07-31T23:59:59.999Z");
  });

  it("handles a December -> January rollover", () => {
    const { periodEnd } = monthPeriodUTC(new Date("2025-12-10T00:00:00.000Z"));
    expect(periodEnd.toISOString()).toBe("2025-12-31T23:59:59.999Z");
  });

  it("treats a month as finalized only once its last instant is in the past", () => {
    const periodEnd = new Date("2026-07-31T23:59:59.999Z");
    expect(isMonthFinalized(periodEnd, new Date("2026-07-31T23:59:59.999Z"))).toBe(false);
    expect(isMonthFinalized(periodEnd, new Date("2026-08-01T00:00:00.000Z"))).toBe(true);
  });
});

describe("snapshotFieldsFromMetrics", () => {
  it("defaults missing counters to 0 but keeps totalViews nullable", () => {
    expect(snapshotFieldsFromMetrics({ views: 10 })).toEqual({
      views: 10,
      totalViews: null,
      totalInteractions: 0,
      likes: 0,
      comments: 0,
      saved: 0,
      shares: 0,
      follows: 0,
    });
  });
});

describe("persistPostMetricSnapshot", () => {
  const publishedAt = new Date("2026-07-10T00:00:00.000Z");

  it("keeps updating the snapshot while the post's publish month is still open", async () => {
    mockDb.socialPostMetricSnapshot.findUnique.mockResolvedValue(null);
    mockDb.socialPostMetricSnapshot.upsert.mockResolvedValue(null);

    await persistPostMetricSnapshot("post-1", publishedAt, { views: 100 }, new Date("2026-07-15T00:00:00.000Z"));

    expect(mockDb.socialPostMetricSnapshot.upsert).toHaveBeenCalledTimes(1);
    const call = mockDb.socialPostMetricSnapshot.upsert.mock.calls[0][0] as { create: Record<string, unknown> };
    expect(call.create.finalizedAt).toBeNull();
    expect(call.create.views).toBe(100);
  });

  it("finalizes the snapshot the first time it is written after the month has fully elapsed", async () => {
    mockDb.socialPostMetricSnapshot.findUnique.mockResolvedValue(null);
    mockDb.socialPostMetricSnapshot.upsert.mockResolvedValue(null);

    const now = new Date("2026-08-01T03:00:00.000Z"); // just after July ended
    await persistPostMetricSnapshot("post-1", publishedAt, { views: 714848 }, now);

    const call = mockDb.socialPostMetricSnapshot.upsert.mock.calls[0][0] as { create: Record<string, unknown> };
    expect(call.create.finalizedAt).toEqual(now);
    expect(call.create.views).toBe(714848);
  });

  it("never overwrites an already-finalized snapshot, even with different metrics", async () => {
    mockDb.socialPostMetricSnapshot.findUnique.mockResolvedValue({ finalizedAt: new Date("2026-08-01T03:00:00.000Z") });

    await persistPostMetricSnapshot("post-1", publishedAt, { views: 999999 }, new Date("2026-08-20T00:00:00.000Z"));

    expect(mockDb.socialPostMetricSnapshot.upsert).not.toHaveBeenCalled();
  });
});

describe("resolveReportPostMetrics", () => {
  it("uses live metrics for a post whose publish month has not ended yet", async () => {
    const now = new Date("2026-08-15T00:00:00.000Z");
    const posts = [{ id: "p1", publishedAt: new Date("2026-08-01T00:00:00.000Z"), metrics: { views: 500 } }];

    const resolved = await resolveReportPostMetrics(posts, now);

    expect(mockDb.socialPostMetricSnapshot.findMany).not.toHaveBeenCalled();
    expect(resolved.get("p1")).toEqual({ metrics: snapshotFieldsFromMetrics({ views: 500 }), source: "LIVE" });
  });

  it("uses the immutable snapshot for a finalized month when one exists, ignoring the (drifted) live metrics", async () => {
    const now = new Date("2026-08-15T00:00:00.000Z");
    const posts = [{ id: "p1", publishedAt: new Date("2026-07-10T00:00:00.000Z"), metrics: { views: 999999 } }]; // drifted live value
    mockDb.socialPostMetricSnapshot.findMany.mockResolvedValue([
      { postId: "p1", views: 714848, totalViews: null, totalInteractions: 1000, likes: 500, comments: 50, saved: 20, shares: 10, follows: 5 },
    ]);

    const resolved = await resolveReportPostMetrics(posts, now);

    expect(resolved.get("p1")).toEqual({
      source: "SNAPSHOT",
      metrics: { views: 714848, totalViews: null, totalInteractions: 1000, likes: 500, comments: 50, saved: 20, shares: 10, follows: 5 },
    });
  });

  it("falls back to (flagged) live metrics for a finalized month with no captured snapshot", async () => {
    const now = new Date("2026-08-15T00:00:00.000Z");
    const posts = [{ id: "p1", publishedAt: new Date("2026-07-10T00:00:00.000Z"), metrics: { views: 400 } }];
    mockDb.socialPostMetricSnapshot.findMany.mockResolvedValue([]);

    const resolved = await resolveReportPostMetrics(posts, now);

    expect(resolved.get("p1")?.source).toBe("LIFETIME_FALLBACK");
    expect(resolved.get("p1")?.metrics.views).toBe(400);
  });

  it("performance: resolves any number of finalized posts with a single bulk findMany call, not one query per post", async () => {
    const now = new Date("2026-08-15T00:00:00.000Z");
    const posts = Array.from({ length: 25 }, (_, i) => ({
      id: `p${i}`,
      publishedAt: new Date("2026-07-10T00:00:00.000Z"),
      metrics: { views: i },
    }));
    mockDb.socialPostMetricSnapshot.findMany.mockResolvedValue(
      posts.map((post, i) => ({
        postId: post.id,
        views: 1000 + i,
        totalViews: null,
        totalInteractions: 0,
        likes: 0,
        comments: 0,
        saved: 0,
        shares: 0,
        follows: 0,
      })),
    );

    const resolved = await resolveReportPostMetrics(posts, now);

    expect(mockDb.socialPostMetricSnapshot.findMany).toHaveBeenCalledTimes(1);
    expect(resolved.size).toBe(25);
    expect(resolved.get("p10")?.metrics.views).toBe(1010);
  });
});

describe("summarizePostMetricsAccuracy", () => {
  it("returns LIFETIME_FALLBACK if any source is a fallback", () => {
    expect(summarizePostMetricsAccuracy(["SNAPSHOT", "LIFETIME_FALLBACK", "LIVE"])).toBe("LIFETIME_FALLBACK");
  });

  it("returns the single shared source when every post agrees", () => {
    expect(summarizePostMetricsAccuracy(["SNAPSHOT", "SNAPSHOT"])).toBe("SNAPSHOT");
    expect(summarizePostMetricsAccuracy(["LIVE"])).toBe("LIVE");
  });

  it("returns MIXED for a period spanning both an open and a finalized month (not drift)", () => {
    expect(summarizePostMetricsAccuracy(["SNAPSHOT", "LIVE"])).toBe("MIXED");
  });

  it("returns LIVE for an empty set", () => {
    expect(summarizePostMetricsAccuracy([])).toBe("LIVE");
  });
});
