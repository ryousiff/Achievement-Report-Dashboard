import { db } from "@/lib/db";

/** Historical, per-post-per-month metric snapshots. See prisma/schema.prisma's
 * `SocialPostMetricSnapshot` model doc comment for the full rationale: `SocialPost.metrics` is the
 * current/live state and keeps changing as Meta is re-synced, so summing it directly for an
 * already-completed month causes report totals to silently drift every time the report is
 * refreshed. This module is the only place that reads/writes those snapshots. */

export type PostMetricSnapshotFields = {
  views: number;
  totalViews: number | null;
  totalInteractions: number;
  likes: number;
  comments: number;
  saved: number;
  shares: number;
  follows: number;
};

/** Where a resolved post's metrics for a report period came from:
 * - LIVE: the post's publish month hasn't ended yet, so its current (still-changing) metrics apply.
 * - SNAPSHOT: the publish month is finalized and an immutable snapshot for it exists — the authoritative,
 *   never-drifting historical value.
 * - LIFETIME_FALLBACK: the publish month is finalized but no snapshot was ever captured for it (e.g. a
 *   report for a period predating this feature); the post's current lifetime metrics are used as a
 *   best-effort stand-in, but this is flagged explicitly rather than silently treated as authoritative —
 *   see report-data.ts/report-refresh.ts for how this gates KPI/media-block refresh replacement. */
export type PostMetricsSource = "LIVE" | "SNAPSHOT" | "LIFETIME_FALLBACK";

export type ResolvedPostMetrics = { metrics: PostMetricSnapshotFields; source: PostMetricsSource };

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function numOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function snapshotFieldsFromMetrics(metrics: Record<string, unknown>): PostMetricSnapshotFields {
  return {
    views: num(metrics.views),
    totalViews: numOrNull(metrics.total_views),
    totalInteractions: num(metrics.total_interactions),
    likes: num(metrics.likes),
    comments: num(metrics.comments),
    saved: num(metrics.saved),
    shares: num(metrics.shares),
    follows: num(metrics.follows),
  };
}

/** UTC calendar-month boundaries containing `date`: [periodStart 00:00:00.000, periodEnd 23:59:59.999]. */
export function monthPeriodUTC(date: Date): { periodStart: Date; periodEnd: Date } {
  const periodStart = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  const periodEnd = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) - 1);
  return { periodStart, periodEnd };
}

/** A calendar month is "finalized" once it has fully elapsed as of `now`. */
export function isMonthFinalized(periodEnd: Date, now: Date = new Date()): boolean {
  return periodEnd.valueOf() < now.valueOf();
}

/** Persist (or, once finalized, leave untouched forever) the historical snapshot of a post's metrics
 * for the calendar month it was published in.
 *
 * Called every time a post's live metrics are written (see meta-sync.ts's upsertPost). While the
 * month is still open, this keeps the snapshot in step with the post's live metrics. The first call
 * observed on or after the month's last day has fully elapsed records one final value and marks the
 * snapshot finalized; every subsequent call for that post/month is then a no-op, so later Meta
 * refreshes (which legitimately keep changing lifetime metrics for up to RECENT_POST_REFRESH_DAYS)
 * can never retroactively change an already-completed month's report. Best-effort: failures are the
 * caller's responsibility to handle so a snapshot write can never break the primary sync. */
export async function persistPostMetricSnapshot(
  postId: string,
  publishedAt: Date,
  metrics: Record<string, unknown>,
  now: Date = new Date(),
): Promise<void> {
  if (!postId) return;
  const { periodStart, periodEnd } = monthPeriodUTC(publishedAt);
  const existing = await db.socialPostMetricSnapshot.findUnique({
    where: { postId_periodStart_periodEnd: { postId, periodStart, periodEnd } },
    select: { finalizedAt: true },
  });
  if (existing?.finalizedAt) return; // already finalized: immutable, never overwritten again.

  const fields = snapshotFieldsFromMetrics(metrics);
  const finalizedAt = isMonthFinalized(periodEnd, now) ? now : null;
  await db.socialPostMetricSnapshot.upsert({
    where: { postId_periodStart_periodEnd: { postId, periodStart, periodEnd } },
    create: { postId, periodStart, periodEnd, ...fields, finalizedAt },
    update: { ...fields, finalizedAt },
  });
}

/** Resolve, for a batch of posts, which metrics a *report* should use for each — see
 * `PostMetricsSource` above for the rules. Used by `reportPosts()` in report-data.ts; live
 * media-library screens intentionally keep reading `SocialPost.metrics` directly instead. */
export async function resolveReportPostMetrics(
  posts: Array<{ id: string; publishedAt: Date; metrics: Record<string, unknown> }>,
  now: Date = new Date(),
): Promise<Map<string, ResolvedPostMetrics>> {
  const result = new Map<string, ResolvedPostMetrics>();
  const finalizedPosts = posts.filter((post) => isMonthFinalized(monthPeriodUTC(post.publishedAt).periodEnd, now));
  const snapshots = finalizedPosts.length > 0
    ? await db.socialPostMetricSnapshot.findMany({ where: { postId: { in: finalizedPosts.map((post) => post.id) } } })
    : [];
  const snapshotByPost = new Map(snapshots.map((snapshot) => [snapshot.postId, snapshot]));

  for (const post of posts) {
    const finalized = isMonthFinalized(monthPeriodUTC(post.publishedAt).periodEnd, now);
    if (!finalized) {
      result.set(post.id, { metrics: snapshotFieldsFromMetrics(post.metrics), source: "LIVE" });
      continue;
    }
    const snapshot = snapshotByPost.get(post.id);
    if (!snapshot) {
      result.set(post.id, { metrics: snapshotFieldsFromMetrics(post.metrics), source: "LIFETIME_FALLBACK" });
      continue;
    }
    result.set(post.id, {
      source: "SNAPSHOT",
      metrics: {
        views: snapshot.views,
        totalViews: snapshot.totalViews,
        totalInteractions: snapshot.totalInteractions,
        likes: snapshot.likes,
        comments: snapshot.comments,
        saved: snapshot.saved,
        shares: snapshot.shares,
        follows: snapshot.follows,
      },
    });
  }
  return result;
}

/** Summarize the accuracy of a set of already-resolved post metric sources for a report block/KPI:
 * - "LIFETIME_FALLBACK" if any post in the set used a fallback (the whole aggregate is then not safe
 *   to treat as a stable historical value — see report-refresh.ts).
 * - "LIVE" / "SNAPSHOT" if every post agrees.
 * - "MIXED" for a period spanning both an open month and finalized months, which is expected (not
 *   drift) and still safe to refresh. */
export function summarizePostMetricsAccuracy(sources: PostMetricsSource[]): PostMetricsSource | "MIXED" {
  if (sources.length === 0) return "LIVE";
  if (sources.some((source) => source === "LIFETIME_FALLBACK")) return "LIFETIME_FALLBACK";
  const unique = new Set(sources);
  return unique.size === 1 ? sources[0] : "MIXED";
}
