import { BlockType, Prisma, SyncJobStatus } from "@prisma/client";
import { db } from "@/lib/db";
import {
  REPORT_DATA_DRIVEN_REFRESH_KEYS,
  type ReportBlock,
  type ReportRefreshKey,
} from "@/lib/report-data";
import {
  buildStandardReportBlocksFromStoredPeriodSnapshots,
  storedAccountFollowersForRange,
  storedAccountReachForRange,
  storedAccountViewsForRange,
} from "@/lib/stored-period-metrics";

type RefreshOptions = {
  /** When true (default), the refresh only reads data already in the database and does not
   * call the Meta Graph API. This is the required behavior before exporting a report. */
  skipMetaApi?: boolean;
};

const DEFAULT_OPTIONS: Required<RefreshOptions> = { skipMetaApi: true };

/** These KPIs use account-level period semantics and must never be replaced by daily/media reconstructions. */
const AUTHORITATIVE_PERIOD_KPI_IDS = new Set([
  "reach",
  "total-views",
  "follows",
  "followers-lost",
  "net-follower-growth",
]);

/** The DB-only builder used here returns account-level period KPIs only from persisted TOTAL_VALUE
 * snapshots. If a snapshot for the requested range is missing, keep the previously validated report value. */
function isSafeAuthoritativeFreshKpi(id: string, kpi: Record<string, unknown>) {
  if (!AUTHORITATIVE_PERIOD_KPI_IDS.has(id)) return true;
  return kpi.available === true;
}

function daysBetweenInclusive(from: Date, to: Date) {
  const start = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  const end = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
  return Math.max(1, Math.floor((end - start) / (24 * 60 * 60 * 1000)) + 1);
}

/** Load the Instagram connection for a client. */
async function fetchConnection(clientId: string) {
  return db.socialConnection.findFirst({
    where: { clientId, platform: "INSTAGRAM" },
    select: { id: true, lastSuccessfulSyncAt: true },
  });
}

/** Determine DB-only report coverage using the same authoritative period snapshots that refresh/export use. */
async function computeCoverageSummary(clientId: string, periodStart: Date, periodEnd: Date) {
  const connection = await fetchConnection(clientId);
  const warnings: string[] = [];
  let status: "COMPLETE" | "PARTIAL" | "SYNCING" | "UNAVAILABLE" = "COMPLETE";

  if (connection) {
    const activeJobs = await db.syncJob.findMany({
      where: { connectionId: connection.id, status: { in: [SyncJobStatus.QUEUED, SyncJobStatus.RUNNING] } },
      select: { id: true, type: true },
    });
    if (activeJobs.length > 0) {
      status = "SYNCING";
      warnings.push("جارٍ تحميل البيانات. أعدي فتح التقرير أو تحديث البيانات لاحقاً.");
    }
  }

  const postsCount = await db.socialPost.count({
    where: { connection: { clientId }, publishedAt: { gte: periodStart, lte: periodEnd } },
  });
  if (postsCount === 0 && status === "COMPLETE") {
    status = "UNAVAILABLE";
    warnings.push("لا توجد منشورات متزامنة لهذه الفترة.");
  }

  if (connection) {
    const [reach, views, followers] = await Promise.all([
      storedAccountReachForRange(clientId, periodStart, periodEnd),
      storedAccountViewsForRange(clientId, periodStart, periodEnd),
      storedAccountFollowersForRange(clientId, periodStart, periodEnd),
    ]);
    const days = daysBetweenInclusive(periodStart, periodEnd);

    // Reach is intentionally non-additive beyond 31 days, so its absence does not make a quarter/year partial.
    if (days <= 31 && reach.value === null) {
      if (status === "COMPLETE") status = "PARTIAL";
      warnings.push("لا تتوفر قيمة الوصول المعتمدة لهذه الفترة بعد.");
    }
    if (views.value === null) {
      if (status === "COMPLETE") status = "PARTIAL";
      warnings.push("لا تتوفر قيمة إجمالي المشاهدات المعتمدة لكل أشهر الفترة بعد.");
    }
    if (followers.gained === null || followers.lost === null) {
      if (status === "COMPLETE") status = "PARTIAL";
      warnings.push("لا تتوفر قيم حركة المتابعين المعتمدة لكل أشهر الفترة بعد.");
    }
  }

  return { status, warnings };
}

function isDataDrivenRefreshKey(key: unknown): key is (typeof REPORT_DATA_DRIVEN_REFRESH_KEYS)[number] {
  return typeof key === "string" && REPORT_DATA_DRIVEN_REFRESH_KEYS.includes(key as (typeof REPORT_DATA_DRIVEN_REFRESH_KEYS)[number]);
}

function getRefreshKey(content: Record<string, unknown>): ReportRefreshKey | undefined {
  const key = content.refreshKey;
  if (isDataDrivenRefreshKey(key)) return key;
  if (key === "cover" || key === "notes-recommendations" || key === "closing") return key;
  return undefined;
}

function mergeKpis(existing: unknown, fresh: unknown): unknown {
  const existingKpis = Array.isArray(existing) ? existing as Record<string, unknown>[] : [];
  const freshKpis = Array.isArray(fresh) ? fresh as Record<string, unknown>[] : [];
  const freshById = new Map(freshKpis.map((kpi) => [String(kpi.id), kpi]));
  const mergedKpis = existingKpis.map((kpi) => {
    const id = String(kpi.id ?? "");
    const freshKpi = freshById.get(id);
    if (!freshKpi) return kpi;

    // Authoritative period KPIs are replaced only when the DB has a persisted period snapshot.
    if (AUTHORITATIVE_PERIOD_KPI_IDS.has(id) && !isSafeAuthoritativeFreshKpi(id, freshKpi)) return kpi;

    return {
      ...kpi,
      value: freshKpi.value,
      available: freshKpi.available,
      reachAccuracy: freshKpi.reachAccuracy,
      reachMethod: freshKpi.reachMethod,
      followersAccuracy: freshKpi.followersAccuracy,
      followersMethod: freshKpi.followersMethod,
      viewsAccuracy: freshKpi.viewsAccuracy,
      viewsMethod: freshKpi.viewsMethod,
      badge: freshKpi.badge,
      tooltip: freshKpi.tooltip,
    };
  });
  const existingIds = new Set(existingKpis.map((kpi) => String(kpi.id ?? "")));
  const newKpis = freshKpis.filter((kpi) => {
    const id = String(kpi.id ?? "");
    return !existingIds.has(id) && (!AUTHORITATIVE_PERIOD_KPI_IDS.has(id) || isSafeAuthoritativeFreshKpi(id, kpi));
  });
  return [...mergedKpis, ...newKpis];
}

function mergeMediaItems(existing: unknown, fresh: unknown): unknown {
  const existingItems = Array.isArray(existing) ? existing as Record<string, unknown>[] : [];
  const freshItems = Array.isArray(fresh) ? fresh as Record<string, unknown>[] : [];
  const freshById = new Map(freshItems.map((item) => [String(item.id), item]));
  const mergedItems = existingItems.map((item) => {
    const id = String(item.id ?? "");
    if (id.startsWith("manual-")) return item;
    return freshById.get(id) ?? item;
  });
  const existingIds = new Set(existingItems.map((item) => String(item.id ?? "")));
  const newItems = freshItems.filter((item) => !existingIds.has(String(item.id ?? "")));
  return [...mergedItems, ...newItems];
}

/** Merge freshly computed content into an existing block while preserving manual edits. */
function mergeBlockContent(existing: ReportBlock, fresh: ReportBlock): ReportBlock {
  const existingContent = existing.content;
  const freshContent = fresh.content;
  const refreshKey = getRefreshKey(existingContent) ?? getRefreshKey(freshContent);

  // Manual blocks are never replaced.
  if (refreshKey && !isDataDrivenRefreshKey(refreshKey)) {
    return existing;
  }

  const merged: Record<string, unknown> = { ...freshContent };

  // Preserve user-edited title/body on data-driven blocks.
  if (typeof existingContent.title === "string" && existingContent.title !== freshContent.title) {
    merged.title = existingContent.title;
  }
  if (typeof existingContent.body === "string" && existingContent.body !== freshContent.body) {
    merged.body = existingContent.body;
  }

  if (refreshKey === "kpi-overview" || refreshKey === "kpi-interactions" || refreshKey === "kpi-content-type") {
    merged.kpis = mergeKpis(existingContent.kpis, freshContent.kpis);
  } else if (refreshKey === "chart-followers") {
    merged.chart = freshContent.chart;
    merged.chartUnavailable = freshContent.chartUnavailable;
    merged.unavailableReason = freshContent.unavailableReason;
  } else if (refreshKey?.startsWith("media-")) {
    merged.mediaItems = mergeMediaItems(existingContent.mediaItems, freshContent.mediaItems);
  }

  return { type: fresh.type, title: merged.title as string, content: merged };
}

/** Refresh all data-driven blocks in a report from the database, preserving manual content.
 *  Does not make new Meta API calls when skipMetaApi is true (default). */
export async function refreshReportData(reportId: string, options: RefreshOptions = {}) {
  const { skipMetaApi } = { ...DEFAULT_OPTIONS, ...options };

  const report = await db.report.findUnique({
    where: { id: reportId },
    include: { blocks: { orderBy: { position: "asc" } } },
  });
  if (!report) throw new Error("Report not found.");
  if (report.status === "APPROVED") throw new Error("Approved reports are frozen.");

  const builder = skipMetaApi ? buildStandardReportBlocksFromStoredPeriodSnapshots : undefined;
  if (!builder) {
    throw new Error("Only skipMetaApi=true is currently supported.");
  }

  const freshBlocks = await builder(report.clientId, report.periodStart, report.periodEnd);
  const freshByKey = new Map(
    freshBlocks
      .map((block) => ({ block, key: getRefreshKey(block.content) }))
      .filter((entry): entry is { block: ReportBlock; key: NonNullable<typeof entry.key> } => Boolean(entry.key))
      .map((entry) => [entry.key, entry.block]),
  );

  const mergedBlocks: ReportBlock[] = [];
  const usedKeys = new Set<ReportRefreshKey>();

  for (const dbBlock of report.blocks) {
    const existing: ReportBlock = {
      type: dbBlock.type,
      title: (dbBlock.content as Record<string, unknown>).title as string,
      content: dbBlock.content as Record<string, unknown>,
    };
    const key = getRefreshKey(existing.content);
    if (key && isDataDrivenRefreshKey(key) && freshByKey.has(key)) {
      mergedBlocks.push(mergeBlockContent(existing, freshByKey.get(key)!));
      usedKeys.add(key);
    } else {
      mergedBlocks.push(existing);
      if (key) usedKeys.add(key);
    }
  }

  // Append any data-driven blocks that are missing from the saved report (e.g., blank template or legacy reports).
  for (const [key, block] of freshByKey.entries()) {
    if (isDataDrivenRefreshKey(key) && !usedKeys.has(key)) {
      mergedBlocks.push(block);
    }
  }

  const coverage = await computeCoverageSummary(report.clientId, report.periodStart, report.periodEnd);

  await db.report.update({
    where: { id: reportId },
    data: {
      dataRefreshedAt: new Date(),
      coverageStatus: coverage.status,
      coverageWarnings: coverage.warnings as Prisma.InputJsonValue,
      blocks: {
        deleteMany: {},
        create: mergedBlocks.map((block, position) => ({
          position,
          type: block.type as BlockType,
          content: block.content as Prisma.InputJsonValue,
        })),
      },
    },
  });

  return {
    reportId,
    dataRefreshedAt: new Date(),
    coverageStatus: coverage.status,
    coverageWarnings: coverage.warnings,
  };
}
