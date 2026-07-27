import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { syncClientInstagramPosts } from "@/lib/meta-sync";
import { getSessionUser } from "@/lib/session";

export async function POST(request: NextRequest, { params }: { params: Promise<{ clientId: string }> }) {
  const user = await getSessionUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { clientId } = await params;
  const client = await db.client.findUnique({ where: { id: clientId }, select: { id: true } });
  if (!client) return NextResponse.json({ error: "Client not found." }, { status: 404 });
  try {
    const result = await syncClientInstagramPosts(client.id);
    return NextResponse.json(result, { status: result.results.some((item) => item.status === "failed") ? 207 : 200 });
  } catch {
    return NextResponse.json({ error: "Unable to synchronize Meta posts. Confirm the account connection and permissions." }, { status: 502 });
  }
}
