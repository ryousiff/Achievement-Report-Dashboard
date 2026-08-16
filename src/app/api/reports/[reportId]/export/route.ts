import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireFeature } from "@/lib/access";
import { refreshReportData } from "@/lib/report-refresh";

export async function POST(request: NextRequest, { params }: { params: Promise<{ reportId: string }> }) {
  const user = await requireFeature(request, "export_report");
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { reportId } = await params;
  const { orientation } = await request.json() as { orientation?: unknown };
  const report = await db.report.findUnique({ where: { id: reportId }, select: { id: true, status: true, clientId: true } });
  if (!report) return NextResponse.json({ error: "Report not found." }, { status: 404 });

  // Always refresh data from the database before exporting so the PDF uses the latest synced data
  // without issuing new Meta API calls.
  try {
    await refreshReportData(reportId);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Data refresh failed before export.";
    return NextResponse.json({ error: message }, { status: 409 });
  }

  const value = orientation === "portrait" ? "portrait" : "landscape";
  const exportRecord = await db.reportExport.create({ data: { reportId, orientation: value } });
  await db.report.update({ where: { id: reportId }, data: { orientation: value, status: report.status === "APPROVED" ? "EXPORTED" : undefined } });
  return NextResponse.json({ export: exportRecord });
}
