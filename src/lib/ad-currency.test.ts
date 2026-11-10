import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function freshModule() {
  vi.resetModules();
  return import("@/lib/ad-currency");
}

describe("verified BHD reference rates", () => {
  it("does not request an external provider for USD-pegged currencies", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const { getAdCurrencyRates } = await freshModule();
    const result = await getAdCurrencyRates(["SAR", "BHD"]);
    expect(result.rates.SAR).toBeCloseTo(0.376 / 3.75);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("cross-converts EUR and KWD and shares one cached provider request", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ result: "success", base_code: "USD", time_last_update_unix: Math.floor(Date.now() / 1000), rates: { BHD: 0.376, EUR: 0.92, KWD: 0.307 } }) });
    vi.stubGlobal("fetch", fetch);
    const { getAdCurrencyRates } = await freshModule();
    const [eur, kwd] = await Promise.all([getAdCurrencyRates(["EUR"]), getAdCurrencyRates(["KWD"])]);
    expect(eur.rates.EUR).toBeCloseTo(0.376 / 0.92);
    expect(kwd.rates.KWD).toBeCloseTo(0.376 / 0.307);
    await getAdCurrencyRates(["EUR"]);
    expect(fetch).toHaveBeenCalledOnce();
    expect(eur.updatedAt).toBeTruthy();
  });

  it("does not fabricate conversions on provider failure or stale data", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ result: "success", base_code: "USD", time_last_update_unix: 1, rates: { BHD: 0.376, EUR: 0.92 } }) }));
    const { getAdCurrencyRates } = await freshModule();
    expect((await getAdCurrencyRates(["EUR"])).rates.EUR).toBeUndefined();
  });
});
