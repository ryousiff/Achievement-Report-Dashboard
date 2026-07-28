import { describe, expect, it } from "vitest";
import { completeDailySeries } from "@/lib/report-data";

describe("completeDailySeries", () => {
  it("includes both report-period boundaries and fills missing dates with zero", () => {
    expect(completeDailySeries(new Date("2026-01-30T00:00:00.000Z"), new Date("2026-02-01T00:00:00.000Z"), [["2026-01-31", 4]])).toEqual([["2026-01-30", 0], ["2026-01-31", 4], ["2026-02-01", 0]]);
  });
});
