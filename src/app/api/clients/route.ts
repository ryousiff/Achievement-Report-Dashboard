import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { hasInternalApiAccess } from "@/lib/internal-api";
import { requireFeature } from "@/lib/access";
import { requiredText } from "@/lib/validators";

async function hasWorkspaceAccess(request: NextRequest) {
  return hasInternalApiAccess(request) || Boolean(await requireFeature(request, "view_dashboard"));
}

export async function GET(request: NextRequest) {
  if (!(await hasWorkspaceAccess(request))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const archived = request.nextUrl.searchParams.get("archived") === "true";
  const clients = await db.client.findMany({ where: { active: !archived }, include: { connections: { where: { sourceAccountId: { not: null } }, select: { platform: true, displayName: true, lastSyncedAt: true, lastSuccessfulSyncAt: true, lastFailedSyncAt: true, lastFailureReason: true, tokenExpiresAt: true, sourceAccountId: true, syncJobs: { orderBy: { createdAt: "desc" }, take: 1, select: { status: true, attempts: true, runAfter: true, lastError: true } }, syncRuns: { orderBy: { createdAt: "desc" }, take: 3, select: { status: true, startedAt: true, finishedAt: true, postsSynced: true, durationMs: true, errorMessage: true } } } }, _count: { select: { reports: true } } }, orderBy: { name: "asc" } });
  return NextResponse.json({ clients });
}

export async function POST(request: NextRequest) {
  const user = await requireFeature(request, "manage_clients");
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const { name } = await request.json();
    const client = await db.client.create({ data: { name: requiredText(name, "name") } });
    return NextResponse.json({ client }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid request." }, { status: 400 });
  }
}
