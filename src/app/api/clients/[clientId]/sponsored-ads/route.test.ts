import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "./route";

const mocks = vi.hoisted(() => ({
  allowed: vi.fn(), list: vi.fn(),
  db: { sponsoredAd: { findMany: vi.fn() }, clientAdBudget: { findUnique: vi.fn() } },
}));
vi.mock("@/lib/db", () => ({ db: mocks.db }));
vi.mock("@/lib/access", () => ({ requireFeature: mocks.allowed }));
vi.mock("@/lib/ads-insights", () => ({ listClientAds: mocks.list, paidFetchErrorCode: () => "META_AD_FETCH_FAILED" }));

const manual = {
  id: "manual", clientId: "client", metaAdId: "linked", actualSpend: 10, currency: "BHD", socialPost: null,
  startDate: new Date("2026-10-01"), endDate: new Date("2026-10-31"), createdAt: new Date(), updatedAt: new Date(),
};
const params = { params: Promise.resolve({ clientId: "client" }) };
function request(month = 10) { return new NextRequest(`http://localhost/api/clients/client/sponsored-ads?year=2026&month=${month}`); }

beforeEach(() => {
  vi.resetAllMocks();
  mocks.allowed.mockResolvedValue({ id: "admin" });
  mocks.db.sponsoredAd.findMany.mockResolvedValue([manual]);
  mocks.db.clientAdBudget.findUnique.mockResolvedValue({ plannedBudget: 100, currency: "BHD" });
});

describe("automatic and manual sponsored ads API", () => {
  it("keeps manual entries, hides their Meta twin and returns the combined BHD summary", async () => {
    mocks.list.mockResolvedValue({ currency: "SAR", ads: [{ metaAdId: "linked", spend: 999 }, { metaAdId: "new", spend: 375 }] });
    const response = await GET(request(), params);
    const body = await response.json();
    expect(body.autoStatus).toBe("READY");
    expect(body.ads).toHaveLength(1);
    expect(body.autoAds).toEqual([{ metaAdId: "new", spend: 375 }]);
    expect(body.summary.totalActualSpend).toBeCloseTo(47.6);
    expect(body.summary.adsCount).toBe(2);
    expect(mocks.list.mock.calls[0][1].toISOString()).toBe("2026-10-01T00:00:00.000Z");
  });

  it("reports Meta errors without losing manual entries or claiming zero spend", async () => {
    mocks.list.mockRejectedValue(new Error("test failure"));
    const body = await (await GET(request(), params)).json();
    expect(body.autoStatus).toBe("ERROR");
    expect(body.ads).toHaveLength(1);
    expect(body.summary).toBeNull();
  });

  it("distinguishes a verified empty month from a failed fetch", async () => {
    mocks.list.mockResolvedValue({ currency: "SAR", ads: [] });
    const body = await (await GET(request(), params)).json();
    expect(body.autoStatus).toBe("READY");
    expect(body.summary.totalActualSpend).toBe(10);
  });

  it("rejects invalid months and unauthorized requests before accessing Meta", async () => {
    expect((await GET(request(13), params)).status).toBe(400);
    mocks.allowed.mockResolvedValue(null);
    expect((await GET(request(), params)).status).toBe(401);
    expect(mocks.list).not.toHaveBeenCalled();
  });
});
