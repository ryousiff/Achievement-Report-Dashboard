import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/session";

export async function POST(request: NextRequest, { params }: { params: Promise<{ reportId: string }> }) {
  if (!(await getSessionUser(request))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { reportId } = await params;
  const { orientation } = await request.json() as { orientation?: unknown };
  const report = await db.report.findUnique({ where: { id: reportId }, select: { id: true, status: true } });
  if (!report) return NextResponse.json({ error: "Report not found." }, { status: 404 });
  const value = orientation === "portrait" ? "portrait" : "landscape";
  const exportRecord = await db.reportExport.create({ data: { reportId, orientation: value } });
  await db.report.update({ where: { id: reportId }, data: { orientation: value, status: report.status === "APPROVED" ? "EXPORTED" : undefined } });
  return NextResponse.json({ export: exportRecord });
}
