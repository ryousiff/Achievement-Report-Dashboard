import { NextRequest, NextResponse } from "next/server";
import { createMetaAuthorizationUrl, createMetaState } from "@/lib/meta";
import { getSessionUser } from "@/lib/session";

export async function GET(request: NextRequest) {
  const user = await getSessionUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    return NextResponse.redirect(createMetaAuthorizationUrl(createMetaState(user.id)));
  } catch {
    return NextResponse.json({ error: "Meta OAuth has not been configured." }, { status: 503 });
  }
}
