import { NextRequest, NextResponse } from "next/server";
import { Platform } from "@prisma/client";
import { db } from "@/lib/db";
import { requireFeature } from "@/lib/access";
import { getCoverage } from "@/lib/report-coverage";

export async function GET(request: NextRequest, { params }: { params: Promise<{ clientId: string }> }) {
  const user = await requireFeature(request, "view_reports");
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { clientId } = await params;
  const periodStartParam = request.nextUrl.searchParams.get("periodStart");
  const periodEndParam = request.nextUrl.searchParams.get("periodEnd");
  if (!periodStartParam || !periodEndParam) return NextResponse.json({ error: "periodStart and periodEnd are required." }, { status: 400 });
  const periodStart = new Date(`${periodStartParam}T00:00:00.000Z`);
  const periodEnd = new Date(`${periodEndParam}T23:59:59.999Z`);
  if (Number.isNaN(periodStart.valueOf()) || Number.isNaN(periodEnd.valueOf())) return NextResponse.json({ error: "Invalid period dates." }, { status: 400 });
  const connection = await db.socialConnection.findFirst({ where: { clientId, platform: Platform.INSTAGRAM }, select: { id: true } });
  if (!connection) return NextResponse.json({ coverage: { status: "UNAVAILABLE", warnings: ["لا يوجد ربط بإنستغرام لهذا العميل."], missingRanges: [], mediaCoverage: { from: null, to: null, complete: false }, postInsightCoverage: { availableMetrics: [], missingMetrics: [] }, reachCoverage: { from: null, to: null, complete: false }, followsCoverage: { from: null, to: null, complete: false }, storyCoverage: { status: "NOT_COLLECTED" }, historicalBackfillStatus: "NOT_STARTED" } }, { status: 200 });
  const coverage = await getCoverage(connection.id, periodStart, periodEnd);
  return NextResponse.json({ coverage });
}
