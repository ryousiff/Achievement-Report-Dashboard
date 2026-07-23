import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/session";

export async function GET(request: NextRequest) {
  const user = await getSessionUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const profiles = await db.metaProfile.findMany({
    where: { createdById: user.id },
    include: { accounts: { select: { id: true, platform: true, displayName: true, lastSyncedAt: true, assignments: { select: { clientId: true } } }, orderBy: [{ platform: "asc" }, { displayName: "asc" }] } },
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json({ profiles });
}
