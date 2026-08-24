import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireFeature } from "@/lib/access";
import { refreshReportData } from "@/lib/report-refresh";
import { prioritizeReportPeriod } from "@/lib/sync-queue";

export async function POST(request: NextRequest, { params }: { params: Promise<{ reportId: string }> }) {
  const user = await requireFeature(request, "edit_report");
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { reportId } = await params;
  const report = await db.report.findUnique({ where: { id: reportId }, select: { id: true, status: true, clientId: true, periodStart: true, periodEnd: true } });
  if (!report) return NextResponse.json({ error: "Report not found." }, { status: 404 });
  if (report.status === "APPROVED") return NextResponse.json({ error: "Approved reports are frozen." }, { status: 409 });

  try {
    // Prioritize any missing final data for the selected report period at P0 without triggering a full
    // historical resync. This is a fire-and-forget enqueue; the worker will pick it up.
    await prioritizeReportPeriod(report.clientId, report.periodStart, report.periodEnd);

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
