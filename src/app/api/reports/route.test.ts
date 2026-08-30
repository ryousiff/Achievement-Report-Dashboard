import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { BlockType } from "@prisma/client";
import { GET, POST, PATCH } from "./route";

const mockDb = vi.hoisted(() => ({
  report: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    count: vi.fn(),
  },
  reportVersion: {
    create: vi.fn(),
    count: vi.fn(),
  },
  reportExport: {
    create: vi.fn(),
  },
  socialPost: {
    findMany: vi.fn(),
    count: vi.fn(),
  },
  socialConnection: {
    findFirst: vi.fn(),
  },
  socialInsightSnapshot: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    count: vi.fn(),
  },
  session: {
    findUnique: vi.fn(),
  },
  $transaction: vi.fn(async (calls: unknown[]) => {
    if (Array.isArray(calls)) return Promise.all(calls);
    return calls;
  }),
}));

const mockAccess = vi.hoisted(() => ({
  requireFeature: vi.fn(async () => ({ id: "user-1", role: "ADMIN" })),
  hasFeature: vi.fn(() => true),
}));

const mockInternalApi = vi.hoisted(() => ({
  hasInternalApiAccess: vi.fn(() => false),
}));

const mockRefreshReportData = vi.hoisted(() => vi.fn());
const mockBuildStandardBlocks = vi.hoisted(() => vi.fn());
const mockGetCoverage = vi.hoisted(() => vi.fn());
const mockEnqueueClientSync = vi.hoisted(() => vi.fn());

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/access", () => mockAccess);
vi.mock("@/lib/internal-api", () => mockInternalApi);
vi.mock("@/lib/report-refresh", () => ({ refreshReportData: mockRefreshReportData }));
vi.mock("@/lib/stored-period-metrics", () => ({ buildStandardReportBlocksPreferStoredPeriodSnapshots: mockBuildStandardBlocks }));
vi.mock("@/lib/report-coverage", () => ({ getCoverage: mockGetCoverage }));
vi.mock("@/lib/sync-queue", () => ({ enqueueClientSync: mockEnqueueClientSync }));

function makePostRequest(body: unknown) {
  return new NextRequest("http://localhost/api/reports", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

function makePatchRequest(body: unknown) {
  return new NextRequest("http://localhost/api/reports", {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

const dummyMediaItem = { id: "post-1", externalPostId: "ig-1", caption: "Post", mediaType: "IMAGE", mediaUrl: null, thumbnailUrl: null, permalink: null, publishedAt: "2026-07-15T00:00:00.000Z", metrics: { views: 100, total_interactions: 50 }, metricsSource: "SNAPSHOT" };

function standardBlocks(): Array<{ type: BlockType; title: string; content: Record<string, unknown> }> {
  return [
    { type: BlockType.TEXT, title: "غلاف التقرير", content: { body: "تقرير الإنجاز الشهري", page: "cover", refreshKey: "cover" } },
    { type: BlockType.KPI, title: "أهم الإحصائيات", content: { body: "إحصائيات الفترة المحددة من بيانات Meta المتاحة.", refreshKey: "kpi-overview", kpis: [] } },
    { type: BlockType.KPI, title: "التفاعل مع المحتوى", content: { body: "إجماليات التفاعل للمنشورات خلال الفترة.", refreshKey: "kpi-interactions", kpis: [] } },
    { type: BlockType.CHART, title: "معدل اكتساب المتابعين اليومي", content: { body: "بيانات المتابعين الجدد (follows_and_unfollows) اليومية من Meta.", refreshKey: "chart-followers" } },
    { type: BlockType.MEDIA, title: "أعلى المنشورات من حيث اكتساب المتابعين", content: { body: "تم اختيار المنشورات الأعلى من بيانات الفترة.", refreshKey: "media-top-follows", mediaItems: [dummyMediaItem] } },
    { type: BlockType.MEDIA, title: "أعلى المنشورات من حيث التفاعل", content: { body: "تم اختيار المنشورات الأعلى تفاعلاً من بيانات الفترة.", refreshKey: "media-top-interactions", mediaItems: [dummyMediaItem] } },
    { type: BlockType.MEDIA, title: "أعلى المنشورات من حيث المشاهدات العضوية", content: { body: "تم اختيار المنشورات الأعلى مشاهدة عضوياً من بيانات الفترة.", refreshKey: "media-top-views", mediaItems: [dummyMediaItem] } },
    { type: BlockType.MEDIA, title: "محتوى الشهر", content: { body: "أضيفي نماذج إضافية من المحتوى أو احتفظي بالمنشورات المختارة تلقائياً.", refreshKey: "media-month-content", mediaItems: [dummyMediaItem] } },
    { type: BlockType.NOTES, title: "التوصيات", content: { body: "أضيفي توصيات عملية قابلة للتنفيذ للشهر القادم.", refreshKey: "notes-recommendations" } },
    { type: BlockType.TEXT, title: "شكراً على ثقتكم", content: { body: "Kaan Creative", page: "closing", refreshKey: "closing" } },
  ];
}

function createdReport(blocks: Array<{ type: BlockType; title: string; content: Record<string, unknown> }>) {
  return {
    id: "report-1",
    clientId: "client-1",
    createdById: "user-1",
    title: "تقرير شهر يوليو — مستشفى الدكتورة هيفاء",
    periodStart: new Date("2026-07-01T00:00:00.000Z"),
    periodEnd: new Date("2026-07-31T23:59:59.999Z"),
    status: "DRAFT",
    isBlank: false,
    orientation: "landscape",
    blocks: blocks.map((block, position) => ({ ...block, position, id: `block-${position}` })),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRefreshReportData.mockResolvedValue({
    reportId: "report-1",
    dataRefreshedAt: new Date(),
    coverageStatus: "COMPLETE",
    coverageWarnings: [],
  });
  mockBuildStandardBlocks.mockResolvedValue(standardBlocks());
  mockGetCoverage.mockResolvedValue({ status: "COMPLETE", warnings: [] });
  mockEnqueueClientSync.mockResolvedValue([]);
  mockDb.socialPost.count.mockResolvedValue(5);
  mockDb.socialConnection.findFirst.mockResolvedValue({ id: "conn-1", clientId: "client-1", lastSuccessfulSyncAt: new Date() });
});

describe("POST /api/reports", () => {
  it("creates a standard report with exactly one copy of every standard block", async () => {
    const initial = createdReport(standardBlocks());
    mockDb.report.create.mockResolvedValue(initial);
    mockDb.report.findUnique.mockResolvedValue(initial);

    const response = await POST(makePostRequest({
      clientId: "client-1",
      template: "standard",
      title: "تقرير شهر يوليو — مستشفى الدكتورة هيفاء",
      periodStart: "2026-07-01T00:00:00.000Z",
      periodEnd: "2026-07-31T23:59:59.999Z",
    }));
    const data = (await response.json()) as { report?: { blocks?: Array<{ position: number; type: string; title: string; content: { title?: string; refreshKey?: string } }> }; error?: string };

    expect(response.status).toBe(201);
    expect(data.report?.blocks).toHaveLength(10);

    const titles = data.report!.blocks!.map((block) => block.title);
    const expectedTitles = [
      "غلاف التقرير",
      "أهم الإحصائيات",
      "التفاعل مع المحتوى",
      "معدل اكتساب المتابعين اليومي",
      "أعلى المنشورات من حيث اكتساب المتابعين",
      "أعلى المنشورات من حيث التفاعل",
      "أعلى المنشورات من حيث المشاهدات العضوية",
      "محتوى الشهر",
      "التوصيات",
      "شكراً على ثقتكم",
    ];
    expect(titles).toEqual(expectedTitles);

    const uniqueRefreshKeys = new Set(data.report!.blocks!.map((block) => block.content.refreshKey));
    expect(uniqueRefreshKeys.size).toBe(10);

    // Recommendations should come right before the closing page.
    expect(data.report!.blocks![8].title).toBe("التوصيات");
    expect(data.report!.blocks![9].title).toBe("شكراً على ثقتكم");
  });

  it("does not add duplicate blocks when the builder is invoked during creation and refresh", async () => {
    const initial = createdReport(standardBlocks());
    mockDb.report.create.mockResolvedValue(initial);
    mockDb.report.findUnique.mockResolvedValue(initial);

    await POST(makePostRequest({
      clientId: "client-1",
      template: "standard",
      title: "تقرير شهر يوليو — مستشفى الدكتورة هيفاء",
      periodStart: "2026-07-01T00:00:00.000Z",
      periodEnd: "2026-07-31T23:59:59.999Z",
    }));

    const createData = mockDb.report.create.mock.calls[0][0].data as { blocks: { create: Array<{ position: number; type: BlockType; content: Record<string, unknown> }> } };
    const createdBlocks = createData.blocks.create;
    expect(createdBlocks).toHaveLength(10);

    const refreshKeys = createdBlocks.map((block) => block.content.refreshKey);
    expect(new Set(refreshKeys).size).toBe(10);
  });
});

describe("PATCH /api/reports", () => {
  it("creating a ReportVersion does not duplicate generated sections", async () => {
    const existingBlocks = standardBlocks();
    mockDb.report.findUnique
      .mockResolvedValueOnce({ id: "report-1", status: "DRAFT" })
      .mockResolvedValueOnce(createdReport(existingBlocks));
    mockDb.report.update.mockResolvedValue(createdReport(existingBlocks));
    mockDb.reportVersion.count.mockResolvedValue(0);

    const response = await PATCH(makePatchRequest({
      id: "report-1",
      title: "تقرير شهر يوليو — مستشفى الدكتورة هيفاء",
      status: "APPROVED",
      blocks: existingBlocks.map((block) => ({ type: block.type.toLowerCase(), title: block.title, content: block.content })),
    }));
    const data = (await response.json()) as { report?: unknown; error?: string; readiness?: { issues?: string[] } };

    expect(response.status).toBe(200);
    expect(data.error).toBeFalsy();

    const versionData = mockDb.reportVersion.create.mock.calls[0][0].data as { snapshot: { blocks: Array<{ title: string; refreshKey?: string }> } };
    expect(versionData.snapshot.blocks).toHaveLength(10);

    const titles = versionData.snapshot.blocks.map((block) => block.title);
    expect(new Set(titles).size).toBe(10);

    expect(versionData.snapshot.blocks[8].title).toBe("التوصيات");
    expect(versionData.snapshot.blocks[9].title).toBe("شكراً على ثقتكم");
  });

  it("keeps a manually-added TEXT section exactly once when approving", async () => {
    const customText = { type: BlockType.TEXT, title: "ملاحظات خاصة", content: { body: "نص مخصص", refreshKey: "notes-recommendations" } };
    const blocksWithCustomText = [
      ...standardBlocks().slice(0, 9),
      customText,
      standardBlocks()[9],
    ];
    mockDb.report.findUnique
      .mockResolvedValueOnce({ id: "report-1", status: "DRAFT" })
      .mockResolvedValueOnce(createdReport(blocksWithCustomText));
    mockDb.report.update.mockResolvedValue(createdReport(blocksWithCustomText));
    mockDb.reportVersion.count.mockResolvedValue(0);

    const response = await PATCH(makePatchRequest({
      id: "report-1",
      title: "تقرير شهر يوليو — مستشفى الدكتورة هيفاء",
      status: "APPROVED",
      blocks: blocksWithCustomText.map((block) => ({ type: block.type.toLowerCase(), title: block.title, content: block.content })),
    }));

    expect(response.status).toBe(200);

    const versionData = mockDb.reportVersion.create.mock.calls[0][0].data as { snapshot: { blocks: Array<{ title: string }> } };
    const textBlocks = versionData.snapshot.blocks.filter((block) => block.title === "ملاحظات خاصة");
    expect(textBlocks).toHaveLength(1);
    expect(versionData.snapshot.blocks[versionData.snapshot.blocks.length - 1].title).toBe("شكراً على ثقتكم");
  });
});
