import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { deduplicateByExternalPostId, reachSeries } from "@/lib/dashboard";

const mockDb = vi.hoisted(() => ({
  socialInsightSnapshot: { findMany: vi.fn() },
  socialPost: { findMany: vi.fn() },
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-02T12:00:00.000Z"));
  mockDb.socialInsightSnapshot.findMany.mockReset();
  mockDb.socialPost.findMany.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("deduplicateByExternalPostId", () => {
  it("removes duplicate posts with the same externalPostId", () => {
    const items = [
      { id: "a", externalPostId: "ig-1", value: 10 },
      { id: "b", externalPostId: "ig-1", value: 20 },
      { id: "c", externalPostId: "ig-2", value: 30 },
    ];
    const result = deduplicateByExternalPostId(items);
    expect(result).toHaveLength(2);
    expect(result.map((item) => item.id)).toEqual(["a", "c"]);
  });

  it("keeps items without externalPostId", () => {
    const items = [{ id: "a", externalPostId: undefined }, { id: "b", externalPostId: undefined }];
    const result = deduplicateByExternalPostId(items);
    expect(result).toHaveLength(2);
  });
});

describe("reachSeries", () => {
  it("prefers account-level snapshots and does not sum post reach", async () => {
    mockDb.socialInsightSnapshot.findMany.mockResolvedValue([
      { periodEnd: new Date("2026-08-02T00:00:00.000Z"), value: 1000 },
    ]);
    const result = await reachSeries(1);
    expect(result.values).toEqual([1000]);
    expect(result.labels).toEqual(["2026-08-02"]);
    expect(mockDb.socialPost.findMany).not.toHaveBeenCalled();
  });

  it("deduplicates post-level reach when falling back", async () => {
    mockDb.socialInsightSnapshot.findMany.mockResolvedValue([]);
    mockDb.socialPost.findMany.mockResolvedValue([
      { publishedAt: new Date("2026-08-01T00:00:00.000Z"), externalPostId: "ig-1", metrics: { reach: 100 }, metricAvailability: { reach: "returned" } },
      { publishedAt: new Date("2026-08-01T00:00:00.000Z"), externalPostId: "ig-1", metrics: { reach: 100 }, metricAvailability: { reach: "returned" } },
      { publishedAt: new Date("2026-08-02T00:00:00.000Z"), externalPostId: "ig-2", metrics: { reach: 50 }, metricAvailability: { reach: "returned" } },
    ]);
    const result = await reachSeries(2);
    expect(result.values).toEqual([100, 50]);
    expect(result.labels).toEqual(["2026-08-01", "2026-08-02"]);
  });
});
