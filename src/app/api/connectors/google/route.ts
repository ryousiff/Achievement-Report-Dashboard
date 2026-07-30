import { NextRequest, NextResponse } from "next/server";
import { requireFeature } from "@/lib/access";
import { createGoogleAuthorizationUrl } from "@/lib/google";

export async function GET(request: NextRequest) {
  const user = await requireFeature(request, "export_report");
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const url = createGoogleAuthorizationUrl(user.id);
    return NextResponse.redirect(url);
  } catch {
    return NextResponse.json({ error: "Google OAuth is not configured." }, { status: 503 });
  }
}
