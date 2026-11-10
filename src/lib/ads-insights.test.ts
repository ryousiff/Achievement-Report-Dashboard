import { beforeEach, describe, expect, it, vi } from "vitest";
import { listClientAds } from "@/lib/ads-insights";

const mocks = vi.hoisted(() => ({
  graph: vi.fn(),
  db: {
    client: { findUnique: vi.fn() },
    metaProfile: { findFirst: vi.fn() },
    socialConnection: { findMany: vi.fn() },
    socialPost: { findMany: vi.fn() },
  },
}));
vi.mock("@/lib/db", () => ({ db: mocks.db }));
vi.mock("@/lib/meta-sync", () => ({ graph: mocks.graph }));
vi.mock("@/lib/token-encryption", () => ({ decryptToken: () => "test-token" }));
vi.mock("@/lib/meta-sync-insights", () => ({ completedMonthsWithinLookback: vi.fn() }));

beforeEach(() => {
  vi.resetAllMocks();
  mocks.db.client.findUnique.mockResolvedValue({ metaAdAccountId: "act_shared", metaAdAccountCurrency: "SAR" });
  mocks.db.metaProfile.findFirst.mockResolvedValue({ encryptedSystemToken: "encrypted" });
  mocks.db.socialConnection.findMany.mockResolvedValue([{ id: "connection", platform: "INSTAGRAM", externalAccountId: "haifa" }]);
  mocks.db.socialPost.findMany.mockResolvedValue([]);
});

const since = new Date("2026-10-01");
const until = new Date("2026-10-31");

function setupCreatives(creatives: Record<string, unknown>) {
  mocks.graph.mockImplementation(async (path: string, _token: string, params: Record<string, string>) => {
    if (path.endsWith("/insights")) return { data: Object.keys(creatives).map((ad_id) => ({ ad_id, spend: "10", impressions: "100" })) };
    if (params.fields.startsWith("creative")) return Object.fromEntries(Object.entries(creatives).map(([id, creative]) => [id, { creative }]));
    return {};
  });
}

describe("shared ad account isolation", () => {
  it("matches old boosts by effective Instagram identity without a locally synced post", async () => {
    setupCreatives({ mine: { effective_instagram_story_id: "old-media", instagram_user_id: "haifa" }, other: { instagram_user_id: "other-client" } });
    const result = await listClientAds("client", since, until);
    expect(result?.ads.map((ad) => ad.metaAdId)).toEqual(["mine"]);
  });

  it("keeps another client's ads out", async () => {
    setupCreatives({ other: { instagram_actor_id: "other-client" } });
    expect((await listClientAds("client", since, until))?.ads).toEqual([]);
  });

  it("does not silently turn a per-object Meta failure into an empty ad list", async () => {
    mocks.graph.mockImplementation(async (path: string) => path.endsWith("/insights")
      ? { data: [{ ad_id: "mine", spend: "10" }] }
      : { mine: { error: { code: 200, message: "Permission denied" } } });
    await expect(listClientAds("client", since, until)).rejects.toThrow();
  });
});
