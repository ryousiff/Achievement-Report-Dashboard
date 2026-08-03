import { describe, expect, it } from "vitest";
import { calculateBackfillStart } from "@/lib/backfill-window";

const toDate = (value: string) => new Date(value);
const datePart = (date: Date) => date.toISOString().split("T")[0];

describe("calculateBackfillStart", () => {
  it("returns January 1 of the previous year when 15 months ago is after that date", () => {
    const result = calculateBackfillStart(toDate("2026-08-03T10:00:00.000Z"));
    expect(datePart(result)).toBe("2025-01-01");
  });

  it("returns the months-ago date when it falls before January 1 of the previous year", () => {
    const result = calculateBackfillStart(toDate("2027-02-15T10:00:00.000Z"));
    expect(datePart(result)).toBe("2025-11-15");
  });

  it("respects the configurable months parameter", () => {
    const result = calculateBackfillStart(toDate("2026-08-03T10:00:00.000Z"), 3);
    expect(datePart(result)).toBe("2025-01-01");
  });

  it("returns a UTC date at midnight", () => {
    const result = calculateBackfillStart(toDate("2026-08-03T10:00:00.000Z"));
    expect(result.getUTCHours()).toBe(0);
    expect(result.getUTCMinutes()).toBe(0);
    expect(result.getUTCSeconds()).toBe(0);
  });
});
