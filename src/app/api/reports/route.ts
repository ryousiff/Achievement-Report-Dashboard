import { BlockType, Prisma } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { hasInternalApiAccess } from "@/lib/internal-api";
import { createReportDraft, ReportBlockType } from "@/lib/report-template";
import { buildStandardReportBlocks } from "@/lib/report-data";
import { syncClientInstagramPosts } from "@/lib/meta-sync";
import { getSessionUser } from "@/lib/session";
import { dateValue, requiredText } from "@/lib/validators";

const reportBlockTypes = ["text", "kpi", "chart", "platformAnalytics", "media", "notes", "recommendations"] as const;
type EditableBlockType = (typeof reportBlockTypes)[number];
type EditableBlock = { type: EditableBlockType; title: string; content: Record<string, unknown> };

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

function editableBlocks(value: unknown): EditableBlock[] {
  if (!Array.isArray(value) || value.length > 60) throw new Error("blocks must contain 60 items or fewer.");
  return value.map((block) => {
    if (!block || typeof block !== "object" || Array.isArray(block)) throw new Error("Each block must be an object.");
    const { type, title, content } = block as Record<string, unknown>;
    if (typeof type !== "string" || !reportBlockTypes.includes(type as EditableBlockType)) throw new Error("Each block type is invalid.");
    if (!content || typeof content !== "object" || Array.isArray(content)) throw new Error("Each block content must be an object.");
    return { type: type as EditableBlockType, title: requiredText(title, "block title"), content: content as Record<string, unknown> };
  });
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
    const periodStart = dateValue(body.periodStart, "periodStart");
    const periodEnd = dateValue(body.periodEnd, "periodEnd");
    const duplicateFromId = typeof body.duplicateFromId === "string" ? body.duplicateFromId : null;
    if (duplicateFromId) {
      const source = await db.report.findUnique({ where: { id: duplicateFromId }, include: { blocks: { orderBy: { position: "asc" } } } });
      if (!source) return NextResponse.json({ error: "Source report not found." }, { status: 404 });
      if (!internalAccess && source.createdById !== actor?.id) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      const report = await db.report.create({ data: { clientId, createdById, title: requiredText(body.title, "title"), periodStart, periodEnd, status: "DRAFT", isBlank: source.isBlank, blocks: { create: source.blocks.map((block, position) => { const content = block.content as Record<string, unknown>; const kpis = Array.isArray(content.kpis) ? content.kpis.map((item) => typeof item === "object" && item ? { ...(item as Record<string, unknown>), value: "0" } : item) : content.kpis; return { position, type: block.type, content: { ...content, mediaItems: Array.isArray(content.mediaItems) ? [] : content.mediaItems, kpis } as Prisma.InputJsonValue }; }) } }, include: { blocks: { orderBy: { position: "asc" } } } });
      return NextResponse.json({ report }, { status: 201 });
    }
    if (template === "standard") {
      try { await syncClientInstagramPosts(clientId); } catch {}
    }
    const populatedBlocks = template === "standard" ? await buildStandardReportBlocks(clientId, periodStart, periodEnd) : [];
    const report = await db.report.create({
      data: {
        clientId,
        createdById,
        title: requiredText(body.title, "title"),
        periodStart,
        periodEnd,
        status: draft.status,
        isBlank: draft.isBlank,
        blocks: { create: template === "standard" ? populatedBlocks.map((block, position) => ({ position, type: block.type, content: { ...block.content, title: block.title } as Prisma.InputJsonValue })) : draft.blocks.map((block, position) => ({ position, type: toDatabaseBlockType(block.type), content: { ...block.content, title: block.title } as Prisma.InputJsonValue })) },
      },
      include: { blocks: { orderBy: { position: "asc" } } },
    });
    return NextResponse.json({ report }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid request." }, { status: 400 });
  }
}

export async function PATCH(request: NextRequest) {
  const actor = await workspaceUser(request);
  const internalAccess = hasInternalApiAccess(request);
  if (!internalAccess && !actor) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const body = await request.json() as Record<string, unknown>;
    const reportId = requiredText(body.id, "id", 64);
    const existing = await db.report.findUnique({ where: { id: reportId }, select: { createdById: true, status: true } });
    if (!existing) return NextResponse.json({ error: "Report not found." }, { status: 404 });
    if (!internalAccess && existing.createdById !== actor?.id) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    if (existing.status === "APPROVED") return NextResponse.json({ error: "Approved reports are frozen. Duplicate the report to make changes." }, { status: 409 });

    const blocks = editableBlocks(body.blocks);
    const title = requiredText(body.title, "title");
    const report = await db.report.update({
      where: { id: reportId },
      data: {
        title,
        isBlank: body.isBlank === true,
        status: body.status === "APPROVED" ? "APPROVED" : undefined,
        blocks: {
          deleteMany: {},
          create: blocks.map((block, position) => ({ position, type: toDatabaseBlockType(block.type), content: { ...block.content, title: block.title } as Prisma.InputJsonValue })),
        },
      },
      include: { blocks: { orderBy: { position: "asc" } } },
    });
    return NextResponse.json({ report });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid request." }, { status: 400 });
  }
}
