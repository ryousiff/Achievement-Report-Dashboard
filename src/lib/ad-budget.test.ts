import { describe, expect, it } from "vitest";
import {
  calculateAdBudgetSummary,
  isValidBudgetMonth,
  isValidBudgetYear,
  parseClientAdBudgetInput,
} from "@/lib/ad-budget";

describe("isValidBudgetMonth / isValidBudgetYear", () => {
  it("accepts months 1-12 and rejects everything else", () => {
    expect(isValidBudgetMonth(1)).toBe(true);
    expect(isValidBudgetMonth(12)).toBe(true);
    expect(isValidBudgetMonth(0)).toBe(false);
    expect(isValidBudgetMonth(13)).toBe(false);
    expect(isValidBudgetMonth(1.5)).toBe(false);
    expect(isValidBudgetMonth("7")).toBe(false);
  });

  it("accepts a sane year range", () => {
    expect(isValidBudgetYear(2026)).toBe(true);
    expect(isValidBudgetYear(1999)).toBe(false);
    expect(isValidBudgetYear(2101)).toBe(false);
  });
});

describe("calculateAdBudgetSummary", () => {
  it("computes the monthly total actual spend from every ad assigned to that month", () => {
    const summary = calculateAdBudgetSummary(2026, 7, 300, "BHD", [100, 40]);
    expect(summary.totalActualSpend).toBe(140);
    expect(summary.adsCount).toBe(2);
  });

  it("computes remaining budget as plannedBudget - totalActualSpend", () => {
    const summary = calculateAdBudgetSummary(2026, 7, 300, "BHD", [100, 40]);
    expect(summary.remainingBudget).toBe(160);
  });

  it("computes budgetUsedPercentage as (totalActualSpend / plannedBudget) * 100", () => {
    const summary = calculateAdBudgetSummary(2026, 7, 300, "BHD", [140]);
    expect(summary.budgetUsedPercentage).toBeCloseTo(46.666, 2);
  });

  it("returns 0% used when the planned budget is 0, instead of dividing by zero", () => {
    const summary = calculateAdBudgetSummary(2026, 7, 0, "BHD", [50]);
    expect(summary.budgetUsedPercentage).toBe(0);
  });

  it("flags an over-budget month and reports the exact amount exceeded, without clamping remainingBudget to zero", () => {
    const summary = calculateAdBudgetSummary(2026, 7, 300, "BHD", [200, 125]);
    expect(summary.totalActualSpend).toBe(325);
    expect(summary.remainingBudget).toBe(-25);
    expect(summary.isOverBudget).toBe(true);
    expect(summary.exceededBy).toBe(25);
  });

  it("reports isOverBudget false and exceededBy 0 when spend is within budget", () => {
    const summary = calculateAdBudgetSummary(2026, 7, 300, "BHD", [100]);
    expect(summary.isOverBudget).toBe(false);
    expect(summary.exceededBy).toBe(0);
  });

  it("handles a month with no ads assigned yet", () => {
    const summary = calculateAdBudgetSummary(2026, 8, 300, "BHD", []);
    expect(summary.totalActualSpend).toBe(0);
    expect(summary.remainingBudget).toBe(300);
    expect(summary.budgetUsedPercentage).toBe(0);
    expect(summary.adsCount).toBe(0);
    expect(summary.isOverBudget).toBe(false);
  });
});

describe("parseClientAdBudgetInput", () => {
  it("accepts a valid payload and defaults currency to BHD", () => {
    const result = parseClientAdBudgetInput({ year: 2026, month: 7, plannedBudget: 300 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toEqual({ year: 2026, month: 7, plannedBudget: 300, currency: "BHD" });
  });

  it("rejects an invalid month or year", () => {
    expect(parseClientAdBudgetInput({ year: 2026, month: 13, plannedBudget: 300 }).ok).toBe(false);
    expect(parseClientAdBudgetInput({ year: 1999, month: 1, plannedBudget: 300 }).ok).toBe(false);
  });

  it("rejects a negative planned budget", () => {
    expect(parseClientAdBudgetInput({ year: 2026, month: 7, plannedBudget: -10 }).ok).toBe(false);
  });

  it("rejects a missing planned budget", () => {
    expect(parseClientAdBudgetInput({ year: 2026, month: 7 }).ok).toBe(false);
  });

  it("uppercases a provided currency", () => {
    const result = parseClientAdBudgetInput({ year: 2026, month: 7, plannedBudget: 300, currency: "usd" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.currency).toBe("USD");
  });
});
