import { Role } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { roleFeatures } from "@/lib/access";

export async function GET(request: NextRequest) {
  const user = await getSessionUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const features = roleFeatures[user.role as Role] ?? [];
  return NextResponse.json({ user: { ...user, features, googleConnected: "googleRefreshToken" in user && Boolean(user.googleRefreshToken) } });
}
