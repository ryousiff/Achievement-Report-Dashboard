import { NextRequest, NextResponse } from "next/server";
import { metaConnector } from "@/lib/connectors";
import { requireFeature } from "@/lib/access";

function redirectToWorkspace(result: "connected" | "error") {
  const dashboardUrl = process.env.NEXTAUTH_URL || "https://slideshow-bluish-coveting.ngrok-free.dev";
  const url = new URL("/", dashboardUrl);
  url.searchParams.set("meta", result);
  return NextResponse.redirect(url);
}

export async function GET(request: NextRequest) {
  const error = request.nextUrl.searchParams.get("error");
  const state = request.nextUrl.searchParams.get("state");
  const code = request.nextUrl.searchParams.get("code");
  if (error || !state || !code) return redirectToWorkspace("error");

  try {
    const sessionUser = await requireFeature(request, "connect_meta");
    if (!sessionUser) return redirectToWorkspace("error");
    await metaConnector.handleCallback(code, state, sessionUser.id);
    return redirectToWorkspace("connected");
  } catch (error) {
    console.error("META CALLBACK ERROR:", error instanceof Error ? { message: error.message, stack: error.stack } : error);
    return redirectToWorkspace("error");
  }
}
