import { BlockType, Prisma } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { hasInternalApiAccess } from "@/lib/internal-api";
import { createReportDraft, ReportBlockType } from "@/lib/report-template";
import { getSessionUser } from "@/lib/session";
import { dateValue, requiredText } from "@/lib/validators";

function toDatabaseBlockType(type: ReportBlockType): BlockType {
  const map: Record<ReportBlockType, BlockType> = {
    text: BlockType.TEXT,
    kpi: BlockType.KPI,
    chart: BlockType.CHART,
    platformAnalytics: BlockType.PLATFORM_ANALYTICS,
    media: BlockType.MEDIA,
    notes: BlockType.NOTES,
    recommendations: BlockType.RECOMMENDATIONS,
  };
  return map[type];
}

async function workspaceUser(request: NextRequest) {
  return getSessionUser(request);
}

export async function GET(request: NextRequest) {
  if (!hasInternalApiAccess(request) && !(await workspaceUser(request))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const clientId = request.nextUrl.searchParams.get("clientId");
  const reports = await db.report.findMany({ where: clientId ? { clientId } : undefined, include: { client: { select: { name: true } }, blocks: { orderBy: { position: "asc" } } }, orderBy: { updatedAt: "desc" }, take: 100 });
  return NextResponse.json({ reports });
}

export async function POST(request: NextRequest) {
  const actor = await workspaceUser(request);
  const internalAccess = hasInternalApiAccess(request);
  if (!internalAccess && !actor) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const body = await request.json() as Record<string, unknown>;
    const clientId = requiredText(body.clientId, "clientId", 64);
    const createdById = actor?.id ?? requiredText(body.createdById, "createdById", 64);
    const template = body.template === "blank" ? "blank" : "standard";
    const draft = createReportDraft(template);
    const report = await db.report.create({
      data: {
        clientId,
        createdById,
        title: requiredText(body.title, "title"),
        periodStart: dateValue(body.periodStart, "periodStart"),
        periodEnd: dateValue(body.periodEnd, "periodEnd"),
        status: draft.status,
        isBlank: draft.isBlank,
        blocks: { create: draft.blocks.map((block, position) => ({ position, type: toDatabaseBlockType(block.type), content: block.content as Prisma.InputJsonValue })) },
      },
      include: { blocks: { orderBy: { position: "asc" } } },
    });
    return NextResponse.json({ report }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid request." }, { status: 400 });
  }
}
