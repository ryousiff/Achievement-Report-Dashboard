import { NextRequest, NextResponse } from "next/server";
import { createMetaAuthorizationUrl } from "@/lib/meta";

export function GET(request: NextRequest) {
  const state = request.nextUrl.searchParams.get("state");
  if (!state || state.length < 16) return NextResponse.json({ error: "A signed state value is required." }, { status: 400 });

  try {
    return NextResponse.redirect(createMetaAuthorizationUrl(state));
  } catch {
    return NextResponse.json({ error: "Meta OAuth has not been configured." }, { status: 503 });
  }
}
