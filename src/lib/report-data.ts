import { BlockType } from "@prisma/client";
import { db } from "@/lib/db";

export type ReportMetric = "reach" | "views" | "total_interactions" | "likes" | "comments" | "saved" | "shares" | "follows" | "posts";

type PostMetrics = Record<string, number>;
type ReportPost = { id: string; externalPostId: string; caption: string | null; mediaType: string; mediaUrl: string | null; thumbnailUrl: string | null; permalink: string | null; publishedAt: string; metrics: PostMetrics; metricAvailability: Record<string, string>; score: number };
type ReportBlock = { type: BlockType; title: string; content: Record<string, unknown> };

export function completeDailySeries(periodStart: Date, periodEnd: Date, entries: Array<[string, number]>) {
  const valuesByDay = new Map(entries);
  const series: Array<[string, number]> = [];
  const date = new Date(Date.UTC(periodStart.getUTCFullYear(), periodStart.getUTCMonth(), periodStart.getUTCDate()));
  const end = new Date(Date.UTC(periodEnd.getUTCFullYear(), periodEnd.getUTCMonth(), periodEnd.getUTCDate()));
  while (date <= end) { const day = date.toISOString().slice(0, 10); series.push([day, valuesByDay.get(day) ?? 0]); date.setUTCDate(date.getUTCDate() + 1); }
  return series;
}

const metricLabel: Record<ReportMetric, string> = { reach: "شخص تم الوصول له", views: "مشاهدة", total_interactions: "التفاعل مع المحتوى", likes: "إعجاب", comments: "تعليق", saved: "حفظ", shares: "مشاركة", follows: "المتابعون الجدد", posts: "منشور" };

function value(metrics: PostMetrics, metric: ReportMetric) {
  return metric === "posts" ? 0 : metrics[metric] ?? 0;
}

function score(post: ReportPost) {
  return (post.metrics.total_interactions ?? 0) + (post.metrics.shares ?? 0) + (post.metrics.saved ?? 0) + (post.metrics.follows ?? 0);
}

function total(posts: ReportPost[], metric: ReportMetric) {
  return metric === "posts" ? posts.length : posts.reduce((sum, post) => sum + value(post.metrics, metric), 0);
}

function kpi(id: ReportMetric | "engagement-rate", label: string, value: string, available = true) {
  return { id, label, value, available, display: "cards" };
}

function mediaBlock(title: string, body: string, posts: ReportPost[], display: string[]) {
  return { type: BlockType.MEDIA, title, content: { body, mediaItems: posts, mediaDisplay: display, autoFilled: true } };
}

export async function reportPosts(clientId: string, periodStart: Date, periodEnd: Date) {
  const posts = await db.socialPost.findMany({ where: { connection: { clientId }, publishedAt: { gte: periodStart, lte: periodEnd } }, orderBy: { publishedAt: "desc" } });
  return posts.map((post): ReportPost => {
    const metrics = post.metrics as PostMetrics;
    const item = { id: post.id, externalPostId: post.externalPostId, caption: post.caption, mediaType: post.mediaType, mediaUrl: post.mediaUrl, thumbnailUrl: post.thumbnailUrl, permalink: post.permalink, publishedAt: post.publishedAt.toISOString(), metrics, metricAvailability: (post.metricAvailability as Record<string, string> | null) ?? {}, score: 0 };
    return { ...item, score: score(item) };
  });
}

export async function periodAccountMetricTotal(clientId: string, metric: "reach" | "follows", periodStart: Date, periodEnd: Date) {
  const snapshots = await db.socialInsightSnapshot.findMany({ where: { connection: { clientId }, metric, periodEnd: { gte: periodStart, lte: periodEnd } }, select: { value: true } });
  if (snapshots.length === 0) return null;
  return snapshots.reduce((sum, snapshot) => sum + snapshot.value, 0);
}

export async function buildStandardReportBlocks(clientId: string, periodStart: Date, periodEnd: Date): Promise<ReportBlock[]> {
  const posts = await reportPosts(clientId, periodStart, periodEnd);
  const totals = Object.fromEntries((["reach", "views", "total_interactions", "likes", "comments", "saved", "shares", "follows", "posts"] as ReportMetric[]).map((metric) => [metric, total(posts, metric)])) as Record<ReportMetric, number>;
  const hasMetric = (metric: ReportMetric) => metric === "posts" || posts.some((post) => post.metricAvailability[metric] === "returned" || (Object.keys(post.metricAvailability).length === 0 && typeof post.metrics[metric] === "number"));
  // Account-level reach is Meta's unique-accounts-reached metric for the account; summing per-post reach would double-count
  // people reached by more than one post, so prefer the account-level daily snapshots (matches Meta's own dashboards and
  // third-party tools like Iconosquare) and only fall back to the per-post sum when no snapshots have been synced yet.
  const accountReach = await periodAccountMetricTotal(clientId, "reach", periodStart, periodEnd);
  const hasReach = accountReach !== null || hasMetric("reach");
  if (accountReach !== null) totals.reach = accountReach;
  const engagementRate = hasReach && totals.reach > 0 ? `${((totals.total_interactions / totals.reach) * 100).toFixed(2)}%` : "غير متاح";
  const topBy = (metric: ReportMetric) => [...posts].sort((left, right) => value(right.metrics, metric) - value(left.metrics, metric)).filter((post) => value(post.metrics, metric) > 0).slice(0, 4);
  const topInteractions = topBy("total_interactions");
  const topViews = topBy("views");
  const topFollows = topBy("follows");
  const formats = ["REELS", "IMAGE", "VIDEO", "CAROUSEL_ALBUM"].map((mediaType) => ({ id: `format-${mediaType}`, label: mediaType === "REELS" ? "الريلز" : mediaType === "IMAGE" ? "المنشورات" : mediaType === "VIDEO" ? "الفيديوهات" : "الألبومات", value: String(posts.filter((post) => post.mediaType === mediaType).reduce((sum, post) => sum + (post.metrics.total_interactions ?? 0), 0)), display: "cards" })).filter((item) => Number(item.value) > 0);
  const snapshots = await db.socialInsightSnapshot.findMany({ where: { connection: { clientId }, metric: "follows", periodEnd: { gte: periodStart, lte: periodEnd } }, orderBy: { periodEnd: "asc" } });
  const dailyFollowEntries = [...snapshots.reduce((days, snapshot) => { const day = snapshot.periodEnd.toISOString().slice(0, 10); days.set(day, (days.get(day) ?? 0) + snapshot.value); return days; }, new Map<string, number>()).entries()];
  const postFollowerEntries = [...posts.filter((post) => (post.metrics.follows ?? 0) > 0).reduce((days, post) => { const day = post.publishedAt.slice(0, 10); days.set(day, (days.get(day) ?? 0) + (post.metrics.follows ?? 0)); return days; }, new Map<string, number>()).entries()];
  const rawFollowerEntries = dailyFollowEntries.length > 0 ? dailyFollowEntries : postFollowerEntries;
  const completeFollowerEntries = completeDailySeries(periodStart, periodEnd, rawFollowerEntries);
  const followerValues = completeFollowerEntries.map(([, value]) => value);
  const followerLabels = completeFollowerEntries.map(([day]) => day);
  const followerSource = dailyFollowEntries.length > 0 ? "بيانات المتابعين الجدد اليومية من Meta خلال الفترة." : "اكتساب المتابعين الفعلي من المنشورات، مجمّع حسب تاريخ النشر.";

  return [
    { type: BlockType.TEXT, title: "غلاف التقرير", content: { body: "تقرير الإنجاز الشهري", page: "cover" } },
    { type: BlockType.KPI, title: "أهم الإحصائيات", content: { body: "إحصائيات الفترة المحددة من بيانات Meta المتاحة.", kpis: [kpi("reach", metricLabel.reach, hasReach ? totals.reach.toLocaleString() : "غير متاح", hasReach), kpi("views", metricLabel.views, hasMetric("views") ? totals.views.toLocaleString() : "غير متاح", hasMetric("views")), kpi("engagement-rate", "متوسط التفاعل على أساس الوصول", engagementRate, hasReach), kpi("follows", "المتابعون الجدد", hasMetric("follows") ? totals.follows.toLocaleString() : "غير متاح", hasMetric("follows")), kpi("posts", metricLabel.posts, totals.posts.toLocaleString())], comparison: "none", autoFilled: true } },
    { type: BlockType.KPI, title: "التفاعل مع المحتوى", content: { body: "إجماليات التفاعل للمنشورات خلال الفترة.", kpis: [kpi("total_interactions", metricLabel.total_interactions, hasMetric("total_interactions") ? totals.total_interactions.toLocaleString() : "غير متاح", hasMetric("total_interactions")), kpi("likes", metricLabel.likes, hasMetric("likes") ? totals.likes.toLocaleString() : "غير متاح", hasMetric("likes")), kpi("comments", metricLabel.comments, hasMetric("comments") ? totals.comments.toLocaleString() : "غير متاح", hasMetric("comments")), kpi("saved", "حفظ", hasMetric("saved") ? totals.saved.toLocaleString() : "غير متاح", hasMetric("saved")), kpi("shares", "مشاركة", hasMetric("shares") ? totals.shares.toLocaleString() : "غير متاح", hasMetric("shares"))], comparison: "none", autoFilled: true } },
    { type: BlockType.CHART, title: "معدل اكتساب المتابعين اليومي", content: rawFollowerEntries.length > 0 ? { body: followerSource, chart: { type: "line", metric: "المتابعون الجدد يومياً", values: followerValues.join(", "), labels: followerLabels.join(", "), insight: `إجمالي المتابعين الجدد خلال الأيام المتاحة: ${followerValues.reduce((sum, value) => sum + value, 0).toLocaleString()}.` } } : { body: "لا تتوفر بيانات لاكتساب متابعين خلال الفترة.", chartUnavailable: true, unavailableReason: "Meta لم ترسل بيانات المتابعين الجدد للمنشورات أو للحساب في هذه الفترة." } },
    mediaBlock("أعلى المنشورات من حيث اكتساب المتابعين", "تم اختيار المنشورات الأعلى من بيانات الفترة.", topFollows, ["follows"]),
    { type: BlockType.KPI, title: "التفاعل حسب نوع المحتوى", content: { body: "إجمالي التفاعل حسب نوع المنشور.", kpis: formats, comparison: "none", autoFilled: true } },
    mediaBlock("أعلى المنشورات من حيث التفاعل", "تم اختيار المنشورات الأعلى تفاعلاً من بيانات الفترة.", topInteractions, ["total_interactions", "views"]),
    mediaBlock("أعلى المنشورات من حيث المشاهدات", "تم اختيار المنشورات الأعلى مشاهدة من بيانات الفترة.", topViews, ["views", "total_interactions"]),
    mediaBlock("محتوى الشهر", "أضيفي نماذج إضافية من المحتوى أو احتفظي بالمنشورات المختارة تلقائياً.", [...posts].sort((left, right) => right.score - left.score).slice(0, 4), ["total_interactions", "views"]),
    { type: BlockType.NOTES, title: "التوصيات", content: { body: "أضيفي توصيات عملية قابلة للتنفيذ للشهر القادم." } },
    { type: BlockType.TEXT, title: "شكراً على ثقتكم", content: { body: "Kaan Creative", page: "closing" } },
  ];
}
