import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/session";

async function authorized(request: NextRequest) {
  return Boolean(await getSessionUser(request));
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ clientId: string }> }) {
  if (!(await authorized(request))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { clientId } = await params;
  const { active } = await request.json() as { active?: unknown };
  if (typeof active !== "boolean") return NextResponse.json({ error: "active must be a boolean." }, { status: 400 });
  const client = await db.client.update({ where: { id: clientId }, data: { active }, select: { id: true, name: true, active: true } }).catch(() => null);
  if (!client) return NextResponse.json({ error: "Client not found." }, { status: 404 });
  return NextResponse.json({ client });
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ clientId: string }> }) {
  if (!(await authorized(request))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (request.nextUrl.searchParams.get("confirm") !== "true") return NextResponse.json({ error: "Permanent deletion must be confirmed." }, { status: 400 });
  const { clientId } = await params;
  const client = await db.client.findUnique({ where: { id: clientId }, select: { id: true, active: true } });
  if (!client) return NextResponse.json({ error: "Client not found." }, { status: 404 });
  if (client.active) return NextResponse.json({ error: "Archive the client before permanently deleting it." }, { status: 409 });
  await db.client.delete({ where: { id: clientId } });
  return NextResponse.json({ ok: true });
}
