import { beforeEach, describe, expect, it, vi } from "vitest";
import { InsightPeriodType, Platform } from "@prisma/client";
import { buildDailyInsightChunks, completedMonthsWithinLookback, runDailyAccountInsightChunk } from "@/lib/meta-sync-insights";

const mockDb = vi.hoisted(() => ({
  socialConnection: { findUnique: vi.fn(), update: vi.fn() },
  socialInsightSnapshot: { findMany: vi.fn(), upsert: vi.fn() },
}));
const mockGraph = vi.hoisted(() => vi.fn());

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/token-encryption", () => ({ decryptToken: () => "token" }));
vi.mock("@/lib/backfill-window", () => ({ calculateBackfillStart: () => new Date("2026-07-27T00:00:00.000Z") }));
vi.mock("@/lib/env", () => ({
  getHistoricalBackfillConfig: () => ({ months: 1, accountInsightMaxLookbackDays: 30, accountInsightChunkDays: 30 }),
}));
vi.mock("@/lib/meta-sync", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/meta-sync")>();
  return { ...actual, graph: mockGraph };
});

const toISODate = (date: Date) => date.toISOString().slice(0, 10);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("buildDailyInsightChunks", () => {
  it("splits a 90-day window into three 30-day chunks without gaps or overlaps", () => {
    const from = new Date("2026-01-01T00:00:00.000Z");
    const to = new Date("2026-03-31T00:00:00.000Z");
    const chunks = buildDailyInsightChunks(from, to, 30);
    expect(chunks.length).toBe(3);
    expect(toISODate(chunks[0].since)).toBe("2026-01-01");
    expect(toISODate(chunks[0].until)).toBe("2026-01-31");
    expect(toISODate(chunks[1].since)).toBe("2026-01-31");
    expect(toISODate(chunks[1].until)).toBe("2026-03-02");
    expect(toISODate(chunks[2].since)).toBe("2026-03-02");
    expect(toISODate(chunks[2].until)).toBe("2026-03-31");
  });

  it("produces a single chunk when the range is smaller than chunkDays", () => {
    const from = new Date("2026-01-01T00:00:00.000Z");
    const to = new Date("2026-01-05T00:00:00.000Z");
    const chunks = buildDailyInsightChunks(from, to, 30);
    expect(chunks.length).toBe(1);
    expect(toISODate(chunks[0].since)).toBe("2026-01-01");
    expect(toISODate(chunks[0].until)).toBe("2026-01-05");
  });

  it("uses UTC day boundaries for each chunk", () => {
    const from = new Date("2026-08-03T14:30:00.000Z");
    const to = new Date("2026-08-05T08:15:00.000Z");
    const chunks = buildDailyInsightChunks(from, to, 10);
    expect(toISODate(chunks[0].since)).toBe("2026-08-03");
    expect(toISODate(chunks[0].until)).toBe("2026-08-05");
  });

  it("returns an empty array when from is after to", () => {
    const from = new Date("2026-08-05T00:00:00.000Z");
    const to = new Date("2026-08-01T00:00:00.000Z");
    const chunks = buildDailyInsightChunks(from, to, 30);
    expect(chunks.length).toBe(0);
  });
});

describe("runDailyAccountInsightChunk", () => {
  it("does not retry or fail the job when follower_count is unsupported for the requested historical period", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-26T12:00:00.000Z"));
    mockDb.socialConnection.findUnique.mockResolvedValue({
      id: "conn-1",
      platform: Platform.INSTAGRAM,
      externalAccountId: "ig-1",
      encryptedToken: "encrypted",
      reachCoverageStart: null,
      reachWeekCoverageStart: null,
      reachDays28CoverageStart: null,
      followerCountCoverageStart: null,
    });
    mockDb.socialConnection.update.mockResolvedValue({});
    mockDb.socialInsightSnapshot.findMany.mockResolvedValue([
      { metric: "reach" },
      { metric: "views" },
      { metric: "followers_gained" },
      { metric: "followers_lost" },
    ]);
    mockGraph.mockImplementation(async (_path: string, _token: string, parameters: Record<string, string>) => {
      if (parameters.metric === "follower_count") {
        throw new Error("(#100) (follower_count) metric only supports querying data for the last 30 days excluding the current day");
      }
      return { data: [] };
    });

    await expect(runDailyAccountInsightChunk("conn-1")).resolves.toEqual({ posts: 0 });

    const followerCalls = mockGraph.mock.calls.filter(([, , parameters]) => parameters.metric === "follower_count");
    expect(followerCalls).toHaveLength(1);
    expect(followerCalls[0][2].until).toBe(String(Date.parse("2026-08-26T00:00:00.000Z") / 1000));
    expect(mockGraph.mock.calls.some(([, , parameters]) => parameters.metric === "reach")).toBe(true);
    expect(mockDb.socialConnection.update).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({ accountInsightsLastError: null }),
    }));
    vi.useRealTimers();
  });
});

describe("completedMonthsWithinLookback", () => {
  it("returns only fully retrievable completed months, newest first", () => {
    const months = completedMonthsWithinLookback(
      new Date("2026-08-17T06:00:00.000Z"),
      new Date("2026-05-19T00:00:00.000Z"),
    );

    expect(months.map((month) => [toISODate(month.start), toISODate(month.end)])).toEqual([
      ["2026-07-01", "2026-07-31"],
      ["2026-06-01", "2026-06-30"],
    ]);
  });

  it("never includes the current partial month", () => {
    const months = completedMonthsWithinLookback(
      new Date("2026-08-01T00:01:00.000Z"),
      new Date("2026-07-01T00:00:00.000Z"),
    );
    expect(months.map((month) => toISODate(month.start))).toEqual(["2026-07-01"]);
  });
});
