import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { ConnectorError, getConnector } from "@/lib/connectors";

export async function GET(request: NextRequest, { params }: { params: Promise<{ platform: string }> }) {
  const user = await getSessionUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { platform } = await params;
  const connector = getConnector(platform);
  if (!connector) return NextResponse.json({ error: "Unsupported platform." }, { status: 400 });

  try {
    return NextResponse.redirect(connector.createAuthorizationUrl(user.id));
  } catch (error) {
    const status = error instanceof ConnectorError && error.code === "not_configured" ? 503 : error instanceof ConnectorError && error.code === "not_implemented" ? 501 : 500;
    return NextResponse.json({ error: error instanceof Error ? error.message : "Connector error." }, { status });
  }
}
