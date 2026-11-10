import { beforeEach, describe, expect, it, vi } from "vitest";
import { listClientAds, periodPaidMetricsFromDatabase, syncMissingClientAdMonth } from "@/lib/ads-insights";

const mocks = vi.hoisted(() => ({
  graph: vi.fn(),
  periods: vi.fn(),
  db: {
    $transaction: vi.fn(),
    clientAdInsightSnapshot: { findMany: vi.fn(), findUnique: vi.fn(), upsert: vi.fn() },
    client: { findUnique: vi.fn(), update: vi.fn() },
    metaProfile: { findFirst: vi.fn() },
    socialConnection: { findMany: vi.fn() },
    socialPost: { findMany: vi.fn() },
  },
}));
vi.mock("@/lib/db", () => ({ db: mocks.db }));
vi.mock("@/lib/meta-sync", () => ({ graph: mocks.graph }));
vi.mock("@/lib/token-encryption", () => ({ decryptToken: () => "test-token" }));
vi.mock("@/lib/meta-sync-insights", () => ({ completedMonthsWithinLookback: mocks.periods }));
vi.mock("@/lib/env", () => ({ getHistoricalBackfillConfig: () => ({ accountInsightMaxLookbackDays: 450 }), getSnapshotFinalizationConfig: () => ({ monthEndGraceDays: 10 }) }));

beforeEach(() => {
  vi.resetAllMocks();
  mocks.db.client.findUnique.mockResolvedValue({ metaAdAccountId: "act_shared", metaAdAccountCurrency: "SAR" });
  mocks.db.metaProfile.findFirst.mockResolvedValue({ encryptedSystemToken: "encrypted" });
  mocks.db.socialConnection.findMany.mockResolvedValue([{ id: "connection", platform: "INSTAGRAM", externalAccountId: "haifa" }]);
  mocks.db.socialPost.findMany.mockResolvedValue([]);
  mocks.db.clientAdInsightSnapshot.findMany.mockResolvedValue([]);
  mocks.db.clientAdInsightSnapshot.findUnique.mockResolvedValue(null);
  mocks.db.$transaction.mockImplementation(async (run: (tx: typeof mocks.db) => Promise<void>) => run(mocks.db));
  mocks.periods.mockReturnValue([{ start: new Date("2026-10-01"), end: new Date("2026-10-31T23:59:59.999Z") }]);
});

const since = new Date("2026-10-01");
const until = new Date("2026-10-31");

function setupCreatives(creatives: Record<string, unknown>) {
  mocks.graph.mockImplementation(async (path: string, _token: string, params: Record<string, string>) => {
    if (params.fields === "currency") return { currency: "SAR" };
    if (path.endsWith("/insights")) return { data: Object.keys(creatives).map((ad_id) => ({ ad_id, spend: "10", impressions: "100" })) };
    if (params.fields.startsWith("creative")) return Object.fromEntries(Object.entries(creatives).map(([id, creative]) => [id, { creative }]));
    return {};
  });
}

describe("paid snapshot provenance", () => {
  it("rejects the old account-level rows instead of rendering them", async () => {
    mocks.db.clientAdInsightSnapshot.findMany.mockResolvedValue([{ metric: "ad_spend", value: 4820 }]);
    expect(await periodPaidMetricsFromDatabase("client", since, until)).toMatchObject({ status: "PENDING", values: {} });
  });

  it("atomically stores scoped metrics and invalidates them after account reassignment", async () => {
    setupCreatives({ mine: { instagram_user_id: "haifa" }, other: { instagram_user_id: "other" } });
    await syncMissingClientAdMonth("client", new Date("2026-11-10"));
    expect(mocks.db.$transaction).toHaveBeenCalledOnce();
    const rows = mocks.db.clientAdInsightSnapshot.upsert.mock.calls.map(([args]) => args.create);
    expect(rows.find((row) => row.metric === "ad_spend")?.value).toBe(10);
    mocks.db.clientAdInsightSnapshot.findMany.mockResolvedValue(rows);
    expect(await periodPaidMetricsFromDatabase("client", since, until)).toMatchObject({ status: "READY", values: { ad_spend: 10 } });
    mocks.db.client.findUnique.mockResolvedValue({ metaAdAccountId: "act_changed", metaAdAccountCurrency: "SAR" });
    expect(await periodPaidMetricsFromDatabase("client", since, until)).toMatchObject({ status: "PENDING", values: {} });
  });

  it("does not finalize missing ownership as a zero-spend month", async () => {
    setupCreatives({ mine: { effective_instagram_media_id: "not-in-library" } });
    await expect(syncMissingClientAdMonth("client", new Date("2026-11-10"))).rejects.toThrow("META_AD_OWNER_UNRESOLVED");
    expect(mocks.db.$transaction).not.toHaveBeenCalled();
  });
});

describe("shared ad account isolation", () => {
  it("matches old boosts by effective Instagram identity without a locally synced post", async () => {
    setupCreatives({ mine: { effective_instagram_media_id: "old-media", instagram_user_id: "haifa" }, other: { instagram_user_id: "other-client" } });
    const result = await listClientAds("client", since, until);
    expect(result?.ads.map((ad) => ad.metaAdId)).toEqual(["mine"]);
  });

  it("keeps another client's ads out", async () => {
    setupCreatives({ other: { instagram_user_id: "other-client" } });
    expect((await listClientAds("client", since, until))?.ads).toEqual([]);
  });

  it("does not silently turn a per-object Meta failure into an empty ad list", async () => {
    mocks.graph.mockImplementation(async (path: string) => path.endsWith("/insights")
      ? { data: [{ ad_id: "mine", spend: "10" }] }
      : { mine: { error: { code: 200, message: "Permission denied" } } });
    await expect(listClientAds("client", since, until)).rejects.toThrow();
  });
});
