/** Paid (Meta Ads) metrics per client, folded into the organic account metrics so the report cards
 * show the same combined totals as Meta's own "Content interactions" (which includes ads).
 *
 * Data path: the persisted system-user token (MetaProfile.encryptedSystemToken) queries
 * /act_<metaAdAccountId>/insights for a date range and we persist monthly rows in
 * ClientAdInsightSnapshot — immutable after the same post-month grace period as post snapshots —
 * so saved reports don't drift and refresh/export stay DB-only. */

import { db } from "@/lib/db";
import { decryptToken } from "@/lib/token-encryption";
import { graph } from "@/lib/meta-sync";
import { isMonthFinalized } from "@/lib/post-metric-snapshots";
import { completedMonthsWithinLookback } from "@/lib/meta-sync-insights";
import { getHistoricalBackfillConfig } from "@/lib/env";
import { splitRangeByMonth } from "@/lib/report-period";

export const SYSTEM_USER_PROFILE_NAME = "Meta Business · Kaan Creative (System user)";

export const AD_INSIGHT_METRICS = [
  "paid_interactions",
  "ad_likes",
  "ad_comments",
  "ad_saved",
  "ad_shares",
  "ad_spend",
  "ad_impressions",
  "ad_reach",
  "ad_clicks",
] as const;
export type AdInsightMetric = (typeof AD_INSIGHT_METRICS)[number];

export type PaidMetricsResult = {
  values: Partial<Record<AdInsightMetric, number>>;
  method: "ADS_API" | "AGGREGATE_OF_PERIOD_CHUNKS" | "UNAVAILABLE" | null;
};

const unavailable: PaidMetricsResult = { values: {}, method: "UNAVAILABLE" };

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
  impressions?: string;
  reach?: string;
  clicks?: string;
  spend?: string;
  actions?: Array<{ action_type?: string; value?: string }>;
};

/** One Meta Ads insights call for a date range (inclusive days), account level. */
async function fetchAdWindow(token: string, adAccountId: string, since: Date, until: Date): Promise<Partial<Record<AdInsightMetric, number>>> {
  const timeRange = JSON.stringify({ since: since.toISOString().slice(0, 10), until: until.toISOString().slice(0, 10) });
  const res = await graph<{ data?: AdInsightsRow[] }>(`${adAccountId}/insights`, token, {
    level: "account",
    fields: "impressions,reach,clicks,spend,actions",
    time_range: timeRange,
  });
  const row = res.data?.[0];
  if (!row) return {};
  const values: Partial<Record<AdInsightMetric, number>> = {};
  const num = (v: string | undefined) => (v !== undefined && Number.isFinite(Number(v)) ? Number(v) : undefined);
  const spend = num(row.spend);
  const impressions = num(row.impressions);
  const reach = num(row.reach);
  const clicks = num(row.clicks);
  if (spend !== undefined) values.ad_spend = spend;
  if (impressions !== undefined) values.ad_impressions = impressions;
  if (reach !== undefined) values.ad_reach = reach;
  if (clicks !== undefined) values.ad_clicks = clicks;
  for (const action of row.actions ?? []) {
    if (!action.action_type) continue;
    const metric = ACTION_TO_METRIC[action.action_type];
    const actionValue = num(action.value);
    if (metric && actionValue !== undefined) values[metric] = (values[metric] ?? 0) + actionValue;
  }
  values.paid_interactions = (values.ad_likes ?? 0) + (values.ad_comments ?? 0) + (values.ad_saved ?? 0) + (values.ad_shares ?? 0);
  return values;
}

async function adAccountForClient(clientId: string): Promise<string | null> {
  const client = await db.client.findUnique({ where: { id: clientId }, select: { metaAdAccountId: true } });
  return client?.metaAdAccountId ?? null;
}

/** Live paid metrics for an arbitrary report range — chunked per calendar month so the values match
 * the monthly snapshots. Returns UNAVAILABLE when the client has no ad account or no stored token. */
export async function periodPaidMetricsForRange(clientId: string, periodStart: Date, periodEnd: Date): Promise<PaidMetricsResult> {
  try {
    const adAccountId = await adAccountForClient(clientId);
    if (!adAccountId) return unavailable;
    const token = await getSystemUserToken();
    if (!token) return unavailable;

    const values: PaidMetricsResult["values"] = {};
    for (const chunk of splitRangeByMonth(periodStart, periodEnd)) {
      const window = await fetchAdWindow(token, adAccountId, startOfDayUTC(chunk.start), endOfDayUTC(chunk.end));
      for (const [metric, value] of Object.entries(window) as Array<[AdInsightMetric, number]>) {
        values[metric] = (values[metric] ?? 0) + value;
      }
    }
    if (Object.keys(values).length === 0) return unavailable;
    return { values, method: "ADS_API" };
  } catch {
    return unavailable;
  }
}

/** DB-only paid metrics from stored monthly snapshots — used by refresh/export. */
export async function periodPaidMetricsFromDatabase(clientId: string, periodStart: Date, periodEnd: Date): Promise<PaidMetricsResult> {
  try {
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
      if (rows.length === 0) return unavailable; // any missing month makes the paid contribution unknown
      for (const row of rows) {
        if ((AD_INSIGHT_METRICS as readonly string[]).includes(row.metric)) {
          values[row.metric as AdInsightMetric] = (values[row.metric as AdInsightMetric] ?? 0) + row.value;
        }
      }
    }
    if (Object.keys(values).length === 0) return unavailable;
    return { values, method: "AGGREGATE_OF_PERIOD_CHUNKS" };
  } catch {
    return unavailable;
  }
}

/** Capture one missing completed calendar month of paid metrics for a client. Called from the
 * daily account-insight job; deliberately at most one month per run to bound API volume. */
export async function syncMissingClientAdMonth(clientId: string, now: Date = new Date()): Promise<boolean> {
  const adAccountId = await adAccountForClient(clientId);
  if (!adAccountId) return false;
  const token = await getSystemUserToken();
  if (!token) return false;

  const config = getHistoricalBackfillConfig();
  const lookbackStart = new Date(Date.now() - config.accountInsightMaxLookbackDays * 24 * 60 * 60 * 1000);
  for (const period of completedMonthsWithinLookback(now, lookbackStart)) {
    const periodStart = startOfDayUTC(period.start);
    const periodEnd = endOfDayUTC(period.end);
    const existing = await db.clientAdInsightSnapshot.findUnique({
      where: {
        clientId_metric_periodStart_periodEnd: { clientId, metric: "paid_interactions", periodStart, periodEnd },
      },
      select: { id: true },
    });
    if (existing) continue;

    const values = await fetchAdWindow(token, adAccountId, periodStart, periodEnd);
    if (Object.keys(values).length === 0) continue;
    const finalized = isMonthFinalized(periodEnd, now);
    await Promise.all((Object.entries(values) as Array<[AdInsightMetric, number]>).map(([metric, value]) =>
      db.clientAdInsightSnapshot.upsert({
        where: { clientId_metric_periodStart_periodEnd: { clientId, metric, periodStart, periodEnd } },
        create: { clientId, metric, periodStart, periodEnd, value, finalizedAt: finalized ? now : null },
        update: { value, capturedAt: now, ...(finalized ? { finalizedAt: now } : {}) },
      }),
    ));
    return true; // one month per run
  }
  return false;
}
