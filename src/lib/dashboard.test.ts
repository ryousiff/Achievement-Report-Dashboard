import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { completedReportsLastMonthCount, deduplicateByExternalPostId, mostRecentInstagramSyncAt, newClientsThisMonthCount, reachSeries } from "@/lib/dashboard";

const mockDb = vi.hoisted(() => ({
  socialInsightSnapshot: { findMany: vi.fn() },
  socialPost: { findMany: vi.fn() },
  client: { count: vi.fn() },
  report: { count: vi.fn() },
  socialConnection: { findFirst: vi.fn() },
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-02T12:00:00.000Z"));
  mockDb.socialInsightSnapshot.findMany.mockReset();
  mockDb.socialPost.findMany.mockReset();
  mockDb.client.count.mockReset();
  mockDb.report.count.mockReset();
  mockDb.socialConnection.findFirst.mockReset();
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

describe("newClientsThisMonthCount", () => {
  it("counts clients created within the current calendar month", async () => {
    mockDb.client.count.mockResolvedValue(3);

    const result = await newClientsThisMonthCount();

    expect(result).toBe(3);
    const args = mockDb.client.count.mock.calls[0][0];
    expect(args.where.createdAt.gte.toISOString()).toBe("2026-08-01T00:00:00.000Z");
    expect(args.where.createdAt.lte.toISOString()).toBe("2026-08-31T23:59:59.999Z");
  });
});

describe("completedReportsLastMonthCount", () => {
  it("counts approved/exported reports created within the previous calendar month", async () => {
    mockDb.report.count.mockResolvedValue(6);

    const result = await completedReportsLastMonthCount();

    expect(result).toBe(6);
    const args = mockDb.report.count.mock.calls[0][0];
    expect(args.where.createdAt.gte.toISOString()).toBe("2026-07-01T00:00:00.000Z");
    expect(args.where.createdAt.lte.toISOString()).toBe("2026-07-31T23:59:59.999Z");
    expect(args.where.status.in).toEqual(["APPROVED", "EXPORTED"]);
  });

  it("rolls over correctly from January to the previous December", async () => {
    vi.setSystemTime(new Date("2026-01-15T12:00:00.000Z"));
    mockDb.report.count.mockResolvedValue(1);

    await completedReportsLastMonthCount();

    const args = mockDb.report.count.mock.calls[0][0];
    expect(args.where.createdAt.gte.toISOString()).toBe("2025-12-01T00:00:00.000Z");
    expect(args.where.createdAt.lte.toISOString()).toBe("2025-12-31T23:59:59.999Z");
  });
});

describe("mostRecentInstagramSyncAt", () => {
  it("returns the most recent successful sync timestamp across Instagram connections", async () => {
    const lastSync = new Date("2026-08-02T11:48:00.000Z");
    mockDb.socialConnection.findFirst.mockResolvedValue({ lastSuccessfulSyncAt: lastSync });

    const result = await mostRecentInstagramSyncAt();

    expect(result).toEqual(lastSync);
    const args = mockDb.socialConnection.findFirst.mock.calls[0][0];
    expect(args.where.platform).toBe("INSTAGRAM");
    expect(args.orderBy).toEqual({ lastSuccessfulSyncAt: "desc" });
  });

  it("returns null when no Instagram connection has ever synced successfully", async () => {
    mockDb.socialConnection.findFirst.mockResolvedValue(null);

    expect(await mostRecentInstagramSyncAt()).toBeNull();
  });
});
