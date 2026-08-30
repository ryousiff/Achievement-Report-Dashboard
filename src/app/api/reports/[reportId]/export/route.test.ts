import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "./route";

const mockDb = vi.hoisted(() => ({
  report: {
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  reportExport: {
    create: vi.fn(),
  },
}));

const mockAccess = vi.hoisted(() => ({
  requireFeature: vi.fn(async () => ({ id: "user-1", role: "ADMIN" })),
}));

const mockRefreshReportData = vi.hoisted(() => vi.fn());

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/access", () => mockAccess);
vi.mock("@/lib/report-refresh", () => ({ refreshReportData: mockRefreshReportData }));

function makePostRequest(reportId: string, body: unknown) {
  return new NextRequest(`http://localhost/api/reports/${reportId}/export`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRefreshReportData.mockResolvedValue({
    reportId: "report-1",
    dataRefreshedAt: new Date(),
    coverageStatus: "COMPLETE",
    coverageWarnings: [],
  });
  mockDb.report.findUnique.mockResolvedValue({
    id: "report-1",
    status: "DRAFT",
    clientId: "client-1",
  });
  mockDb.reportExport.create.mockResolvedValue({ id: "export-1" });
  mockDb.report.update.mockResolvedValue({});
});

describe("POST /api/reports/:reportId/export", () => {
  it("refreshes data and creates an export record", async () => {
    const response = await POST(makePostRequest("report-1", { orientation: "landscape" }), { params: Promise.resolve({ reportId: "report-1" }) });
    const data = (await response.json()) as { export?: { id: string }; error?: string };

    expect(response.status).toBe(200);
    expect(data.error).toBeFalsy();
    expect(data.export?.id).toBe("export-1");
    expect(mockRefreshReportData).toHaveBeenCalledWith("report-1");
    expect(mockDb.report.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "report-1" },
      data: expect.objectContaining({ orientation: "landscape" }),
    }));
  });

  it("defaults to landscape orientation", async () => {
    const response = await POST(makePostRequest("report-1", {}), { params: Promise.resolve({ reportId: "report-1" }) });
    expect(response.status).toBe(200);
    expect(mockDb.report.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ orientation: "landscape" }),
    }));
  });
});
