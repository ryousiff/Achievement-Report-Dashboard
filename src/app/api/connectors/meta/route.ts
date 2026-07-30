import { NextRequest, NextResponse } from "next/server";
import { metaConnector } from "@/lib/connectors";
import { ConnectorError } from "@/lib/connectors";
import { requireFeature } from "@/lib/access";

export async function GET(request: NextRequest) {
  const user = await requireFeature(request, "connect_meta");
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    return NextResponse.redirect(metaConnector.createAuthorizationUrl(user.id));
  } catch (error) {
    const status = error instanceof ConnectorError && error.code === "not_configured" ? 503 : 500;
    return NextResponse.json({ error: error instanceof Error ? error.message : "Meta OAuth error." }, { status });
  }
}
