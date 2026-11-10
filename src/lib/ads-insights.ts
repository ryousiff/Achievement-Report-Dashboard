/** Paid (Meta Ads) metrics per client, folded into the organic account metrics so the report cards
 * show the same combined totals as Meta's own "Content interactions" (which includes ads).
 *
 * Data path: the persisted system-user token (MetaProfile.encryptedSystemToken) queries
 * /act_<metaAdAccountId>/insights for a date range and we persist monthly rows in
 * ClientAdInsightSnapshot — immutable after the same post-month grace period as post snapshots —
 * so saved reports don't drift and refresh/export stay DB-only. */

import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import { decryptToken } from "@/lib/token-encryption";
import { graph } from "@/lib/meta-sync";
import { isMonthFinalized } from "@/lib/post-metric-snapshots";
import { completedMonthsWithinLookback } from "@/lib/meta-sync-insights";
import { getHistoricalBackfillConfig } from "@/lib/env";
import { splitRangeByMonth } from "@/lib/report-period";
import { logEvent } from "@/lib/observability";
import { getAdCurrencyRates } from "@/lib/ad-currency";

export const SYSTEM_USER_PROFILE_NAME = "Meta Business · Kaan Creative (System user)";

export const AD_INSIGHT_METRICS = [
  "paid_interactions",
  "ad_likes",
  "ad_comments",
  "ad_saved",
  "ad_shares",
  "ad_spend",
  "ad_spend_bhd",
  "ad_impressions",
  "ad_reach",
  "ad_clicks",
  "ad_link_clicks",
  "ad_messages",
] as const;
export type AdInsightMetric = (typeof AD_INSIGHT_METRICS)[number];

export type PaidMetricsResult = {
  values: Partial<Record<AdInsightMetric, number>>;
  configured?: boolean;
  status?: "READY" | "PENDING" | "ERROR";
  /** Billing currency of the client's ad account (e.g. "SAR"), for BHD conversion at display time. */
  currency?: string | null;
  method: "ADS_API" | "AGGREGATE_OF_PERIOD_CHUNKS" | "UNAVAILABLE" | null;
};

const unavailable: PaidMetricsResult = { values: {}, method: "UNAVAILABLE" };

export function paidFetchErrorCode(error: unknown): string {
  if (error && typeof error === "object" && "metaErrorCode" in error && typeof error.metaErrorCode === "number") return `META_${error.metaErrorCode}`;
  const known = ["META_AD_OWNER_UNRESOLVED", "META_AD_OWNERSHIP_LOOKUP_FAILED", "META_AD_OWNERSHIP_LOOKUP_INCOMPLETE", "META_AD_PAGINATION_INCOMPLETE"];
  return error instanceof Error && known.includes(error.message) ? error.message : "META_AD_FETCH_FAILED";
}

/** Approximate ad-account-currency → BHD rates for displaying spend on reports. Spend stays
 * stored in the ad account's own billing currency; conversion is display-only and labelled
 * approximate (≈) on the card. Unknown currencies render as the raw value + currency code. */
export { AD_CURRENCY_TO_BHD } from "@/lib/sponsored-ads";

/** Meta Ads action types that map to organic content-interaction buckets. Meta does not expose
 * reposts/story replies as separate ad actions; what Meta's app counts as "Content interactions"
 * is likes + comments + saves + shares, so we build the paid equivalent the same way. */
const ACTION_TO_METRIC: Record<string, AdInsightMetric> = {
  like: "ad_likes",
  post_reaction: "ad_likes",
  comment: "ad_comments",
  post_comment: "ad_comments",
  "onsite_conversion.post_save": "ad_saved",
  post_save: "ad_saved",
  share: "ad_shares",
  link_click: "ad_link_clicks",
  "onsite_conversion.messaging_conversation_started_7d": "ad_messages",
  messaging_conversation_started_7d: "ad_messages",
};

function startOfDayUTC(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function endOfDayUTC(date: Date) {
  const end = startOfDayUTC(date);
  end.setUTCDate(end.getUTCDate() + 1);
  end.setUTCMilliseconds(end.getUTCMilliseconds() - 1);
  return end;
}

/** The encrypted system-user token persisted when the admin connected the business profile.
 * Required for ad insights — Page tokens cannot call /act_<id>/insights. */
export async function getSystemUserToken(): Promise<string | null> {
  const profile = await db.metaProfile.findFirst({
    where: { displayName: SYSTEM_USER_PROFILE_NAME, encryptedSystemToken: { not: null } },
    orderBy: { createdAt: "desc" },
    select: { encryptedSystemToken: true },
  });
  return profile?.encryptedSystemToken ? decryptToken(profile.encryptedSystemToken) : null;
}

type AdInsightsRow = {
  ad_id?: string;
  adset_id?: string;
  ad_name?: string;
  impressions?: string;
  reach?: string;
  clicks?: string;
  spend?: string;
  actions?: Array<{ action_type?: string; value?: string }>;
};

/** Marker metric written alongside each synced month. Months captured before per-ad scoping
 * existed (account-level totals that mix every client sharing the ad account) have no marker,
 * so the sync re-fetches and overwrites them with correctly scoped values. */
const AD_SCOPE_VERSION_METRIC = "ad_scope_version";
const AD_SCOPE_CONTEXT_METRIC = "ad_scope_context";
const AD_SCOPE_VERSION = 4;

/** What "belongs to this client" means at the ad level: ads promoting the client's own
 * Instagram account (creative media id present in the client's synced SocialPost rows, or the
 * creative/ad-set pointing at the client's IG actor) or its Facebook Page (object_story_id /
 * promoted_object page id). An ad account is frequently shared between many clients' pages, so
 * account-level totals must never be reported per-client. */
type AdScope = { igUserIds: Set<string>; fbPageIds: Set<string>; postIds: Set<string> };

async function clientAdScope(clientId: string): Promise<AdScope> {
  const connections = await db.socialConnection.findMany({
    where: { clientId },
    select: { id: true, platform: true, externalAccountId: true },
  });
  const igUserIds = new Set(connections.filter((c) => c.platform === "INSTAGRAM").map((c) => c.externalAccountId));
  const fbPageIds = new Set(connections.filter((c) => c.platform === "FACEBOOK").map((c) => c.externalAccountId));
  const posts = await db.socialPost.findMany({
    where: { connectionId: { in: connections.map((c) => c.id) }, mediaSource: "OWNED" },
    select: { externalPostId: true },
  });
  return { igUserIds, fbPageIds, postIds: new Set(posts.map((p) => p.externalPostId)) };
}

function scopeMarker(accountId: string, scope: AdScope) {
  const identity = JSON.stringify([accountId, [...scope.igUserIds].sort(), [...scope.fbPageIds].sort()]);
  return Number.parseInt(createHash("sha256").update(identity).digest("hex").slice(0, 12), 16);
}

type AdCreativeInfo = {
  instagram_user_id?: string;
  effective_instagram_media_id?: string;
  object_story_id?: string;
};

async function batchFetch<T>(token: string, ids: string[], fields: string): Promise<Record<string, T>> {
  const result: Record<string, T> = {};
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const res = await graph<Record<string, T | { error?: unknown }>>("", token, { ids: chunk.join(","), fields });
    if (chunk.some((id) => !res?.[id])) throw new Error("META_AD_OWNERSHIP_LOOKUP_INCOMPLETE");
    for (const [id, value] of Object.entries(res ?? {})) {
      if (value && typeof value === "object" && "error" in value) throw new Error("META_AD_OWNERSHIP_LOOKUP_FAILED");
      if (value && typeof value === "object") result[id] = value as T;
    }
  }
  return result;
}

function adOwnedByScope(adsetPromoted: { page_id?: string; instagram_user_id?: string } | undefined, creative: AdCreativeInfo | undefined, scope: AdScope): boolean {
  if (adsetPromoted) {
    if (adsetPromoted.instagram_user_id && scope.igUserIds.has(adsetPromoted.instagram_user_id)) return true;
    if (adsetPromoted.page_id && scope.fbPageIds.has(adsetPromoted.page_id)) return true;
  }
  if (creative) {
    if (creative.instagram_user_id && scope.igUserIds.has(creative.instagram_user_id)) return true;
    if (creative.effective_instagram_media_id && scope.postIds.has(creative.effective_instagram_media_id)) return true;
    if (creative.object_story_id) {
      const pageId = creative.object_story_id.split("_")[0];
      if (scope.fbPageIds.has(pageId)) return true;
    }
  }
  return false;
}

const MAX_INSIGHT_PAGES = 20;

export type ScopedAdInsight = {
  metaAdId: string;
  name: string | null;
  permalink: string | null;
  instagramMediaId: string | null;
  spend: number;
  impressions: number;
  reach: number;
  clicks: number;
  actions: AdInsightsRow["actions"];
};

/** Per-ad insights for a date range (inclusive days), restricted to ads promoting this client's
 * own Page/Instagram assets. Ad-set promoted_object proves ownership first (covers page-like /
 * conversion objectives); the creative decides for the rest — IG-profile boosts carry the
 * promoted media id on the creative, not the ad set. */
async function fetchScopedAdRows(token: string, adAccountId: string, scope: AdScope, since: Date, until: Date): Promise<ScopedAdInsight[]> {
  const timeRange = JSON.stringify({ since: since.toISOString().slice(0, 10), until: until.toISOString().slice(0, 10) });
  const rows: AdInsightsRow[] = [];
  let after: string | undefined;
  for (let page = 0; page < MAX_INSIGHT_PAGES; page++) {
    const res = await graph<{ data?: AdInsightsRow[]; paging?: { cursors?: { after?: string }; next?: string } }>(`${adAccountId}/insights`, token, {
      level: "ad",
      fields: "ad_id,adset_id,ad_name,impressions,reach,clicks,spend,actions",
      time_range: timeRange,
      limit: "500",
      ...(after ? { after } : {}),
    });
    rows.push(...(res.data ?? []));
    const next = res.paging?.next ? res.paging.cursors?.after : undefined;
    if (res.paging?.next && (!next || page === MAX_INSIGHT_PAGES - 1)) throw new Error("META_AD_PAGINATION_INCOMPLETE");
    if (!next) break;
    after = next;
  }
  if (rows.length === 0) return [];

  const adsetIds = [...new Set(rows.map((r) => r.adset_id).filter((id): id is string => Boolean(id)))];
  const adsets = await batchFetch<{ promoted_object?: { page_id?: string; instagram_user_id?: string } }>(token, adsetIds, "promoted_object");
  const promotedByAdset = new Map(Object.entries(adsets).map(([id, adset]) => [id, adset.promoted_object]));

  const needsCreative = rows.filter((r) => {
    const promoted = r.adset_id ? promotedByAdset.get(r.adset_id) : undefined;
    return !adOwnedByScope(promoted, undefined, scope);
  }).map((r) => r.ad_id).filter((id): id is string => Boolean(id));
  const creatives = needsCreative.length > 0
    ? await batchFetch<{ creative?: AdCreativeInfo & { id?: string; instagram_permalink_url?: string } }>(token, needsCreative, "creative{effective_instagram_media_id,instagram_user_id,object_story_id,instagram_permalink_url}")
    : {};

  const num = (v: string | undefined) => (v !== undefined && Number.isFinite(Number(v)) ? Number(v) : undefined);
  const owned: ScopedAdInsight[] = [];
  for (const row of rows) {
    const promoted = row.adset_id ? promotedByAdset.get(row.adset_id) : undefined;
    const creative = row.ad_id ? creatives[row.ad_id]?.creative : undefined;
    if (!adOwnedByScope(promoted, creative, scope)) {
      if (!promoted?.page_id && !promoted?.instagram_user_id && !creative?.instagram_user_id && !creative?.object_story_id) throw new Error("META_AD_OWNER_UNRESOLVED");
      continue;
    }
    owned.push({
      metaAdId: row.ad_id ?? "",
      name: row.ad_name ?? null,
      permalink: creative?.instagram_permalink_url ?? null,
      instagramMediaId: creative?.effective_instagram_media_id ?? null,
      spend: num(row.spend) ?? 0,
      impressions: num(row.impressions) ?? 0,
      reach: num(row.reach) ?? 0,
      clicks: num(row.clicks) ?? 0,
      actions: row.actions,
    });
  }
  return owned;
}

/** One Meta Ads insights call for a date range (inclusive days), restricted to ads promoting
 * this client's own assets. Aggregates the owned per-ad rows from fetchScopedAdRows. */
async function fetchAdWindow(token: string, adAccountId: string, scope: AdScope, since: Date, until: Date, currency: string | null): Promise<Partial<Record<AdInsightMetric, number>>> {
  const scopeRows = await fetchScopedAdRows(token, adAccountId, scope, since, until);
  const values = Object.fromEntries(AD_INSIGHT_METRICS.filter((metric) => metric !== "ad_spend_bhd").map((metric) => [metric, 0])) as Partial<Record<AdInsightMetric, number>>;
  const num = (v: string | number | undefined) => (v !== undefined && Number.isFinite(Number(v)) ? Number(v) : undefined);
  for (const row of scopeRows) {
    values.ad_spend = (values.ad_spend ?? 0) + row.spend;
    values.ad_impressions = (values.ad_impressions ?? 0) + row.impressions;
    values.ad_reach = (values.ad_reach ?? 0) + row.reach;
    values.ad_clicks = (values.ad_clicks ?? 0) + row.clicks;
    const actionValues: Partial<Record<AdInsightMetric, number>> = {};
    for (const action of row.actions ?? []) {
      if (!action.action_type) continue;
      const metric = ACTION_TO_METRIC[action.action_type];
      const actionValue = num(action.value);
      if (metric && actionValue !== undefined) actionValues[metric] = Math.max(actionValues[metric] ?? 0, actionValue);
    }
    for (const [metric, value] of Object.entries(actionValues) as Array<[AdInsightMetric, number]>) values[metric] = (values[metric] ?? 0) + value;
  }
  values.paid_interactions = (values.ad_likes ?? 0) + (values.ad_comments ?? 0) + (values.ad_saved ?? 0) + (values.ad_shares ?? 0);
  const fx = await getAdCurrencyRates([currency]);
  const rate = currency ? fx.rates[currency] : undefined;
  if (rate === undefined) throw new Error("AD_FX_UNAVAILABLE");
  values.ad_spend_bhd = (values.ad_spend ?? 0) * rate;
  return values;
}

async function adAccountForClient(clientId: string) {
  return db.client.findUnique({ where: { id: clientId }, select: { metaAdAccountId: true, metaAdAccountCurrency: true } });
}

/** Live per-ad list for a client's sponsored-ads section: every ad that promoted one of the
 * client's own posts during the range, with its real Meta spend/reach/impressions/clicks.
 * Returns null when the client has no ad account or no stored system-user token. */
export async function listClientAds(clientId: string, since: Date, until: Date): Promise<{ ads: ScopedAdInsight[]; currency: string | null } | null> {
  const client = await adAccountForClient(clientId);
  if (!client?.metaAdAccountId) return null;
  const token = await getSystemUserToken();
  if (!token) return null;
  const scope = await clientAdScope(clientId);
  const ads = await fetchScopedAdRows(token, client.metaAdAccountId, scope, startOfDayUTC(since), endOfDayUTC(until));
  const currency = client.metaAdAccountCurrency ?? await ensureAdAccountCurrency(clientId, client.metaAdAccountId, null, token);
  return { ads, currency };
}

/** Billing currency of the ad account — fetched lazily during sync and persisted on the client
 * so the report can convert spend to BHD without a live Meta call. */
async function ensureAdAccountCurrency(clientId: string, adAccountId: string, current: string | null, token: string) {
  const account = await graph<{ currency?: string }>(`${adAccountId}`, token, { fields: "currency" });
  if (account.currency && account.currency !== current) {
    await db.client.update({ where: { id: clientId }, data: { metaAdAccountCurrency: account.currency } });
  }
  return account.currency ?? null;
}

/** Live paid metrics for an arbitrary report range — chunked per calendar month so the values match
 * the monthly snapshots. Returns UNAVAILABLE when the client has no ad account or no stored token. */
export async function periodPaidMetricsForRange(clientId: string, periodStart: Date, periodEnd: Date): Promise<PaidMetricsResult> {
  try {
    const client = await adAccountForClient(clientId);
    if (!client?.metaAdAccountId) return unavailable;
    const token = await getSystemUserToken();
    if (!token) return { ...unavailable, configured: true, status: "ERROR" };

    const currency = client.metaAdAccountCurrency ?? await ensureAdAccountCurrency(clientId, client.metaAdAccountId, null, token);
    const scope = await clientAdScope(clientId);
    const values: PaidMetricsResult["values"] = {};
    for (const chunk of splitRangeByMonth(periodStart, periodEnd)) {
      const window = await fetchAdWindow(token, client.metaAdAccountId, scope, startOfDayUTC(chunk.start), endOfDayUTC(chunk.end), currency);
      for (const [metric, value] of Object.entries(window) as Array<[AdInsightMetric, number]>) {
        values[metric] = (values[metric] ?? 0) + value;
      }
    }
    if (Object.keys(values).length === 0) return unavailable;
    return { values, currency, configured: true, status: "READY", method: "ADS_API" };
  } catch (error) {
    logEvent("ads.fetch.failed", { clientId, code: paidFetchErrorCode(error) });
    return { ...unavailable, configured: true, status: "ERROR" };
  }
}

/** DB-only paid metrics from stored monthly snapshots — used by refresh/export. */
export async function periodPaidMetricsFromDatabase(clientId: string, periodStart: Date, periodEnd: Date): Promise<PaidMetricsResult> {
  try {
    const client = await adAccountForClient(clientId);
    if (!client?.metaAdAccountId) return unavailable;
    const currency = client.metaAdAccountCurrency;
    const scope = await clientAdScope(clientId);
    const marker = scopeMarker(client.metaAdAccountId, scope);
    const values: PaidMetricsResult["values"] = {};
    for (const chunk of splitRangeByMonth(periodStart, periodEnd)) {
      const rows = await db.clientAdInsightSnapshot.findMany({
        where: {
          clientId,
          periodStart: { gte: startOfDayUTC(chunk.start), lte: endOfDayUTC(chunk.start) },
          periodEnd: { gte: startOfDayUTC(chunk.end), lte: endOfDayUTC(chunk.end) },
        },
        select: { metric: true, value: true },
      });
      if (rows.length === 0) return { ...unavailable, configured: true, status: "PENDING" }; // any missing month makes the paid contribution unknown
      if (!rows.some((row) => row.metric === AD_SCOPE_VERSION_METRIC && row.value === AD_SCOPE_VERSION) || !rows.some((row) => row.metric === AD_SCOPE_CONTEXT_METRIC && row.value === marker)) return { ...unavailable, configured: true, status: "PENDING" };
      for (const row of rows) {
        if ((AD_INSIGHT_METRICS as readonly string[]).includes(row.metric)) {
          values[row.metric as AdInsightMetric] = (values[row.metric as AdInsightMetric] ?? 0) + row.value;
        }
      }
    }
    if (Object.keys(values).length === 0) return unavailable;
    return { values, currency, configured: true, status: "READY", method: "AGGREGATE_OF_PERIOD_CHUNKS" };
  } catch (error) {
    logEvent("ads.fetch.failed", { clientId, code: paidFetchErrorCode(error) });
    return { ...unavailable, configured: true, status: "ERROR" };
  }
}

/** Capture one missing completed calendar month of paid metrics for a client. Called from the
 * daily account-insight job; deliberately at most one month per run to bound API volume. */
export async function syncMissingClientAdMonth(clientId: string, now: Date = new Date()): Promise<boolean> {
  const client = await adAccountForClient(clientId);
  if (!client?.metaAdAccountId) return false;
  const token = await getSystemUserToken();
  if (!token) return false;
  const currency = await ensureAdAccountCurrency(clientId, client.metaAdAccountId, client.metaAdAccountCurrency, token);

  const config = getHistoricalBackfillConfig();
  const lookbackStart = new Date(Date.now() - config.accountInsightMaxLookbackDays * 24 * 60 * 60 * 1000);
  const scope = await clientAdScope(clientId);
  const marker = scopeMarker(client.metaAdAccountId, scope);
  for (const period of completedMonthsWithinLookback(now, lookbackStart)) {
    const periodStart = startOfDayUTC(period.start);
    const periodEnd = endOfDayUTC(period.end);
    // A month counts as captured only when it carries the current scope-version marker. Months
    // synced at account level (pre-scoping, or missing newer metrics) get re-fetched and fully
    // rewritten below so no stale account-level rows survive.
    const existing = await db.clientAdInsightSnapshot.findMany({
      where: { clientId, periodStart, periodEnd, metric: { in: [AD_SCOPE_VERSION_METRIC, AD_SCOPE_CONTEXT_METRIC] } },
      select: { metric: true, value: true, finalizedAt: true },
    });
    if (existing.some((row) => row.metric === AD_SCOPE_VERSION_METRIC && row.value === AD_SCOPE_VERSION && row.finalizedAt) && existing.some((row) => row.metric === AD_SCOPE_CONTEXT_METRIC && row.value === marker)) continue;

    const values = await fetchAdWindow(token, client.metaAdAccountId, scope, periodStart, periodEnd, currency);
    const finalized = isMonthFinalized(periodEnd, now);
    // Rewrite the month from scratch: drop any rows captured under an older scope so account-level
    // leftovers can't linger next to the new per-client values, then insert the fresh rows plus
    // the version marker (even when the month had no owned ads, so it isn't retried forever).
    await db.$transaction(async (tx) => {
      const entries = [...Object.entries(values), [AD_SCOPE_VERSION_METRIC, AD_SCOPE_VERSION], [AD_SCOPE_CONTEXT_METRIC, marker]] as Array<[string, number]>;
      for (const [metric, value] of entries) {
        await tx.clientAdInsightSnapshot.upsert({
          where: { clientId_metric_periodStart_periodEnd: { clientId, metric, periodStart, periodEnd } },
          create: { clientId, metric, periodStart, periodEnd, value, capturedAt: now, finalizedAt: finalized ? now : null },
          update: { value, capturedAt: now, finalizedAt: finalized ? now : null },
        });
      }
    });
    return true; // one month per run
  }
  return false;
}
