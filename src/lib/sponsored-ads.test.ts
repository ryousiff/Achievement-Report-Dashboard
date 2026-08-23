import { describe, expect, it } from "vitest";
import {
  computeSponsoredAdStatus,
  parseSponsoredAdCreateInput,
  parseSponsoredAdUpdateInput,
} from "@/lib/sponsored-ads";

describe("computeSponsoredAdStatus", () => {
  const now = new Date("2026-06-15T12:00:00.000Z");

  it("returns UPCOMING when the start date is in the future", () => {
    expect(computeSponsoredAdStatus(new Date("2026-06-20"), new Date("2026-06-25"), now)).toBe("UPCOMING");
  });

  it("returns FINISHED when the end date is in the past", () => {
    expect(computeSponsoredAdStatus(new Date("2026-06-01"), new Date("2026-06-10"), now)).toBe("FINISHED");
  });

  it("returns ACTIVE when now is within the range, including on the boundary dates", () => {
    expect(computeSponsoredAdStatus(new Date("2026-06-10"), new Date("2026-06-20"), now)).toBe("ACTIVE");
    expect(computeSponsoredAdStatus(now, new Date("2026-06-20"), now)).toBe("ACTIVE");
    expect(computeSponsoredAdStatus(new Date("2026-06-10"), now, now)).toBe("ACTIVE");
  });
});

describe("parseSponsoredAdCreateInput", () => {
  const validBody = {
    socialPostId: "post-1",
    actualSpend: 150.5,
    startDate: "2026-06-01",
    endDate: "2026-06-10",
    budgetYear: 2026,
    budgetMonth: 6,
  };

  it("accepts a minimal valid payload tied to a social post and defaults currency to BHD", () => {
    const result = parseSponsoredAdCreateInput(validBody);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.currency).toBe("BHD");
    expect(result.data.actualSpend).toBe(150.5);
    expect(result.data.title).toBeNull();
    expect(result.data.startDate.toISOString()).toContain("2026-06-01");
    expect(result.data.budgetYear).toBe(2026);
    expect(result.data.budgetMonth).toBe(6);
  });

  it("accepts a manual ad with a title and postUrl but no socialPostId", () => {
    const result = parseSponsoredAdCreateInput({
      title: "منشور ترويجي",
      postUrl: "https://instagram.com/p/abc",
      actualSpend: 50,
      startDate: "2026-06-01",
      endDate: "2026-06-05",
      budgetYear: 2026,
      budgetMonth: 6,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a missing or invalid budget year/month, and does not guess it from startDate", () => {
    expect(parseSponsoredAdCreateInput({ ...validBody, budgetYear: undefined }).ok).toBe(false);
    expect(parseSponsoredAdCreateInput({ ...validBody, budgetMonth: undefined }).ok).toBe(false);
    expect(parseSponsoredAdCreateInput({ ...validBody, budgetMonth: 13 }).ok).toBe(false);
    expect(parseSponsoredAdCreateInput({ ...validBody, budgetYear: 1999 }).ok).toBe(false);
  });

  it("allows assigning the budget month independently of the ad's own start/end dates (e.g. an ad spanning two months)", () => {
    const result = parseSponsoredAdCreateInput({ ...validBody, startDate: "2026-06-25", endDate: "2026-07-05", budgetYear: 2026, budgetMonth: 7 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.budgetMonth).toBe(7);
      expect(result.data.startDate.toISOString()).toContain("2026-06-25");
    }
  });

  it("rejects a payload with no socialPostId, title, or postUrl", () => {
    const result = parseSponsoredAdCreateInput({
      actualSpend: 50,
      startDate: "2026-06-01",
      endDate: "2026-06-05",
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a negative actual spend", () => {
    const result = parseSponsoredAdCreateInput({ ...validBody, actualSpend: -10 });
    expect(result.ok).toBe(false);
  });

  it("rejects a missing or invalid actual spend", () => {
    expect(parseSponsoredAdCreateInput({ ...validBody, actualSpend: undefined }).ok).toBe(false);
    expect(parseSponsoredAdCreateInput({ ...validBody, actualSpend: "not-a-number" }).ok).toBe(false);
  });

  it("rejects an invalid start or end date", () => {
    expect(parseSponsoredAdCreateInput({ ...validBody, startDate: "not-a-date" }).ok).toBe(false);
    expect(parseSponsoredAdCreateInput({ ...validBody, endDate: "not-a-date" }).ok).toBe(false);
  });

  it("rejects an end date before the start date", () => {
    const result = parseSponsoredAdCreateInput({ ...validBody, startDate: "2026-06-10", endDate: "2026-06-01" });
    expect(result.ok).toBe(false);
  });

  it("uppercases a provided currency", () => {
    const result = parseSponsoredAdCreateInput({ ...validBody, currency: "usd" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.currency).toBe("USD");
  });

  it("parses optional Meta enrichment fields when provided", () => {
    const result = parseSponsoredAdCreateInput({
      ...validBody,
      metaAdAccountId: "act_1",
      metaAdId: "ad_1",
      paidReach: 1000,
      impressions: 5000,
      clicks: 200,
      ctr: 4.5,
      cpc: 0.12,
      cpm: 3.4,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.metaAdAccountId).toBe("act_1");
    expect(result.data.impressions).toBe(5000);
    expect(result.data.ctr).toBe(4.5);
  });

  it("rejects an invalid optional numeric enrichment field", () => {
    const result = parseSponsoredAdCreateInput({ ...validBody, impressions: "lots" });
    expect(result.ok).toBe(false);
  });
});

describe("parseSponsoredAdUpdateInput", () => {
  it("returns only the fields present in the body", () => {
    const result = parseSponsoredAdUpdateInput({ actualSpend: 75 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({ actualSpend: 75 });
  });

  it("allows clearing an optional field by passing null", () => {
    const result = parseSponsoredAdUpdateInput({ title: null });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.title).toBeNull();
  });

  it("rejects an invalid date when only one of start/end is updated inconsistently", () => {
    const result = parseSponsoredAdUpdateInput({ startDate: "2026-06-10", endDate: "2026-06-01" });
    expect(result.ok).toBe(false);
  });

  it("rejects a negative actual spend on update", () => {
    const result = parseSponsoredAdUpdateInput({ actualSpend: -5 });
    expect(result.ok).toBe(false);
  });

  it("returns an empty data object for an empty update body", () => {
    const result = parseSponsoredAdUpdateInput({});
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toEqual({});
  });

  it("allows moving an ad to a different budget month/year", () => {
    const result = parseSponsoredAdUpdateInput({ budgetYear: 2026, budgetMonth: 8 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toEqual({ budgetYear: 2026, budgetMonth: 8 });
  });

  it("rejects an invalid budget month/year on update", () => {
    expect(parseSponsoredAdUpdateInput({ budgetMonth: 0 }).ok).toBe(false);
    expect(parseSponsoredAdUpdateInput({ budgetYear: 1999 }).ok).toBe(false);
  });
});
