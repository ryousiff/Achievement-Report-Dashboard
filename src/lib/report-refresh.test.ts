import { beforeEach, describe, expect, it, vi } from "vitest";
import { BlockType, InsightPeriodType, MediaSource } from "@prisma/client";
import { refreshReportData } from "@/lib/report-refresh";

const mockDb = vi.hoisted(() => ({
  report: {
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  socialPost: { findMany: vi.fn(), count: vi.fn() },
  socialInsightSnapshot: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    count: vi.fn(),
    upsert: vi.fn(),
  },
  socialConnection: { findFirst: vi.fn() },
  syncJob: { findMany: vi.fn() },
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));

function createReport(blocks: Array<{ type: BlockType; position: number; content: Record<string, unknown> }>) {
  return {
    id: "report-1",
    clientId: "client-1",
    periodStart: new Date("2026-08-01T00:00:00.000Z"),
    periodEnd: new Date("2026-08-03T23:59:59.999Z"),
    status: "DRAFT",
    blocks,
  };
}

function defaultConnection() {
  return { id: "conn-1", clientId: "client-1", externalAccountId: "acc-1", encryptedToken: "enc-token", lastSuccessfulSyncAt: new Date("2026-08-04T00:00:00.000Z") };
}

function defaultPost() {
  return {
    id: "p1",
    externalPostId: "ig-1",
    caption: "Post",
    mediaType: "IMAGE",
    mediaUrl: null,
    thumbnailUrl: null,
    permalink: null,
    publishedAt: new Date("2026-08-02T00:00:00.000Z"),
    metrics: { views: 100, total_views: 120, total_interactions: 50, likes: 30, comments: 10, saved: 5, shares: 2, follows: 1 },
    metricAvailability: { views: "returned", total_interactions: "returned", follows: "returned" },
    metricAvailabilityState: { views: "AVAILABLE", total_interactions: "AVAILABLE", follows: "AVAILABLE" },
    mediaSource: MediaSource.OWNED,
    score: 0,
  };
}

beforeEach(() => {
  mockDb.report.findUnique.mockReset();
  mockDb.report.update.mockReset();
  mockDb.socialPost.findMany.mockReset();
  mockDb.socialPost.count.mockReset();
  mockDb.socialInsightSnapshot.findFirst.mockReset();
  mockDb.socialInsightSnapshot.findMany.mockReset();
  mockDb.socialInsightSnapshot.count.mockReset();
  mockDb.socialInsightSnapshot.upsert.mockReset();
  mockDb.socialConnection.findFirst.mockReset();
  mockDb.syncJob.findMany.mockReset();
});

describe("refreshReportData", () => {
  it("refreshes authoritative period KPIs from TOTAL_VALUE snapshots and preserves manual blocks", async () => {
    const manualBody = "توصيات مخصصة";
    const report = createReport([
      { type: BlockType.TEXT, position: 0, content: { body: "غلاف مخصص", page: "cover", refreshKey: "cover" } },
      {
        type: BlockType.KPI,
        position: 1,
        content: {
          body: "نظرة عامة",
          refreshKey: "kpi-overview",
          kpis: [
            { id: "reach", label: "وصول", value: "0", available: true },
            { id: "follows", label: "المتابعون الجدد", value: "512", available: true },
            { id: "total-views", label: "إجمالي المشاهدات", value: "818,485", available: true },
          ],
        },
      },
      { type: BlockType.KPI, position: 2, content: { body: "تفاعلات", refreshKey: "kpi-interactions", kpis: [{ id: "total_interactions", label: "تفاعل", value: "0", available: true }] } },
      { type: BlockType.NOTES, position: 3, content: { body: manualBody, refreshKey: "notes-recommendations" } },
      { type: BlockType.TEXT, position: 4, content: { body: "Kaan Creative", page: "closing", refreshKey: "closing" } },
    ]);

    mockDb.report.findUnique.mockResolvedValue(report);
    mockDb.socialConnection.findFirst.mockResolvedValue(defaultConnection());
    mockDb.syncJob.findMany.mockResolvedValue([]);
    mockDb.socialPost.findMany.mockResolvedValue([defaultPost()]);
    mockDb.socialPost.count.mockResolvedValue(1);
    mockDb.socialInsightSnapshot.findMany.mockImplementation(({ where }: { where: { metric?: string; periodType?: InsightPeriodType } }) => {
      if (where.periodType === InsightPeriodType.TOTAL_VALUE) {
        if (where.metric === "reach") return [{ value: 300 }];
        if (where.metric === "views") return [{ value: 900000 }];
        if (where.metric === "followers_gained") return [{ value: 520 }];
        if (where.metric === "followers_lost") return [{ value: 370 }];
      }
      if (where.metric === "reach" && where.periodType === InsightPeriodType.DAY) return [{ value: 100 }];
      return [];
    });
    mockDb.socialInsightSnapshot.findFirst.mockImplementation(({ where }: { where: { metric?: string } }) => {
      if (where.metric === "followers_gained") return { value: 10 };
      if (where.metric === "followers_lost") return { value: 1 };
      return null;
    });
    mockDb.socialInsightSnapshot.count.mockResolvedValue(1);
    mockDb.report.update.mockResolvedValue({});

    const result = await refreshReportData("report-1");

    expect(result.coverageStatus).toBe("COMPLETE");
    expect(mockDb.report.update).toHaveBeenCalled();
    const updateData = mockDb.report.update.mock.calls[0][0].data as { blocks: { create: Array<{ position: number; type: BlockType; content: Record<string, unknown> }> } };
    const createdBlocks = updateData.blocks.create;

    expect(createdBlocks[0].content.body).toBe("غلاف مخصص");
    expect(createdBlocks[3].content.body).toBe(manualBody);
    expect(createdBlocks[4].content.body).toBe("Kaan Creative");

    const overviewKpis = createdBlocks[1].content.kpis as Array<{ id: string; value: string }>;
    expect(overviewKpis.find((k) => k.id === "reach")?.value).toBe("300");
    expect(overviewKpis.find((k) => k.id === "follows")?.value).toBe("520");
    expect(overviewKpis.find((k) => k.id === "followers-lost")?.value).toBe("370");
    expect(overviewKpis.find((k) => k.id === "net-follower-growth")?.value).toBe("+150");
    expect(overviewKpis.find((k) => k.id === "total-views")?.value).toBe("900,000");

    const interactionsKpis = createdBlocks[2].content.kpis as Array<{ id: string; value: string }>;
    expect(interactionsKpis.find((k) => k.id === "total_interactions")?.value).toBe("50");
  });

  it("preserves existing authoritative KPIs when a stored period snapshot is unavailable", async () => {
    const report = createReport([
      {
        type: BlockType.KPI,
        position: 0,
        content: {
          body: "نظرة عامة",
          refreshKey: "kpi-overview",
          kpis: [
            { id: "reach", label: "وصول", value: "312,688", available: true },
            { id: "follows", label: "المتابعون الجدد", value: "512", available: true },
            { id: "total-views", label: "إجمالي المشاهدات", value: "818,485", available: true },
          ],
        },
      },
    ]);
    mockDb.report.findUnique.mockResolvedValue(report);
    mockDb.socialConnection.findFirst.mockResolvedValue(defaultConnection());
    mockDb.syncJob.findMany.mockResolvedValue([]);
    mockDb.socialPost.findMany.mockResolvedValue([defaultPost()]);
    mockDb.socialPost.count.mockResolvedValue(1);
    mockDb.socialInsightSnapshot.findMany.mockResolvedValue([]);
    mockDb.socialInsightSnapshot.findFirst.mockResolvedValue(null);
    mockDb.socialInsightSnapshot.count.mockResolvedValue(1);
    mockDb.report.update.mockResolvedValue({});

    await refreshReportData("report-1");

    const updateData = mockDb.report.update.mock.calls[0][0].data as { blocks: { create: Array<{ content: Record<string, unknown> }> } };
    const overviewKpis = updateData.blocks.create[0].content.kpis as Array<{ id: string; value: string }>;
    expect(overviewKpis.find((k) => k.id === "reach")?.value).toBe("312,688");
    expect(overviewKpis.find((k) => k.id === "follows")?.value).toBe("512");
    expect(overviewKpis.find((k) => k.id === "total-views")?.value).toBe("818,485");
  });

  it("marks coverage as SYNCING when a sync job is active", async () => {
    const report = createReport([
      { type: BlockType.KPI, position: 0, content: { body: "نظرة عامة", refreshKey: "kpi-overview", kpis: [] } },
    ]);

    mockDb.report.findUnique.mockResolvedValue(report);
    mockDb.socialConnection.findFirst.mockResolvedValue(defaultConnection());
    mockDb.syncJob.findMany.mockResolvedValue([{ id: "job-1", type: "DAILY_ACCOUNT_INSIGHT_SYNC" }]);
    mockDb.socialPost.findMany.mockResolvedValue([]);
    mockDb.socialPost.count.mockResolvedValue(0);
    mockDb.socialInsightSnapshot.findMany.mockResolvedValue([]);
    mockDb.socialInsightSnapshot.count.mockResolvedValue(0);
    mockDb.report.update.mockResolvedValue({});

    const result = await refreshReportData("report-1");

    expect(result.coverageStatus).toBe("SYNCING");
    expect(result.coverageWarnings).toContain("جارٍ تحميل البيانات. أعدي فتح التقرير أو تحديث البيانات لاحقاً.");
  });

  it("does not call Meta Graph API and uses stored snapshots only", async () => {
    const report = createReport([
      { type: BlockType.KPI, position: 0, content: { body: "نظرة عامة", refreshKey: "kpi-overview", kpis: [] } },
    ]);

    mockDb.report.findUnique.mockResolvedValue(report);
    mockDb.socialConnection.findFirst.mockResolvedValue(defaultConnection());
    mockDb.syncJob.findMany.mockResolvedValue([]);
    mockDb.socialPost.findMany.mockResolvedValue([defaultPost()]);
    mockDb.socialPost.count.mockResolvedValue(1);
    mockDb.socialInsightSnapshot.findMany.mockResolvedValue([]);
    mockDb.socialInsightSnapshot.findFirst.mockResolvedValue(null);
    mockDb.socialInsightSnapshot.count.mockResolvedValue(1);
    mockDb.report.update.mockResolvedValue({});

    await refreshReportData("report-1");

    expect(mockDb.report.update).toHaveBeenCalled();
  });

  it("drops a saved data-driven block whose refreshKey the builder no longer produces", async () => {
    const report = createReport([
      { type: BlockType.KPI, position: 0, content: { body: "نظرة عامة", refreshKey: "kpi-overview", kpis: [] } },
      { type: BlockType.KPI, position: 1, content: { body: "إجمالي التفاعل حسب نوع المنشور.", refreshKey: "kpi-content-type", kpis: [{ id: "format-IMAGE", label: "المنشورات", value: "17" }] } },
      { type: BlockType.NOTES, position: 2, content: { body: "توصيات مخصصة", refreshKey: "notes-recommendations" } },
    ]);

    mockDb.report.findUnique.mockResolvedValue(report);
    mockDb.socialConnection.findFirst.mockResolvedValue(defaultConnection());
    mockDb.syncJob.findMany.mockResolvedValue([]);
    mockDb.socialPost.findMany.mockResolvedValue([defaultPost()]);
    mockDb.socialPost.count.mockResolvedValue(1);
    mockDb.socialInsightSnapshot.findMany.mockResolvedValue([]);
    mockDb.socialInsightSnapshot.findFirst.mockResolvedValue(null);
    mockDb.socialInsightSnapshot.count.mockResolvedValue(1);
    mockDb.report.update.mockResolvedValue({});

    await refreshReportData("report-1");

    const updateData = mockDb.report.update.mock.calls[0][0].data as { blocks: { create: Array<{ content: Record<string, unknown> }> } };
    const refreshKeys = updateData.blocks.create.map((block) => block.content.refreshKey);
    expect(refreshKeys).not.toContain("kpi-content-type");
    expect(refreshKeys).toContain("kpi-overview");
    expect(refreshKeys).toContain("notes-recommendations");
  });

  it("throws when the report is approved", async () => {
    mockDb.report.findUnique.mockResolvedValue({ ...createReport([]), status: "APPROVED" });
    await expect(refreshReportData("report-1")).rejects.toThrow("Approved reports are frozen");
  });
});
