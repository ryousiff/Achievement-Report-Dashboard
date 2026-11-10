import { AD_CURRENCY_TO_BHD } from "@/lib/sponsored-ads";
import { logEvent } from "@/lib/observability";

type CurrencyRates = { rates: Record<string, number>; updatedAt: string | null };
let cached: { data: CurrencyRates; expiresAt: number } | null = null;
let pending: Promise<CurrencyRates> | null = null;

export async function getAdCurrencyRates(currencies: Array<string | null | undefined>): Promise<CurrencyRates> {
  const fallback = { rates: { ...AD_CURRENCY_TO_BHD }, updatedAt: null };
  if (currencies.every((currency) => !currency || AD_CURRENCY_TO_BHD[currency.toUpperCase()] !== undefined)) return fallback;
  if (cached && cached.expiresAt > Date.now()) return cached.data;
  if (pending) return pending;
  pending = (async () => {
    try {
      const response = await fetch("https://open.er-api.com/v6/latest/USD", { signal: AbortSignal.timeout(8000), cache: "no-store" });
      if (!response.ok) throw new Error("FX_UNAVAILABLE");
      const body = await response.json() as { result?: string; base_code?: string; rates?: Record<string, number>; time_last_update_unix?: number };
      const bhd = body.rates?.BHD;
      if (body.result !== "success" || body.base_code !== "USD" || !bhd || !Number.isFinite(bhd) || bhd <= 0 || !body.time_last_update_unix || !Number.isFinite(body.time_last_update_unix)) throw new Error("FX_INVALID");
      const updatedAt = new Date(body.time_last_update_unix * 1000);
      if (Date.now() - updatedAt.valueOf() > 3 * 86400000 || updatedAt.valueOf() > Date.now() + 86400000) throw new Error("FX_STALE");
      const rates: Record<string, number> = { ...AD_CURRENCY_TO_BHD };
      for (const [currency, value] of Object.entries(body.rates ?? {})) {
        if (/^[A-Z]{3}$/.test(currency) && typeof value === "number" && Number.isFinite(value) && value > 0 && rates[currency] === undefined) rates[currency] = bhd / value;
      }
      const data = { rates, updatedAt: updatedAt.toISOString() };
      cached = { data, expiresAt: Date.now() + 86400000 };
      return data;
    } catch {
      logEvent("ads.currency.failed", { code: "FX_UNAVAILABLE" });
      return fallback;
    } finally {
      pending = null;
    }
  })();
  return pending;
}
