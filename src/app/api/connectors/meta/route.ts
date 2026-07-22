import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { createMetaAuthorizationUrl, createMetaState } from "@/lib/meta";
import { getSessionUser } from "@/lib/session";

export async function GET(request: NextRequest) {
  const user = await getSessionUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const clientId = request.nextUrl.searchParams.get("clientId");
  if (!clientId) return NextResponse.json({ error: "clientId is required." }, { status: 400 });
  const client = await db.client.findUnique({ where: { id: clientId }, select: { id: true } });
  if (!client) return NextResponse.json({ error: "Client not found." }, { status: 404 });
  try {
    return NextResponse.redirect(createMetaAuthorizationUrl(createMetaState(client.id, user.id)));
  } catch {
    return NextResponse.json({ error: "Meta OAuth has not been configured." }, { status: 503 });
  }
}
