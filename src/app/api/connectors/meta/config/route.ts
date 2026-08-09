import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/access";

// Exposes read-only configuration flags so the client UI can decide which Meta connection
// entry points to show. The Login-for-Business / OAuth flow is only useful when an external
// client Business Portfolio config_id is configured; Kaan's own assets must use the system-user token flow.
export async function GET(request: NextRequest) {
  const user = await requireAuth(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json({
    loginConfigIdConfigured: Boolean(process.env.META_LOGIN_CONFIG_ID),
    businessIdConfigured: Boolean(process.env.META_BUSINESS_ID),
  });
}
