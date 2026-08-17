import { BlockType, Prisma, Role } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { hasInternalApiAccess } from "@/lib/internal-api";
import { hasFeature, requireFeature } from "@/lib/access";
import { createReportDraft, ReportBlockType } from "@/lib/report-template";
import { refreshReportData } from "@/lib/report-refresh";
import { enqueueClientSync } from "@/lib/sync-queue";
import { getCoverage } from "@/lib/report-coverage";
import { buildStandardReportBlocksPreferStoredPeriodSnapshots } from "@/lib/stored-period-metrics";

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

async function readiness(reportId: string, blocks: EditableBlock[]) {
  const report = await db.report.findUnique({ where: { id: reportId }, select: { clientId: true, periodStart: true, periodEnd: true } });
  if (!report) return ["Report not found."];
  const issues: string[] = [];
  const media = blocks.filter((block) => block.type === "media");
  if (media.some((block) => !Array.isArray(block.content.mediaItems) || block.content.mediaItems.length === 0)) issues.push("One or more required media sections are empty.");
  if (blocks.some((block) => Array.isArray(block.content.kpis) && block.content.kpis.some((item) => typeof item === "object" && item && ((item as Record<string, unknown>).available === false || (item as Record<string, unknown>).value === "غير متاح")))) issues.push("One or more critical metrics are unavailable.");
  const recommendations = blocks.find((block) => block.type === "notes" || block.type === "recommendations");
  if (!recommendations || typeof recommendations.content.body !== "string" || !recommendations.content.body.trim()) issues.push("Recommendations are missing.");
  const connection = await db.socialConnection.findFirst({ where: { clientId: report.clientId, platform: "INSTAGRAM" }, select: { id: true, lastSuccessfulSyncAt: true } });
  if (!connection?.lastSuccessfulSyncAt || Date.now() - connection.lastSuccessfulSyncAt.valueOf() > 24 * 60 * 60 * 1000) issues.push("Client data has not been synchronized in the last 24 hours.");
  if (connection) {
    const coverage = await getCoverage(connection.id, report.periodStart, report.periodEnd);
    if (coverage.status !== "COMPLETE") issues.push(...coverage.warnings.slice(0, 3));
  }
  return issues;
}

export async function GET(request: NextRequest) {
  if (!hasInternalApiAccess(request) && !(await requireFeature(request, "view_reports"))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const clientId = request.nextUrl.searchParams.get("clientId");
  const reports = await db.report.findMany({ where: clientId ? { clientId } : undefined, include: { client: { select: { name: true } }, blocks: { orderBy: { position: "asc" } } }, orderBy: { updatedAt: "desc" }, take: 100 });
  return NextResponse.json({ reports });
}

export async function POST(request: NextRequest) {
  const actor = await requireFeature(request, "create_report");
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
      const report = await db.report.create({ data: { clientId, createdById, title: requiredText(body.title, "title"), periodStart, periodEnd, status: "DRAFT", isBlank: source.isBlank, blocks: { create: source.blocks.map((block, position) => { const content = block.content as Record<string, unknown>; const kpis = Array.isArray(content.kpis) ? content.kpis.map((item) => typeof item === "object" && item ? { ...(item as Record<string, unknown>), value: "0" } : item) : content.kpis; return { position, type: block.type, content: { ...content, mediaItems: Array.isArray(content.mediaItems) ? [] : content.mediaItems, kpis } as Prisma.InputJsonValue }; }) } }, include: { blocks: { orderBy: { position: "asc" } } } });
      return NextResponse.json({ report }, { status: 201 });
    }
    const hasSyncedPosts = template === "standard" && (await db.socialPost.count({ where: { connection: { clientId } } })) > 0;
    const syncQueued = template === "standard" && !hasSyncedPosts ? await enqueueClientSync(clientId) : [];
    // Reuse authoritative account-period snapshots whenever they already exist. Only a recent missing
    // period falls back to Meta during initial creation; later refresh/export stays database-only.
    const populatedBlocks = template === "standard"
      ? await buildStandardReportBlocksPreferStoredPeriodSnapshots(clientId, periodStart, periodEnd)
      : [];
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
    if (template === "standard") {
      await refreshReportData(report.id);
    }
    const refreshedReport = await db.report.findUnique({
      where: { id: report.id },
      include: { blocks: { orderBy: { position: "asc" } } },
    });
    return NextResponse.json({ report: refreshedReport ?? report, syncQueued: syncQueued.length > 0 }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid request." }, { status: 400 });
  }
}

export async function PATCH(request: NextRequest) {
  const actor = await requireFeature(request, "edit_report");
  const internalAccess = hasInternalApiAccess(request);
  if (!internalAccess && !actor) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const body = await request.json() as Record<string, unknown>;
    const reportId = requiredText(body.id, "id", 64);
    const existing = await db.report.findUnique({ where: { id: reportId }, select: { status: true } });
    if (!existing) return NextResponse.json({ error: "Report not found." }, { status: 404 });
    if (existing.status === "APPROVED") return NextResponse.json({ error: "Approved reports are frozen. Duplicate the report to make changes." }, { status: 409 });

    const blocks = editableBlocks(body.blocks);
    const title = requiredText(body.title, "title");
    const orientation = body.orientation === "portrait" ? "portrait" : body.orientation === "landscape" ? "landscape" : undefined;
    const userRole = actor?.role ?? Role.ADMIN;
    const approving = body.status === "APPROVED";
    if (approving && !hasFeature(userRole, "approve_report")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    const overrideReason = typeof body.overrideReason === "string" ? body.overrideReason.trim() : "";
    const issues = approving ? await readiness(reportId, blocks) : [];
    if (approving && issues.length && !overrideReason) return NextResponse.json({ error: "Report is not ready for approval.", readiness: { ready: false, issues } }, { status: 409 });
    const report = await db.report.update({
      where: { id: reportId },
      data: {
        title,
        isBlank: body.isBlank === true,
        orientation,
        approvalOverrideReason: approving && overrideReason ? overrideReason : undefined,
        status: approving ? "APPROVED" : undefined,
        blocks: {
          deleteMany: {},
          create: blocks.map((block, position) => ({ position, type: toDatabaseBlockType(block.type), content: { ...block.content, title: block.title } as Prisma.InputJsonValue })),
        },
      },
      include: { blocks: { orderBy: { position: "asc" } } },
    });
    if (approving) {
      const count = await db.reportVersion.count({ where: { reportId } });
      await db.reportVersion.create({ data: { reportId, number: count + 1, snapshot: { title: report.title, orientation: report.orientation, blocks: report.blocks } as Prisma.InputJsonValue } });
    }
    return NextResponse.json({ report, readiness: { ready: issues.length === 0, issues } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid request." }, { status: 400 });
  }
}

export async function DELETE(request: NextRequest) {
  const actor = await requireFeature(request, "edit_report");
  const internalAccess = hasInternalApiAccess(request);
  if (!internalAccess && !actor) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const reportId = request.nextUrl.searchParams.get("id");
  if (!reportId) return NextResponse.json({ error: "id is required." }, { status: 400 });
  if (request.nextUrl.searchParams.get("confirm") !== "true") return NextResponse.json({ error: "Permanent deletion must be confirmed." }, { status: 400 });
  const existing = await db.report.findUnique({ where: { id: reportId }, select: { status: true } });
  if (!existing) return NextResponse.json({ error: "Report not found." }, { status: 404 });
  if (existing.status === "APPROVED" || existing.status === "EXPORTED") return NextResponse.json({ error: "Approved or exported reports are frozen and cannot be deleted." }, { status: 409 });
  await db.report.delete({ where: { id: reportId } });
  return NextResponse.json({ ok: true });
}
