import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { hasInternalApiAccess } from "@/lib/internal-api";
import { getSessionUser } from "@/lib/session";
import { requiredText } from "@/lib/validators";

async function hasWorkspaceAccess(request: NextRequest) {
  return hasInternalApiAccess(request) || Boolean(await getSessionUser(request));
}

export async function GET(request: NextRequest) {
  if (!(await hasWorkspaceAccess(request))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const clients = await db.client.findMany({ where: { active: true }, include: { connections: { select: { platform: true, displayName: true, lastSyncedAt: true } }, _count: { select: { reports: true } } }, orderBy: { name: "asc" } });
  return NextResponse.json({ clients });
}

export async function POST(request: NextRequest) {
  if (!(await hasWorkspaceAccess(request))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const { name } = await request.json();
    const client = await db.client.create({ data: { name: requiredText(name, "name") } });
    return NextResponse.json({ client }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid request." }, { status: 400 });
  }
}
