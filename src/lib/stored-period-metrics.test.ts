import { beforeEach, describe, expect, it, vi } from "vitest";
import { InsightPeriodType } from "@prisma/client";
import {
  storedAccountFollowersForRange,
  storedAccountReachForRange,
  storedAccountViewsForRange,
} from "@/lib/stored-period-metrics";

const mockDb = vi.hoisted(() => ({
  socialInsightSnapshot: { findMany: vi.fn() },
  socialPost: { findMany: vi.fn() },
  socialConnection: { findFirst: vi.fn() },
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/meta-sync", () => ({ graph: vi.fn(), MetaSyncError: class {} }));
vi.mock("@/lib/token-encryption", () => ({ decryptToken: vi.fn() }));

beforeEach(() => {
  mockDb.socialInsightSnapshot.findMany.mockReset();
  mockDb.socialPost.findMany.mockReset();
  mockDb.socialConnection.findFirst.mockReset();
});

function metricValue(metric: string, month: number) {
  const values: Record<string, number[]> = {
    reach: [100, 200, 300],
    views: [1000, 2000, 3000],
    followers_gained: [10, 20, 30],
    followers_lost: [2, 4, 6],
  };
  return values[metric]?.[month] ?? null;
}

describe("stored authoritative period metrics", () => {
  it("uses one stored TOTAL_VALUE snapshot for a 31-day month with the validated accuracy labels", async () => {
    mockDb.socialInsightSnapshot.findMany.mockImplementation(({ where }: { where: { metric: string; periodType: InsightPeriodType } }) => {
      expect(where.periodType).toBe(InsightPeriodType.TOTAL_VALUE);
      if (where.metric === "reach") return [{ value: 312688 }];
      if (where.metric === "views") return [{ value: 818485 }];
      if (where.metric === "followers_gained") return [{ value: 512 }];
      if (where.metric === "followers_lost") return [{ value: 374 }];
      return [];
    });

    const start = new Date("2026-07-01T00:00:00.000Z");
    const end = new Date("2026-07-31T23:59:59.999Z");
    const [reach, views, followers] = await Promise.all([
      storedAccountReachForRange("client-1", start, end),
      storedAccountViewsForRange("client-1", start, end),
      storedAccountFollowersForRange("client-1", start, end),
    ]);

    expect(reach).toMatchObject({ value: 312688, accuracy: "ESTIMATED", method: "OVERLAPPING_WINDOWS_ESTIMATE" });
    expect(reach.tooltip).toContain("قيمة تقديرية محفوظة");
    expect(views).toMatchObject({ value: 818485, accuracy: "DERIVED", method: "OVERLAPPING_WINDOWS_COMPOSITION" });
    expect(followers).toMatchObject({ gained: 512, lost: 374, net: 138, accuracy: "DERIVED", method: "OVERLAPPING_WINDOWS_COMPOSITION" });
  });

  it("sums stored calendar-month totals for quarterly views and follower movement but never sums Reach", async () => {
    mockDb.socialInsightSnapshot.findMany.mockImplementation(({ where }: { where: { metric: string; periodStart: { gte: Date } } }) => {
      const month = where.periodStart.gte.getUTCMonth();
      const value = metricValue(where.metric, month);
      return value === null ? [] : [{ value }];
    });

    const start = new Date("2026-01-01T00:00:00.000Z");
    const end = new Date("2026-03-31T23:59:59.999Z");
    const [reach, views, followers] = await Promise.all([
      storedAccountReachForRange("client-1", start, end),
      storedAccountViewsForRange("client-1", start, end),
      storedAccountFollowersForRange("client-1", start, end),
    ]);

    expect(reach.value).toBeNull();
    expect(reach.method).toBe("UNAVAILABLE");
    expect(views).toMatchObject({ value: 6000, method: "AGGREGATE_OF_PERIOD_CHUNKS", accuracy: "DERIVED" });
    expect(followers).toMatchObject({ gained: 60, lost: 12, net: 48, method: "AGGREGATE_OF_PERIOD_CHUNKS", accuracy: "DERIVED" });
  });

  it("returns unavailable for a long additive report when even one monthly snapshot is missing", async () => {
    mockDb.socialInsightSnapshot.findMany.mockImplementation(({ where }: { where: { metric: string; periodStart: { gte: Date } } }) => {
      const month = where.periodStart.gte.getUTCMonth();
      if (month === 1 && where.metric === "views") return [];
      const value = metricValue(where.metric, month);
      return value === null ? [] : [{ value }];
    });

    const views = await storedAccountViewsForRange(
      "client-1",
      new Date("2026-01-01T00:00:00.000Z"),
      new Date("2026-03-31T23:59:59.999Z"),
    );
    expect(views.value).toBeNull();
    expect(views.method).toBe("UNAVAILABLE");
  });
});
