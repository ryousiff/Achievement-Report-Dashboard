import { describe, it, expect } from "vitest";
import { completedPeriod, splitRangeByMonth } from "./report-period";

describe("completedPeriod", () => {
  it("returns the previous completed calendar month", () => {
    const today = new Date(Date.UTC(2026, 7, 12)); // 2026-08-12
    const period = completedPeriod("monthly", today);
    expect(period.periodStart).toBe("2026-07-01");
    expect(period.periodEnd).toBe("2026-07-31");
  });

  it("returns the previous completed month when today is mid-month", () => {
    const today = new Date(Date.UTC(2026, 6, 18)); // 2026-07-18
    const period = completedPeriod("monthly", today);
    expect(period.periodStart).toBe("2026-06-01");
    expect(period.periodEnd).toBe("2026-06-30");
  });

  it("handles December → January year boundary", () => {
    const today = new Date(Date.UTC(2027, 0, 10)); // 2027-01-10
    const period = completedPeriod("monthly", today);
    expect(period.periodStart).toBe("2026-12-01");
    expect(period.periodEnd).toBe("2026-12-31");
  });

  it("handles 28-day February", () => {
    const today = new Date(Date.UTC(2026, 2, 1)); // 2026-03-01
    const period = completedPeriod("monthly", today);
    expect(period.periodStart).toBe("2026-02-01");
    expect(period.periodEnd).toBe("2026-02-28");
  });

  it("handles 29-day leap-year February", () => {
    const today = new Date(Date.UTC(2024, 2, 1)); // 2024-03-01 (leap year)
    const period = completedPeriod("monthly", today);
    expect(period.periodStart).toBe("2024-02-01");
    expect(period.periodEnd).toBe("2024-02-29");
  });

  it("handles quarterly previous completed quarter", () => {
    const today = new Date(Date.UTC(2026, 7, 12)); // Q3, previous completed = Q2
    const period = completedPeriod("quarterly", today);
    expect(period.periodStart).toBe("2026-04-01");
    expect(period.periodEnd).toBe("2026-06-30");
  });

  it("handles half-yearly previous completed half", () => {
    const today = new Date(Date.UTC(2026, 7, 12)); // H2, previous completed = H1
    const period = completedPeriod("halfYearly", today);
    expect(period.periodStart).toBe("2026-01-01");
    expect(period.periodEnd).toBe("2026-06-30");
  });

  it("handles yearly previous completed year", () => {
    const today = new Date(Date.UTC(2026, 7, 12));
    const period = completedPeriod("yearly", today);
    expect(period.periodStart).toBe("2025-01-01");
    expect(period.periodEnd).toBe("2025-12-31");
  });
});

describe("splitRangeByMonth", () => {
  it("splits a long range into calendar-month chunks", () => {
    const start = new Date(Date.UTC(2026, 0, 15));
    const end = new Date(Date.UTC(2026, 2, 20, 23, 59, 59, 999));
    const chunks = splitRangeByMonth(start, end);
    expect(chunks).toHaveLength(3);
    expect(chunks[0].start.toISOString().slice(0, 10)).toBe("2026-01-15");
    expect(chunks[0].end.toISOString().slice(0, 10)).toBe("2026-01-31");
    expect(chunks[1].start.toISOString().slice(0, 10)).toBe("2026-02-01");
    expect(chunks[1].end.toISOString().slice(0, 10)).toBe("2026-02-28");
    expect(chunks[2].start.toISOString().slice(0, 10)).toBe("2026-03-01");
    expect(chunks[2].end.toISOString().slice(0, 10)).toBe("2026-03-20");
  });

  it("keeps a single-month range as one chunk", () => {
    const start = new Date(Date.UTC(2026, 6, 1));
    const end = new Date(Date.UTC(2026, 6, 31, 23, 59, 59, 999));
    const chunks = splitRangeByMonth(start, end);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].start.toISOString().slice(0, 10)).toBe("2026-07-01");
    expect(chunks[0].end.toISOString().slice(0, 10)).toBe("2026-07-31");
  });
});
