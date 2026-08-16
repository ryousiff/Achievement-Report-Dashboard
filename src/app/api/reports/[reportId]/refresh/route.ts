import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireFeature } from "@/lib/access";
import { refreshReportData } from "@/lib/report-refresh";

export async function POST(request: NextRequest, { params }: { params: Promise<{ reportId: string }> }) {
  const user = await requireFeature(request, "edit_report");
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { reportId } = await params;
  const report = await db.report.findUnique({ where: { id: reportId }, select: { id: true, status: true, clientId: true } });
  if (!report) return NextResponse.json({ error: "Report not found." }, { status: 404 });
  if (report.status === "APPROVED") return NextResponse.json({ error: "Approved reports are frozen." }, { status: 409 });

  try {
    const result = await refreshReportData(reportId);
    const refreshed = await db.report.findUnique({
      where: { id: reportId },
      include: { blocks: { orderBy: { position: "asc" } } },
    });
    return NextResponse.json({ refresh: result, report: refreshed });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to refresh report data.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
