import { NextRequest, NextResponse } from "next/server";
import { requireFeature } from "@/lib/access";
import { ConnectorError, getConnector } from "@/lib/connectors";

function requiredFeatureForPlatform(platform: string) {
  if (platform === "meta") return "connect_meta";
  if (platform === "google") return "export_report";
  return "manage_settings";
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ platform: string }> }) {
  const { platform } = await params;
  const user = await requireFeature(request, requiredFeatureForPlatform(platform));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const connector = getConnector(platform);
  if (!connector) return NextResponse.json({ error: "Unsupported platform." }, { status: 400 });

  try {
    return NextResponse.redirect(connector.createAuthorizationUrl(user.id));
  } catch (error) {
    const status = error instanceof ConnectorError && error.code === "not_configured" ? 503 : error instanceof ConnectorError && error.code === "not_implemented" ? 501 : 500;
    return NextResponse.json({ error: error instanceof Error ? error.message : "Connector error." }, { status });
  }
}
