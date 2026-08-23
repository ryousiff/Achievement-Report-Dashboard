/** Business logic for a client's monthly planned advertising budget ("الميزانية الإعلانية الشهرية"),
 * layered on top of the existing SponsoredAd tracking. `plannedBudget` is the only number an employee
 * enters for a given (client, year, month); every other summary figure (total actual spend, remaining
 * budget, percentage used, ad count) is always calculated on the fly from the SponsoredAd rows
 * assigned to that month — never stored, so it can never drift out of sync with the underlying ads. */

export const DEFAULT_AD_BUDGET_CURRENCY = "BHD";

export function isValidBudgetMonth(month: unknown): month is number {
  return typeof month === "number" && Number.isInteger(month) && month >= 1 && month <= 12;
}

export function isValidBudgetYear(year: unknown): year is number {
  return typeof year === "number" && Number.isInteger(year) && year >= 2000 && year <= 2100;
}

export type AdBudgetSummary = {
  year: number;
  month: number;
  plannedBudget: number;
  currency: string;
  /** SUM(actualSpend) of every SponsoredAd assigned to this (client, year, month). */
  totalActualSpend: number;
  /** plannedBudget - totalActualSpend. Never clamped to zero — can be negative when over budget. */
  remainingBudget: number;
  /** plannedBudget > 0 ? (totalActualSpend / plannedBudget) * 100 : 0. */
  budgetUsedPercentage: number;
  adsCount: number;
  isOverBudget: boolean;
  /** How much totalActualSpend exceeds plannedBudget by; 0 when not over budget. */
  exceededBy: number;
};

/** Pure calculation: given a month's planned budget and the actualSpend of every SponsoredAd
 * assigned to it, derive every summary figure the Sponsored Ads month view needs. Called fresh on
 * every read, so it automatically reflects the latest state after creating/editing/deleting an ad,
 * moving an ad to another month, or changing the planned budget — no separate "recalculate" step. */
export function calculateAdBudgetSummary(
  year: number,
  month: number,
  plannedBudget: number,
  currency: string,
  adActualSpends: number[],
): AdBudgetSummary {
  const totalActualSpend = adActualSpends.reduce((sum, spend) => sum + spend, 0);
  const remainingBudget = plannedBudget - totalActualSpend;
  const budgetUsedPercentage = plannedBudget > 0 ? (totalActualSpend / plannedBudget) * 100 : 0;
  const isOverBudget = totalActualSpend > plannedBudget;
  return {
    year,
    month,
    plannedBudget,
    currency,
    totalActualSpend,
    remainingBudget,
    budgetUsedPercentage,
    adsCount: adActualSpends.length,
    isOverBudget,
    exceededBy: isOverBudget ? totalActualSpend - plannedBudget : 0,
  };
}

export type ClientAdBudgetFields = { year: number; month: number; plannedBudget: number; currency: string };
export type AdBudgetParseResult<T> = { ok: true; data: T } | { ok: false; error: string };

function readOptionalString(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function readNumber(value: unknown): number | "invalid" | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : "invalid";
}

/** Validates the payload for creating/upserting a client's planned budget for one calendar month. */
export function parseClientAdBudgetInput(body: unknown): AdBudgetParseResult<ClientAdBudgetFields> {
  if (!body || typeof body !== "object") return { ok: false, error: "Invalid request body." };
  const raw = body as Record<string, unknown>;

  const year = readNumber(raw.year);
  if (year === undefined || year === "invalid" || !isValidBudgetYear(year)) return { ok: false, error: "Enter a valid budget year." };

  const month = readNumber(raw.month);
  if (month === undefined || month === "invalid" || !isValidBudgetMonth(month)) return { ok: false, error: "Enter a valid budget month (1-12)." };

  const plannedBudget = readNumber(raw.plannedBudget);
  if (plannedBudget === undefined || plannedBudget === "invalid" || plannedBudget < 0) return { ok: false, error: "Enter a valid planned budget amount." };

  const currencyRaw = readOptionalString(raw.currency);
  const currency = currencyRaw ? currencyRaw.toUpperCase() : DEFAULT_AD_BUDGET_CURRENCY;

  return { ok: true, data: { year, month, plannedBudget, currency } };
}
