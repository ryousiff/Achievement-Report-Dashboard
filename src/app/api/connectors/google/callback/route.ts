import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
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
    if (!tokens.refreshToken) {
      // Google can omit refresh_token on some reconnects; only acceptable if we already have one on file
      // (Part 1.5 — never erase/require re-granting a working connection). Otherwise this is a real failure.
      const existing = await db.user.findUnique({ where: { id: user.id }, select: { googleRefreshToken: true } });
      if (!existing?.googleRefreshToken) throw new Error("Google did not grant offline access. Please try connecting again.");
    }
    await saveGoogleToken(user.id, tokens.refreshToken, tokens.expiresAt);
    return redirect("connected");
  } catch (callbackError) {
    console.error("GOOGLE CALLBACK ERROR:", callbackError instanceof Error ? callbackError.message : callbackError);
    return redirect("error");
  }
}
