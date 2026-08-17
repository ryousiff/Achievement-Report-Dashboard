import { describe, expect, it } from "vitest";
import { buildDailyInsightChunks, completedMonthsWithinLookback } from "@/lib/meta-sync-insights";

const toISODate = (date: Date) => date.toISOString().slice(0, 10);

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
