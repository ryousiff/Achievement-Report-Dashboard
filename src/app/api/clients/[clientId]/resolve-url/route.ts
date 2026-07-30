import { NextRequest, NextResponse } from "next/server";
import { Platform } from "@prisma/client";
import { db } from "@/lib/db";
import { requireFeature } from "@/lib/access";
import { resolveInstagramUrl } from "@/lib/instagram-url";

export async function POST(request: NextRequest, { params }: { params: Promise<{ clientId: string }> }) {
  const user = await requireFeature(request, "edit_report");
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { clientId } = await params;
  const { url } = await request.json() as { url?: string };
  if (!url || typeof url !== "string") return NextResponse.json({ error: "URL is required." }, { status: 400 });
  try {
    const { resolve } = await resolveInstagramUrl(clientId, async () => {
      const connection = await db.socialConnection.findFirst({ where: { clientId, platform: Platform.INSTAGRAM }, select: { id: true, externalAccountId: true, encryptedToken: true } });
      return connection;
    });
    const post = await resolve(url);
    return NextResponse.json({ post });
  } catch (error) {
    console.error("RESOLVE INSTAGRAM URL ERROR:", error instanceof Error ? { message: error.message } : error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to fetch this Instagram post. You can upload the image manually instead." }, { status: 502 });
  }
}
