import { Platform } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireFeature } from "@/lib/access";
import { decryptToken } from "@/lib/token-encryption";

export async function POST(request: NextRequest, { params }: { params: Promise<{ clientId: string }> }) {
  const user = await requireFeature(request, "manage_clients");
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { clientId } = await params;
  const { action } = await request.json() as { action?: unknown };
  if (action !== "meta-logo") return NextResponse.json({ error: "Unsupported client action." }, { status: 400 });
  const connection = await db.socialConnection.findFirst({ where: { clientId, platform: Platform.INSTAGRAM, sourceAccount: { profile: { createdById: user.id } } }, select: { externalAccountId: true, encryptedToken: true } });
  if (!connection) return NextResponse.json({ error: "Assign an Instagram account to this client first." }, { status: 404 });
  try {
    const url = new URL(`https://graph.facebook.com/v23.0/${connection.externalAccountId}`);
    url.searchParams.set("fields", "profile_picture_url");
    url.searchParams.set("access_token", decryptToken(connection.encryptedToken));
    const response = await fetch(url, { cache: "no-store" });
    const data = await response.json() as { profile_picture_url?: unknown };
    if (!response.ok || typeof data.profile_picture_url !== "string" || !data.profile_picture_url.startsWith("https://")) return NextResponse.json({ error: "Meta did not return a usable Instagram profile image." }, { status: 422 });
    const client = await db.client.update({ where: { id: clientId }, data: { logoUrl: data.profile_picture_url }, select: { id: true, name: true, logoUrl: true } });
    return NextResponse.json({ client });
  } catch {
    return NextResponse.json({ error: "Unable to retrieve the Instagram profile image from Meta." }, { status: 502 });
  }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ clientId: string }> }) {
  const user = await requireFeature(request, "manage_clients");
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { clientId } = await params;
  const { active, logoUrl } = await request.json() as { active?: unknown; logoUrl?: unknown };
  if (typeof active !== "boolean" && logoUrl !== null && typeof logoUrl !== "string") return NextResponse.json({ error: "Provide a valid client update." }, { status: 400 });
  const data = typeof active === "boolean" ? { active } : { logoUrl: typeof logoUrl === "string" && logoUrl.trim() ? logoUrl.trim() : null };
  const client = await db.client.update({ where: { id: clientId }, data, select: { id: true, name: true, logoUrl: true, active: true } }).catch(() => null);
  if (!client) return NextResponse.json({ error: "Client not found." }, { status: 404 });
  return NextResponse.json({ client });
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ clientId: string }> }) {
  const user = await requireFeature(request, "manage_clients");
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (request.nextUrl.searchParams.get("confirm") !== "true") return NextResponse.json({ error: "Permanent deletion must be confirmed." }, { status: 400 });
  const { clientId } = await params;
  const client = await db.client.findUnique({ where: { id: clientId }, select: { id: true, active: true } });
  if (!client) return NextResponse.json({ error: "Client not found." }, { status: 404 });
  if (client.active) return NextResponse.json({ error: "Archive the client before permanently deleting it." }, { status: 409 });
  await db.client.delete({ where: { id: clientId } });
  return NextResponse.json({ ok: true });
}
