import { NextRequest, NextResponse } from "next/server";
import { requireFeature } from "@/lib/access";
import { exchangeGoogleCode, saveGoogleToken } from "@/lib/google";

function redirect(result: "connected" | "error") {
  const base = process.env.NEXTAUTH_URL || "http://localhost:3000";
  return NextResponse.redirect(new URL(`/?google=${result}`, base).toString());
}

export async function GET(request: NextRequest) {
  const user = await requireFeature(request, "export_report");
  if (!user) return redirect("error");
  const code = request.nextUrl.searchParams.get("code");
  const error = request.nextUrl.searchParams.get("error");
  if (error || !code) return redirect("error");
  try {
    const tokens = await exchangeGoogleCode(code);
    await saveGoogleToken(user.id, tokens.refreshToken, tokens.expiresAt);
    return redirect("connected");
  } catch (callbackError) {
    console.error("GOOGLE CALLBACK ERROR:", callbackError instanceof Error ? callbackError.message : callbackError);
    return redirect("error");
  }
}
