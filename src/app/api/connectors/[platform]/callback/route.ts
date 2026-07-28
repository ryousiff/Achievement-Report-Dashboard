import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { getConnector } from "@/lib/connectors";

function redirectToDashboard(platform: string, result: "connected" | "error") {
  const dashboardUrl = process.env.NEXTAUTH_URL || "https://slideshow-bluish-coveting.ngrok-free.dev";
  const url = new URL("/", dashboardUrl);
  url.searchParams.set(platform, result);
  return NextResponse.redirect(url);
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ platform: string }> }) {
  const { platform } = await params;
  const connector = getConnector(platform);
  if (!connector) return NextResponse.json({ error: "Unsupported platform." }, { status: 400 });

  const error = request.nextUrl.searchParams.get("error");
  const state = request.nextUrl.searchParams.get("state");
  const code = request.nextUrl.searchParams.get("code");
  if (error || !state || !code) return redirectToDashboard(platform, "error");

  try {
    const user = await getSessionUser(request);
    if (!user) return redirectToDashboard(platform, "error");
    await connector.handleCallback(code, state, user.id);
    return redirectToDashboard(platform, "connected");
  } catch (callbackError) {
    console.error(`${platform.toUpperCase()} CALLBACK ERROR:`, callbackError instanceof Error ? { message: callbackError.message, stack: callbackError.stack } : callbackError);
    return redirectToDashboard(platform, "error");
  }
}
