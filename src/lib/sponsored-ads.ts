/** Business logic for the "الإعلانات الممولة" (Sponsored Ads) client section, which replaces the
 * previous Google Sheet workflow for tracking manually-boosted Instagram posts. This is
 * intentionally independent of the Meta Ads performance dashboard and the report system: creating
 * a row never requires Meta Ads API access. `actualSpend` is real money already spent, not a
 * planned budget. */

export type SponsoredAdStatus = "UPCOMING" | "ACTIVE" | "FINISHED";

export const DEFAULT_SPONSORED_AD_CURRENCY = "BHD";

/** Upcoming/active/finished is always derived from startDate/endDate rather than stored, so it
 * never goes stale. */
export function computeSponsoredAdStatus(
  startDate: Date,
  endDate: Date,
  now: Date = new Date(),
): SponsoredAdStatus {
  if (now.valueOf() < startDate.valueOf()) return "UPCOMING";
  if (now.valueOf() > endDate.valueOf()) return "FINISHED";
  return "ACTIVE";
}

export type SponsoredAdFields = {
  socialPostId: string | null;
  title: string | null;
  postUrl: string | null;
  actualSpend: number;
  currency: string;
  startDate: Date;
  endDate: Date;
  metaAdAccountId: string | null;
  metaAdId: string | null;
  paidReach: number | null;
  impressions: number | null;
  clicks: number | null;
  ctr: number | null;
  cpc: number | null;
  cpm: number | null;
};

export type SponsoredAdParseResult<T> = { ok: true; data: T } | { ok: false; error: string };

function readOptionalString(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function readOptionalNumber(value: unknown): number | null | undefined | "invalid" {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : "invalid";
}

function readDate(value: unknown): Date | "invalid" | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" && typeof value !== "number") return "invalid";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "invalid" : date;
}

/** Validates the payload for creating a new sponsored ad. `actualSpend`, `startDate`, and
 * `endDate` are required; everything else (including the Meta enrichment fields, filled in later
 * once Meta Ads API access is available) is optional. */
export function parseSponsoredAdCreateInput(body: unknown): SponsoredAdParseResult<SponsoredAdFields> {
  if (!body || typeof body !== "object") return { ok: false, error: "Invalid request body." };
  const raw = body as Record<string, unknown>;

  const socialPostId = readOptionalString(raw.socialPostId) ?? null;
  const title = readOptionalString(raw.title) ?? null;
  const postUrl = readOptionalString(raw.postUrl) ?? null;
  if (!socialPostId && !title && !postUrl) {
    return { ok: false, error: "Select a post or provide a title/link for the ad." };
  }

  const actualSpend = readOptionalNumber(raw.actualSpend);
  if (actualSpend === undefined || actualSpend === null || actualSpend === "invalid" || actualSpend < 0) {
    return { ok: false, error: "Enter a valid actual spend amount." };
  }

  const startDate = readDate(raw.startDate);
  if (!startDate || startDate === "invalid") return { ok: false, error: "Enter a valid start date." };
  const endDate = readDate(raw.endDate);
  if (!endDate || endDate === "invalid") return { ok: false, error: "Enter a valid end date." };
  if (endDate.valueOf() < startDate.valueOf()) return { ok: false, error: "End date must be on or after the start date." };

  const currencyRaw = readOptionalString(raw.currency);
  const currency = currencyRaw ? currencyRaw.toUpperCase() : DEFAULT_SPONSORED_AD_CURRENCY;

  const numericFields: Array<[keyof SponsoredAdFields, unknown]> = [
    ["paidReach", raw.paidReach],
    ["impressions", raw.impressions],
    ["clicks", raw.clicks],
    ["ctr", raw.ctr],
    ["cpc", raw.cpc],
    ["cpm", raw.cpm],
  ];
  const numericValues: Record<string, number | null> = {};
  for (const [key, value] of numericFields) {
    const parsed = readOptionalNumber(value);
    if (parsed === "invalid") return { ok: false, error: `Enter a valid value for ${key}.` };
    numericValues[key] = parsed ?? null;
  }

  return {
    ok: true,
    data: {
      socialPostId,
      title,
      postUrl,
      actualSpend,
      currency,
      startDate,
      endDate,
      metaAdAccountId: readOptionalString(raw.metaAdAccountId) ?? null,
      metaAdId: readOptionalString(raw.metaAdId) ?? null,
      paidReach: numericValues.paidReach as number | null,
      impressions: numericValues.impressions as number | null,
      clicks: numericValues.clicks as number | null,
      ctr: numericValues.ctr as number | null,
      cpc: numericValues.cpc as number | null,
      cpm: numericValues.cpm as number | null,
    },
  };
}

/** Same validation rules as create, but every field is optional and only present keys are
 * returned, so callers can `db.sponsoredAd.update({ data })` directly. */
export function parseSponsoredAdUpdateInput(body: unknown): SponsoredAdParseResult<Partial<SponsoredAdFields>> {
  if (!body || typeof body !== "object") return { ok: false, error: "Invalid request body." };
  const raw = body as Record<string, unknown>;
  const data: Partial<SponsoredAdFields> = {};

  if ("socialPostId" in raw) data.socialPostId = readOptionalString(raw.socialPostId) ?? null;
  if ("title" in raw) data.title = readOptionalString(raw.title) ?? null;
  if ("postUrl" in raw) data.postUrl = readOptionalString(raw.postUrl) ?? null;

  if ("actualSpend" in raw) {
    const actualSpend = readOptionalNumber(raw.actualSpend);
    if (actualSpend === undefined || actualSpend === null || actualSpend === "invalid" || actualSpend < 0) {
      return { ok: false, error: "Enter a valid actual spend amount." };
    }
    data.actualSpend = actualSpend;
  }

  if ("currency" in raw) {
    const currencyRaw = readOptionalString(raw.currency);
    data.currency = currencyRaw ? currencyRaw.toUpperCase() : DEFAULT_SPONSORED_AD_CURRENCY;
  }

  let startDate: Date | undefined;
  let endDate: Date | undefined;
  if ("startDate" in raw) {
    const parsed = readDate(raw.startDate);
    if (!parsed || parsed === "invalid") return { ok: false, error: "Enter a valid start date." };
    startDate = parsed;
    data.startDate = parsed;
  }
  if ("endDate" in raw) {
    const parsed = readDate(raw.endDate);
    if (!parsed || parsed === "invalid") return { ok: false, error: "Enter a valid end date." };
    endDate = parsed;
    data.endDate = parsed;
  }
  if (startDate && endDate && endDate.valueOf() < startDate.valueOf()) {
    return { ok: false, error: "End date must be on or after the start date." };
  }

  if ("metaAdAccountId" in raw) data.metaAdAccountId = readOptionalString(raw.metaAdAccountId) ?? null;
  if ("metaAdId" in raw) data.metaAdId = readOptionalString(raw.metaAdId) ?? null;

  const numericFields: Array<keyof SponsoredAdFields> = ["paidReach", "impressions", "clicks", "ctr", "cpc", "cpm"];
  for (const key of numericFields) {
    if (!(key in raw)) continue;
    const parsed = readOptionalNumber(raw[key]);
    if (parsed === "invalid") return { ok: false, error: `Enter a valid value for ${key}.` };
    (data as Record<string, number | null>)[key] = parsed ?? null;
  }

  return { ok: true, data };
}
